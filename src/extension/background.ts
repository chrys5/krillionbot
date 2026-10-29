import { AnswerCache, type KeyValueStore } from '../llm/cache.js';
import { DEFAULT_SETTINGS, createGenerator, validateSettings, type LlmSettings } from '../llm/provider.js';
import { BundledSeed } from '../resolver/bundled-seed.js';
import { AUTO_JOIN_KEY } from './auto-join.js';

const SETTINGS = 'krillionbot:settings:v1';
const CREDENTIAL = 'krillionbot:credential:v1';
const ready = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
]);
const store = (area: chrome.storage.StorageArea): KeyValueStore => ({
  get: async key => (await area.get(key))[key],
  set: async (key, value) => { await area.set({ [key]: value }); },
});
const cache = new AnswerCache(store(chrome.storage.local), store(chrome.storage.session), createGenerator());
const lookups = new Map<string, AbortController>();
const seed = new BundledSeed(async path => {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) throw new Error('Bundled seed database could not be loaded');
  return response.json();
});
const settings = async () => validateSettings((await chrome.storage.local.get(SETTINGS))[SETTINGS] ?? DEFAULT_SETTINGS);
const credential = async (config: LlmSettings) => {
  const key = (await chrome.storage.session.get(CREDENTIAL))[CREDENTIAL];
  return key?.origin === new URL(config.baseUrl).origin && typeof key.apiKey === 'string' ? key.apiKey : '';
};
const validPrompt = (prompt: unknown): prompt is string => typeof prompt === 'string' && !!prompt.trim() && prompt.length <= 1000;
const excludedAnswers = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((s): s is string => typeof s === 'string' && s.length <= 300).slice(0, 300) : [];

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (!message || typeof message !== 'object' || !('type' in message) || sender.id !== chrome.runtime.id) return;
  const request = message as Record<string, unknown>;
  const isPopup = !sender.tab && sender.url === chrome.runtime.getURL('popup.html');
  const isGame = !!sender.tab?.url && new URL(sender.tab.url).origin === 'https://krillion.io';
  if (!isPopup && !isGame) return;
  const requestKey = isGame && typeof request.requestId === 'string' && request.requestId.length <= 100
    ? `${sender.tab!.id}:${request.requestId}` : null;
  if (request.type === 'KRILLIONBOT_CANCEL_RESOLVE' && requestKey) {
    lookups.get(requestKey)?.abort(); respond({ cancelled: true }); return;
  }
  const lookupAbort = request.type === 'KRILLIONBOT_RESOLVE' && requestKey ? new AbortController() : null;
  if (lookupAbort && requestKey) lookups.set(requestKey, lookupAbort);
  const run = async () => {
    await ready;
    if (request.type === 'KRILLIONBOT_AUTO_JOIN_CONFIG') {
      return { enabled: (await chrome.storage.local.get(AUTO_JOIN_KEY))[AUTO_JOIN_KEY] === true };
    }
    if (request.type === 'KRILLIONBOT_SAVE_AUTO_JOIN' && isPopup && typeof request.enabled === 'boolean') {
      await chrome.storage.local.set({ [AUTO_JOIN_KEY]: request.enabled });
      return { saved: true, enabled: request.enabled };
    }
    if (lookupAbort?.signal.aborted) throw new Error('Lookup cancelled');
    if (request.type === 'KRILLIONBOT_SEED' && isGame) {
      // Only the small index crosses the message channel; question files load on demand.
      return { promptKeys: await seed.promptKeys() };
    }
    if (request.type === 'KRILLIONBOT_CONFIG' && isPopup) {
      const config = await settings();
      return { settings: config, hasKey: !!await credential(config), metrics: await cache.metrics() };
    }
    if (request.type === 'KRILLIONBOT_SAVE_CONFIG' && isPopup) {
      const config = validateSettings(request.settings);
      const origin = new URL(config.baseUrl).origin;
      if (!await chrome.permissions.contains({ origins: [`${origin}/*`] })) throw new Error('Grant access to the API host first.');
      if (typeof request.apiKey === 'string' && request.apiKey.trim()) {
        if (request.apiKey.length > 1000 || /[\r\n]/u.test(request.apiKey)) throw new Error('Invalid API key');
        await chrome.storage.session.set({ [CREDENTIAL]: { origin, apiKey: request.apiKey.trim() } });
      }
      await chrome.storage.local.set({ [SETTINGS]: config });
      cache.resetFailures();
      return { saved: true, hasKey: !!await credential(config) };
    }
    if (request.type === 'KRILLIONBOT_FORGET_KEY' && isPopup) {
      await chrome.storage.session.remove(CREDENTIAL); cache.resetFailures(); return { forgotten: true };
    }
    if (request.type === 'KRILLIONBOT_CLEAR_CACHE' && isPopup) {
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter(key => key.startsWith('krillionbot:generated:')));
      return { cleared: true };
    }
    if (request.type === 'KRILLIONBOT_RECORD' && isGame && validPrompt(request.prompt) &&
        typeof request.answer === 'string' && request.answer.length <= 60 &&
        (request.result === 'accepted' || request.result === 'invalid')) {
      await cache.record(request.prompt, request.answer, request.result); return { saved: true };
    }
    if ((request.type === 'KRILLIONBOT_RESOLVE' && isGame || request.type === 'KRILLIONBOT_TEST_LLM' && isPopup) &&
        validPrompt(request.prompt)) {
      const candidates = await seed.lookup(request.prompt, { used: excludedAnswers(request.excluded), maxLength: 60 });
      if (lookupAbort?.signal.aborted) throw new Error('Lookup cancelled');
      if (candidates.length) return { candidates, message: 'Seed candidates available; no provider request needed.',
        networkUsed: false, ...await cache.metrics() };
      const config = await settings();
      return cache.resolve(request.prompt, excludedAnswers(request.excluded), config, await credential(config), request.allowNetwork !== false, {
        ...(lookupAbort ? { signal: lookupAbort.signal } : {}),
        onProgress: progress => {
          if (sender.tab?.id !== undefined && request.requestId) {
            void chrome.tabs.sendMessage(sender.tab.id, { type: 'KRILLIONBOT_LLM_PROGRESS', requestId: request.requestId, progress },
              { frameId: sender.frameId ?? 0 }).catch(() => {});
          }
        },
      });
    }
    throw new Error('Unsupported extension request');
  };
  run().then(respond, error => respond({ error: error instanceof Error ? error.message : 'Extension request failed' }))
    .finally(() => { if (requestKey && lookups.get(requestKey) === lookupAbort) lookups.delete(requestKey); });
  return true;
});
