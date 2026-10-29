import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { DEFAULT_SETTINGS } from '../src/llm/provider.js';

test('background adapter persists batches across restart, keeps keys private, and learns acceptance', async () => {
  const bundle = await build({ entryPoints: ['src/extension/background.ts'], write: false, bundle: true, platform: 'browser' });
  const localData = new Map<string, unknown>(), sessionData = new Map<string, unknown>();
  const storage = (data: Map<string, unknown>) => ({
    get: async (key: string | null) => structuredClone(key === null ? Object.fromEntries(data) : { [key]: data.get(key) }),
    set: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value)); },
    remove: async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) data.delete(key); },
    setAccessLevel: async () => {},
  });
  let calls = 0;
  let holdResponse = false;
  let pendingSignal: AbortSignal | undefined;
  const progressMessages: any[] = [];
  const seedReads: string[] = [];
  const startWorker = () => {
    let handler!: (message: unknown, sender: any, respond: (value: any) => void) => boolean | undefined;
    runInNewContext(bundle.outputFiles[0]!.text, {
      chrome: {
        runtime: { id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`,
          onMessage: { addListener: (fn: typeof handler) => { handler = fn; } } },
        storage: { local: storage(localData), session: storage(sessionData) },
        permissions: { contains: async () => true },
        tabs: { sendMessage: async (_tab: number, message: any) => { progressMessages.push(message); } },
      },
      URL, AbortController, setTimeout, clearTimeout, console,
      fetch: async (url: string, init: RequestInit) => {
        if (url.startsWith('chrome-extension://test-extension/')) seedReads.push(url);
        if (url === 'chrome-extension://test-extension/seed/index.json') return new Response(JSON.stringify({
          schemaVersion: 1, prompts: { 'name a shared seed answer': `seed/prompts/${'a'.repeat(64)}.json` },
        }));
        if (url === `chrome-extension://test-extension/seed/prompts/${'a'.repeat(64)}.json`) return new Response(JSON.stringify({
          schemaVersion: 1, source: 'fixture', days: {}, collections: { fixture: {
            kind: 'shared-file', importedAt: '2026-10-29T00:00:00Z', sourceFile: 'friend.json',
            prompts: [{ text: 'Name a shared seed answer', key: 'name a shared seed answer', answers: [
              { text: 'Coffee', score: 100, tier: 'krillion', aliases: ['Café'] },
              { text: 'Tea', score: 85, tier: 'deepcut', aliases: [] },
            ] }],
          } },
        }));
        calls++; assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.match(String((init.headers as Record<string, string>).Authorization), /mock-secret/);
        if (holdResponse) {
          pendingSignal = init.signal!;
          return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('cancelled'))));
        }
        return new Response(JSON.stringify({ status: 'completed', output: [
          { type: 'message', content: [{ type: 'output_text', text: '{"candidates":["Gin","Rum","Vodka"]}' }] },
        ] }));
      },
    });
    const game = { id: 'test-extension', tab: { id: 7, url: 'https://krillion.io/party/TEST' } };
    const popup = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
    const send = (message: unknown, sender = game) => new Promise<any>((resolve, reject) => {
      if (handler(message, sender, resolve) !== true) reject(new Error('Message rejected'));
    });
    return { send, game, popup, handler };
  };
  const worker = startWorker();
  const seedIndex = await worker.send({ type: 'KRILLIONBOT_SEED' });
  assert.deepEqual(Array.from(seedIndex.promptKeys), ['name a shared seed answer']);
  assert.equal(seedIndex.database, undefined, 'Full source bank is never sent across the extension message channel');
  assert.equal(seedReads.length, 1, 'Startup reads only the index');
  const seedResult = await worker.send({ type: 'KRILLIONBOT_RESOLVE', prompt: 'Name a shared seed answer', excluded: ['Café'] });
  assert.equal(seedResult.candidates[0].text, 'Tea'); assert.equal(seedResult.networkUsed, false); assert.equal(calls, 0);
  assert.equal(seedReads.length, 2, 'Only the matching question is loaded');
  await worker.send({ type: 'KRILLIONBOT_RESOLVE', prompt: 'Name a shared seed answer', excluded: [] });
  assert.equal(seedReads.length, 2, 'Repeated question lookups reuse the local cache');
  await worker.send({ type: 'KRILLIONBOT_SAVE_CONFIG', settings: { ...DEFAULT_SETTINGS, enabled: true, model: 'mock-model' }, apiKey: 'mock-secret' }, worker.popup as any);
  const prompt = 'Name a distilled spirit or liqueur';
  const first = await worker.send({ type: 'KRILLIONBOT_RESOLVE', prompt, excluded: [] });
  assert.equal(first.candidates[0].source, 'llm'); assert.equal(calls, 1);
  assert.equal(seedReads.length, 2, 'Unknown prompts do not fetch question files');
  assert.ok(!JSON.stringify(Object.fromEntries(localData)).includes('mock-secret'));
  const config = await worker.send({ type: 'KRILLIONBOT_CONFIG' }, worker.popup as any);
  assert.equal(config.hasKey, true); assert.ok(!JSON.stringify(config).includes('mock-secret'));
  // A browser restart loses the session key but retains local cache and settings.
  sessionData.clear();
  const restarted = startWorker();
  const cached = await restarted.send({ type: 'KRILLIONBOT_RESOLVE', prompt, excluded: ['Gin'] });
  assert.equal(cached.candidates[0].source, 'cache'); assert.equal(calls, 1);
  assert.deepEqual(Array.from(cached.candidates, (a: any) => a.text), ['Rum', 'Vodka']);
  await restarted.send({ type: 'KRILLIONBOT_RECORD', prompt, answer: 'Rum', result: 'accepted' });
  const learned = await restarted.send({ type: 'KRILLIONBOT_RESOLVE', prompt, excluded: [] });
  assert.equal(learned.candidates[0].source, 'history'); assert.equal(calls, 1);
  const malicious = { id: 'test-extension', tab: { url: 'https://example.com/' } };
  assert.equal(restarted.handler({ type: 'KRILLIONBOT_RESOLVE', prompt }, malicious, () => assert.fail('untrusted sender')), undefined);
  assert.ok(progressMessages.some(message => message.type === 'KRILLIONBOT_LLM_PROGRESS') === false,
    'Progress is only sent for correlated request IDs');
  await restarted.send({ type: 'KRILLIONBOT_SAVE_CONFIG', settings: { ...DEFAULT_SETTINGS, enabled: true, model: 'mock-model' }, apiKey: 'mock-secret' }, restarted.popup as any);
  holdResponse = true;
  const pending = restarted.send({ type: 'KRILLIONBOT_RESOLVE', prompt: 'Unseeded cancellation test', excluded: [], requestId: 'cancel-me' });
  for (let i = 0; i < 100 && !pendingSignal; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(pendingSignal);
  assert.ok(progressMessages.some(message => message.requestId === 'cancel-me'));
  await restarted.send({ type: 'KRILLIONBOT_CANCEL_RESOLVE', requestId: 'cancel-me' });
  const cancelled = await pending;
  assert.equal(cancelled.diagnostics.failure.kind, 'cancelled');
  assert.equal(pendingSignal.aborted, true);
});
