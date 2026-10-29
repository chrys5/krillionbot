import { normalize } from '../data/normalize.js';
import { BotController, type BotStatus } from './controller.js';
import { cleanState, type Observation } from './protocol.js';
import type { FallbackResult } from '../llm/cache.js';
import { backgroundRequest } from './messaging.js';
import { AUTO_JOIN_KEY, AutoJoin } from './auto-join.js';
import { makeDraggablePanel } from './draggable-panel.js';

const CHANNEL = 'krillionbot:party:v1';
let bot: BotController | null = null;
let latest: Observation | null = null;
let load: Promise<Set<string>> | null = null;
let generation = 0;
let lookupSequence = 0;
let autoJoinEnabled = false;
let autoJoinPaused = false;
let resumeAnswers = false;
let resumeAfterDisconnect = false;
let autoJoinRevision = 0;
let current: BotStatus = { enabled: false, message: 'Off', prompt: '', lastAnswer: '', submissions: 0 };
const panel = document.createElement('div');
panel.id = 'krillionbot-controls';
const shadow = panel.attachShadow({ mode: 'open' });
shadow.innerHTML = `<style>:host{position:fixed;right:12px;top:70px;z-index:2147483647;font:13px system-ui}section{box-sizing:border-box;width:276px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;border:1px solid #3f6c8b;border-radius:8px;background:#102338;color:#e9f5ff;padding:12px;box-shadow:0 3px 16px #0006}p{line-height:1.4;margin:8px 0;overflow-wrap:anywhere}button{font:inherit;margin-right:6px;padding:5px 10px;cursor:pointer}#move-panel{display:block;width:100%;margin:0;padding:0 0 8px;border:0;border-bottom:1px solid #3f6c8b;background:transparent;color:inherit;text-align:left;font-weight:bold;cursor:grab;touch-action:none;user-select:none}small{color:#b4c8da}</style><section><button id="move-panel" aria-label="Move Krillion Bot panel" title="Drag to move, or focus and use arrow keys">⠿ Krillion Bot · local MVP</button><p role="status">Off</p><button id="enable">Enable</button><button id="stop">Stop</button><p><small id="detail">Seed database only</small></p></section>`;
const render = (status: BotStatus) => {
  current = status;
  shadow.querySelector('p')!.textContent = status.message;
  shadow.querySelector('#detail')!.textContent = `${status.lastAnswer ? `Last: ${status.lastAnswer} · ` : ''}` +
    `${status.eligible ?? 0} queued · ${status.source ?? 'local lookup'} · ${status.llmRequests ?? 0} LLM calls · ${status.cacheHits ?? 0} cache hits`;
};
const autoJoinLabel = document.createElement('p');
autoJoinLabel.textContent = 'Auto-join off.';
shadow.querySelector('section')!.append(autoJoinLabel);
const autoJoin = new AutoJoin(document, message => { autoJoinLabel.textContent = message; });
const configureAutoJoin = (enabled: boolean) => {
  autoJoinRevision++;
  autoJoinEnabled = enabled; autoJoinPaused = false;
  autoJoin.setEnabled(enabled);
};
void backgroundRequest({ type: 'KRILLIONBOT_AUTO_JOIN_CONFIG' }).then(result => {
  if (autoJoinRevision === 0 && typeof result.enabled === 'boolean') {
    autoJoinEnabled = result.enabled;
    if (!autoJoinPaused) autoJoin.setEnabled(result.enabled);
  }
}).catch(() => { autoJoinLabel.textContent = 'Could not load auto-join. Reopen the popup and refresh Krillion.'; });
const storageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
  if (area === 'local' && AUTO_JOIN_KEY in changes) configureAutoJoin(changes[AUTO_JOIN_KEY]!.newValue === true);
};
chrome.storage?.onChanged?.addListener(storageChanged);
const joinTimer = setInterval(() => { autoJoin.tick(); }, 500);
const isParty = () => /^\/party(?:\/|$)/.test(location.pathname) || location.pathname.startsWith('/krillionbot-test/');
const mount = () => {
  if (isParty()) { if (!panel.isConnected) document.documentElement.append(panel); }
  else { panel.remove(); bot?.stop('Off: left Party'); }
};

async function enable() {
  if (!isParty()) { render({ ...current, message: 'Open Puffer Party first.' }); return; }
  resumeAnswers = true;
  autoJoinPaused = false; autoJoin.setEnabled(autoJoinEnabled);
  const token = ++generation;
  if (!bot) {
    render({ ...current, message: 'Loading local database…' });
    try {
      load ??= backgroundRequest({ type: 'KRILLIONBOT_SEED' }).then(result => {
        if (!Array.isArray(result?.promptKeys) || result.promptKeys.some((key: unknown) => typeof key !== 'string')) throw new Error(result?.error ?? 'Missing seed question index');
        return new Set<string>(result.promptKeys);
      }).catch(error => { load = null; throw error; });
      const promptKeys = await load;
      if (token !== generation) return;
      bot ??= new BotController(document, { hasPrompt: prompt => promptKeys.has(normalize(prompt)), lookup: () => [] }, render, {
        resolve: async (prompt, excluded, allowNetwork, options = {}) => {
          const requestId = `${Date.now()}-${++lookupSequence}`;
          const progress = (message: any, sender: chrome.runtime.MessageSender) => {
            if (sender.id === chrome.runtime.id && message.type === 'KRILLIONBOT_LLM_PROGRESS' && message.requestId === requestId) {
              options.onProgress?.(message.progress);
            }
          };
          const cancel = () => { void chrome.runtime.sendMessage({ type: 'KRILLIONBOT_CANCEL_RESOLVE', requestId }).catch(() => {}); };
          if (options.signal?.aborted) throw new Error('Lookup cancelled');
          chrome.runtime.onMessage.addListener(progress);
          options.signal?.addEventListener('abort', cancel, { once: true });
          try {
            const pending = backgroundRequest({ type: 'KRILLIONBOT_RESOLVE', prompt, excluded, allowNetwork, requestId });
            if (options.signal?.aborted) cancel();
            const result = await pending;
            if (result?.error || !Array.isArray(result?.candidates)) throw new Error('Fallback request failed');
            return result as FallbackResult;
          } finally {
            chrome.runtime.onMessage.removeListener(progress);
            options.signal?.removeEventListener('abort', cancel);
          }
        },
        record: async (prompt, answer, result) => {
          const response = await backgroundRequest({ type: 'KRILLIONBOT_RECORD', prompt, answer, result });
          if (response.saved !== true) throw new Error('History save was not confirmed');
        },
      });
    } catch (error) { render({ ...current, message: String(error) }); return; }
  }
  if (token !== generation) return;
  if (latest) bot.observe(latest);
  bot.enable();
  window.postMessage({ channel: CHANNEL, request: 'snapshot' }, location.origin);
}
function stop() {
  resumeAnswers = false;
  autoJoinPaused = true; autoJoin.setEnabled(false);
  autoJoinLabel.textContent = autoJoinEnabled ? 'Auto-join paused. Enable resumes it.' : 'Auto-join off.';
  resumeAfterDisconnect = false;
  generation++;
  if (bot) bot.stop();
  else render({ ...current, enabled: false, message: 'Off' });
}
shadow.querySelector('#enable')!.addEventListener('click', () => { void enable(); });
shadow.querySelector('#stop')!.addEventListener('click', stop);
const diagnostics = document.createElement('button');
diagnostics.textContent = 'Copy diagnostics';
shadow.querySelector('section')!.append(diagnostics);
diagnostics.addEventListener('click', () => {
  const state = latest?.type === 'state' ? latest.state : null;
  const safe = { version: '0.3.3', status: current, autoJoin: { enabled: autoJoinEnabled, paused: autoJoinPaused, message: autoJoinLabel.textContent },
    game: state ? { phase: state.phase, category: state.category, observedVersion: state.version } : null,
    input: document.querySelector<HTMLInputElement>('.pf-root input[aria-label="Your answer"]')?.placeholder ?? null };
  void navigator.clipboard.writeText(JSON.stringify(safe, null, 2)).then(
    () => { diagnostics.textContent = 'Copied'; }, () => { diagnostics.textContent = 'Copy failed'; });
});

window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL) return;
  const value = event.data.observation;
  let observation: Observation | null = null;
  if (value?.type === 'state') {
    const state = cleanState(value.state);
    if (state && location.pathname.endsWith(`/party/${state.code}`)) observation = { type: 'state', state };
  } else if (value?.type === 'disconnected') observation = { type: 'disconnected' };
  else if (value?.type === 'result' && typeof value.accepted === 'boolean' && typeof value.why === 'string' &&
           typeof value.answer === 'string' && typeof value.category === 'string') {
    observation = { type: 'result', accepted: value.accepted, why: value.why, answer: value.answer, category: value.category };
  }
  if (!observation) return;
  if (observation.type !== 'result') latest = observation;
  if (observation.type === 'disconnected') resumeAfterDisconnect ||= resumeAnswers && !!bot?.getStatus().enabled;
  bot?.observe(observation);
  if (observation.type === 'state' && resumeAfterDisconnect) {
    resumeAfterDisconnect = false;
    if (autoJoinEnabled && !autoJoinPaused && resumeAnswers) bot?.enable();
  }
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'KRILLIONBOT_AUTO_JOIN_CHANGED' && typeof message.enabled === 'boolean') {
    configureAutoJoin(message.enabled); respond({ saved: true }); return;
  }
  if (message.type === 'KRILLIONBOT_ENABLE') { void enable().then(() => respond(current)); return true; }
  if (message.type === 'KRILLIONBOT_STOP') stop();
  if (['KRILLIONBOT_STATUS', 'KRILLIONBOT_STOP'].includes(message.type)) respond(current);
});
let scheduled = false;
const observer = new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; mount(); void bot?.tick(); });
});
document.addEventListener('input', () => { void bot?.tick(); });
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
window.addEventListener('pagehide', () => {
  stopDragging();
  observer.disconnect(); clearInterval(joinTimer); chrome.storage?.onChanged?.removeListener(storageChanged); stop();
});
window.addEventListener('offline', () => bot?.stop('Offline. Reload and re-enable when connected.'));
mount();
const stopDragging = makeDraggablePanel(panel, shadow.querySelector<HTMLElement>('#move-panel')!);
window.postMessage({ channel: CHANNEL, request: 'snapshot' }, location.origin);
