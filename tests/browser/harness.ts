import { SeedLookup } from '../../src/resolver/seed-lookup.js';
import type { SeedDatabase } from '../../src/data/types.js';
import type { PartyState } from '../../src/extension/protocol.js';
import { AnswerCache, type KeyValueStore } from '../../src/llm/cache.js';
import { createGenerator, DEFAULT_SETTINGS } from '../../src/llm/provider.js';
import { normalize } from '../../src/data/normalize.js';
import { abortableDelay } from '../../src/llm/retry.js';

const text = (selector: string, value: string) => { document.querySelector(selector)!.textContent = value; };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const button = (id: string, fn: () => void) => document.querySelector(id)!.addEventListener('click', fn);

async function main() {
  const database: SeedDatabase = await (await fetch('/extension/seed.json')).json();
  const best = new SeedLookup(database).lookup('Name a pasta dish')[0]!.text;
  const lookup = new SeedLookup(database);
  const spiritPrompt = 'Name a distilled spirit or liqueur';
  // Keep the unseeded drill deterministic even as new seed packs add this real question.
  const SPIRITS = lookup.hasPrompt(spiritPrompt) ? `${spiritPrompt} [local mock category]` : spiritPrompt;
  const WORK = 'Name an English word containing “work”';
  const workAnswers = ['workshop', 'network', 'homework', 'teamwork', 'framework', 'artwork', 'workplace', 'workforce', 'workload', 'workbook',
    'workbench', 'workday', 'workman', 'worker', 'workhorse', 'patchwork', 'woodwork', 'paperwork', 'clockwork', 'firework'];
  const mockAnswers = ['Gin', 'Vodka', 'Rum', 'Tequila', 'Mezcal', 'Brandy', 'Whisky', 'Bourbon', 'Cognac', 'Armagnac',
    'Calvados', 'Grappa', 'Pisco', 'Aquavit', 'Sambuca', 'Amaretto', 'Chartreuse', 'Chambord', 'Absinthe', 'Limoncello'];
  let mockEnabled = false, mockCalls = 0;
  let scenarioCalls = 0;
  const fault = document.querySelector<HTMLSelectElement>('#fault')!;
  const milliseconds = (id: string) => Math.max(0, Number(document.querySelector<HTMLInputElement>(`#${id}`)!.value));
  const mockSettings = () => ({ ...DEFAULT_SETTINGS, enabled: mockEnabled, model: 'deterministic-mock',
    timeoutMs: milliseconds('mock-timeout'), maxAttempts: 3, retryBudgetMs: 3000 });
  const attemptLog = (message: string) => {
    const output = document.querySelector('#attempt-log')!;
    output.textContent = (output.textContent + '\n' + message).split('\n').slice(-40).join('\n');
  };
  const makeCache = (prefix: string) => {
    const local: KeyValueStore = {
      get: async key => { const raw = localStorage.getItem(prefix + key); return raw === null ? undefined : JSON.parse(raw); },
      set: async (key, value) => { localStorage.setItem(prefix + key, JSON.stringify(value)); },
    };
    const sessionData = new Map<string, unknown>();
    return new AnswerCache(local, {
      get: async key => sessionData.get(key), set: async (key, value) => { sessionData.set(key, value); },
    }, createGenerator((async (_url, init) => {
      mockCalls++; scenarioCalls++;
      const mode = fault.value, first = scenarioCalls === 1;
      const responseDelay = mode === 'timeout-always' || mode === 'timeout-once' && first
        ? Math.max(10000, milliseconds('mock-timeout') * 2) : milliseconds('mock-delay');
      await abortableDelay(responseDelay, init?.signal ?? undefined);
      if (mode === 'network-once' && first) throw new TypeError('Simulated connection failure');
      if (mode === 'rate-once' && first) return new Response('{}', { status: 429, headers: { 'Retry-After': '0.05' } });
      if (mode === 'server-once' && first) return new Response('{}', { status: 503 });
      if (mode === 'auth') return new Response('{}', { status: 401 });
      if (mode === 'json') return new Response('malformed');
      const prompt = JSON.parse(JSON.parse(String(init?.body)).input).question;
      const candidates = mode === 'empty' ? [] : prompt === WORK ? workAnswers : mockAnswers;
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [
        { type: 'output_text', text: JSON.stringify({ candidates }) },
      ] }] }));
    }) as typeof fetch));
  };
  let cache = makeCache('krillionbot-fixture:manual:');
  const questions = document.querySelector<HTMLSelectElement>('#question')!;
  const prompts = [...new Set(Object.values(database.days).flatMap(day => day.prompts.map(p => p.text)))].sort();
  for (const prompt of [...new Set([...prompts, SPIRITS, WORK])]) {
    const option = document.createElement('option'); option.value = prompt; option.textContent = prompt;
    questions.append(option);
  }
  questions.value = 'Name a pasta dish';
  let room: PartyState = {
    code: 'TEST', version: 1, phase: 'round', gameNumber: 1, holderSince: 1,
    category: { index: 1, text: 'Name a pasta dish', accepted: 0 },
    events: [{ seq: 1, kind: 'category', index: 1 }],
  };
  let seq = 1, cid = 0, rejectNext = false, socket: WebSocket;
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Your answer"]')!;
  const send = document.querySelector<HTMLButtonElement>('[aria-label="Send answer"]')!;
  const rows: { answer: string; accepted: boolean }[] = [];
  let lastDroppedAnswer = '';
  const transmit = (frame: unknown) => { if (socket.readyState === 1) socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); };
  const snapshot = () => { room.version++; transmit({ t: 'snap', room }); };
  const turn = (ours: boolean) => {
    room.holderSince = (room.holderSince ?? 0) + 1;
    input.placeholder = ours ? 'your puffer — type!' : 'other player is up…';
    send.disabled = !ours || !input.value;
    text('.pf-status', ours ? 'your puffer · type an answer' : 'other player is up');
    snapshot();
  };
  class SimulatedSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor(_url: string | URL, _protocols?: string | string[]) { super(); }
    send(raw: string) {
      if (this.readyState !== 1) throw new Error('Simulated connection is closed. Refresh the page.');
      const message = JSON.parse(raw);
      const answer: string = message.action.text;
      const categoryIndex = room.category!.index;
      const valid = lookup.lookup(room.category!.text, { limit: Infinity }).some(candidate =>
        [candidate.text, ...candidate.aliases].some(text => normalize(text) === normalize(answer))) ||
        (room.category!.text === SPIRITS ? mockAnswers : room.category!.text === WORK ? workAnswers : []).some(text => normalize(text) === normalize(answer));
      const alreadyUsed = room.events.some(event => event.kind === 'pass' && normalize(event.answer!) === normalize(answer));
      const accepted = !rejectNext && valid && !alreadyUsed;
      rejectNext = false;
      rows.push({ answer, accepted });
      const entry = document.createElement('li');
      entry.textContent = `Simulated ${accepted ? 'accepted' : 'rejected'}: ${answer}`;
      document.querySelector('#submissions')!.append(entry);
      setTimeout(() => {
        if (room.category!.index !== categoryIndex) return;
        input.value = ''; send.disabled = true;
        if (accepted) {
          room.category!.accepted++;
          room.events.push({ seq: ++seq, kind: 'pass', answer });
          turn(false);
        }
        transmit({ t: 'ack', cid: message.cid, submit: { accepted, why: accepted ? '' : alreadyUsed ? 'repeat' : 'miss' } });
      }, 30);
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  Object.defineProperty(window, 'WebSocket', { value: SimulatedSocket, writable: true, configurable: true });
  const listeners = new Set<(message: any, sender: any) => void>();
  const requests = new Map<string, AbortController>();
  Object.defineProperty(window, 'chrome', { configurable: true, value: { runtime: {
    id: 'local-test', getURL: (path: string) => `chrome-extension://local-test/${path}`, sendMessage: async (request: any) => {
      if (request.type === 'KRILLIONBOT_LOG') { attemptLog(`${request.entry.event}: ${request.entry.message}`); return { saved: true }; }
      if (request.type === 'KRILLIONBOT_RECOVERY_CONFIG') return { enabled: true };
      if (request.type === 'KRILLIONBOT_AUTO_JOIN_CONFIG') return { enabled: false };
      if (request.type === 'KRILLIONBOT_CANCEL_RESOLVE') { requests.get(request.requestId)?.abort(); return { cancelled: true }; }
      if (request.type === 'KRILLIONBOT_SEED') return { promptKeys: lookup.promptKeys() };
      if (request.type === 'KRILLIONBOT_RECORD') {
        await cache.record(request.prompt, request.answer, request.result); return { saved: true };
      }
      if (request.type === 'KRILLIONBOT_RESOLVE') {
        const candidates = lookup.lookup(request.prompt, { used: request.excluded, maxLength: 60 });
        if (candidates.length) return { candidates, message: 'Seed candidates available; no provider request needed.',
          networkUsed: false, ...await cache.metrics() };
        const abort = new AbortController(); requests.set(request.requestId, abort);
        try {
          const result = await cache.resolve(request.prompt, request.excluded, mockSettings(), 'mock-key-not-a-real-credential', request.allowNetwork, {
            signal: abort.signal, onProgress: progress => {
              attemptLog(progress.message);
              for (const listener of listeners) listener({ type: 'KRILLIONBOT_LLM_PROGRESS', requestId: request.requestId, progress }, { id: 'local-test' });
            },
          });
          text('#mock-status', `${mockCalls} mock HTTP attempts · ${result.cacheHits} cache hits · ${result.message}`);
          return result;
        } finally { requests.delete(request.requestId); }
      }
      throw new Error('Unsupported simulated extension request');
    }, onMessage: { addListener: (fn: any) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn) },
  } } });
  const script = (src: string) => new Promise<void>((resolve, reject) => {
    const tag = document.createElement('script'); tag.src = src;
    tag.onload = () => resolve(); tag.onerror = () => reject(new Error(`Could not load ${src}`));
    document.body.append(tag);
  });
  await script('/extension/bridge.js');
  await script('/extension/content.js');
  socket = new window.WebSocket('wss://party.krillion.io/rooms/TEST/ws');
  snapshot();
  const updateSend = () => {
    send.disabled = !input.value || !input.placeholder.startsWith('your puffer') ||
      document.querySelector<HTMLInputElement>('#block-send')!.checked;
  };
  input.addEventListener('input', () => {
    send.disabled = true;
    setTimeout(updateSend, milliseconds('send-delay'));
  });
  document.querySelector('#block-send')!.addEventListener('change', updateSend);
  send.addEventListener('click', () => {
    const drop = document.querySelector<HTMLInputElement>('#drop-send')!;
    if (drop.checked) {
      drop.checked = false;
      lastDroppedAnswer = input.value;
      attemptLog(`Dropped Send for ${input.value}; waiting for automatic submission recovery.`);
      return;
    }
    socket.send(JSON.stringify({ t: 'act', cid: `fixture-${++cid}`, action: { type: 'submit', text: input.value } }));
  });
  const controls = () => document.querySelector('#krillionbot-controls')!.shadowRoot!;
  const enable = () => controls().querySelector<HTMLButtonElement>('#enable')!.click();
  const stop = () => controls().querySelector<HTMLButtonElement>('#stop')!.click();
  const reset = (unknown = false) => {
    input.value = ''; rejectNext = false;
    const index = room.category!.index + 1;
    room.category = { index, text: unknown ? SPIRITS : questions.value, accepted: 0 };
    room.events = [{ seq: ++seq, kind: 'category', index }];
    text('.prompt', room.category.text); turn(false);
  };
  button('#mine', () => turn(true)); button('#other', () => turn(false));
  button('#used', () => {
    const next = lookup.lookup(room.category!.text, { used: room.events.filter(e => e.kind === 'pass').map(e => e.answer!) })[0];
    if (!next) { text('#feedback', 'No unused seed answer for this simulated opponent.'); return; }
    room.category!.accepted++; room.events.push({ seq: ++seq, kind: 'pass', answer: next.text }); snapshot();
    text('#feedback', `Opponent used: ${next.text}`);
  });
  button('#reject', () => { rejectNext = true; text('#feedback', 'Next submission will be rejected. Now choose Your turn.'); });
  button('#new', () => { reset(); text('#feedback', 'Selected question reset; opponent turn.'); });
  button('#unknown', () => reset(true)); button('#disconnect', () => socket.close());
  button('#mock', () => {
    mockEnabled = !mockEnabled; text('#mock', `Mock LLM: ${mockEnabled ? 'on' : 'off'}`);
    text('#feedback', 'Mock setting changed. Stop/Enable retries a question miss. No real API calls.');
  });
  const resetMock = () => {
    stop(); cache.resetFailures();
    for (const key of Object.keys(localStorage).filter(key => key.startsWith('krillionbot-fixture:manual:'))) localStorage.removeItem(key);
    cache = makeCache('krillionbot-fixture:manual:'); scenarioCalls = 0;
    text('#attempt-log', 'Mock attempts reset.'); text('#feedback', 'Mock data reset. Enable to try the selected fault.');
  };
  button('#reset-mock', resetMock);
  fault.addEventListener('change', () => { scenarioCalls = 0; text('#feedback', 'Fault selected. Reset mock cache before testing to avoid a cache hit.'); });

  const until = async (condition: () => boolean, label: string, timeoutMs = 2000) => {
    for (let i = 0; i < timeoutMs / 10; i++) { if (condition()) return; await delay(10); }
    throw new Error(`Timed out: ${label}`);
  };
  const assert = (ok: boolean, label: string) => { if (!ok) throw new Error(label); };
  const run = document.querySelector<HTMLButtonElement>('#run')!;
  run.disabled = false; text('#ready', 'Ready · local simulation');
  const manual = document.querySelector<HTMLFieldSetElement>('#manual')!;
  manual.disabled = false; text('#feedback', 'Choose a question, then Enable and Your turn.');
  run.addEventListener('click', async () => {
    run.disabled = true; manual.disabled = true; const passed: string[] = [];
    // Run checks owns disposable test storage, separate from manual simulation cache.
    for (const key of Object.keys(localStorage).filter(key => key.startsWith('krillionbot-fixture:checks:'))) localStorage.removeItem(key);
    cache = makeCache('krillionbot-fixture:checks:'); mockEnabled = false; mockCalls = 0;
    fault.value = 'normal'; scenarioCalls = 0;
    document.querySelector<HTMLInputElement>('#send-delay')!.value = '0';
    document.querySelector<HTMLInputElement>('#block-send')!.checked = false;
    questions.value = 'Name a pasta dish';
    const pass = (label: string) => { passed.push(`PASS: ${label}`); text('#results', passed.join('\n')); };
    try {
      stop(); reset(); await delay(20); const start = rows.length; enable();
      await until(() => controls().querySelector('p')!.textContent!.startsWith('Ready;'), 'prepared queue');
      assert(rows.length === start, 'Submitted on someone else’s turn'); pass('Prepares without submitting off-turn');
      room.category!.accepted++; room.events.push({ seq: ++seq, kind: 'pass', answer: best }); snapshot(); turn(true);
      await until(() => rows.length > start, 'first answer');
      assert(rows.at(-1)!.answer !== best, 'Reused the opponent’s answer'); pass('Submits on our turn and excludes used best answer');
      await delay(60); snapshot(); snapshot(); await delay(30);
      assert(rows.length === start + 1, 'Duplicate submission'); pass('Repeated updates do not double-submit');
      document.querySelector<HTMLInputElement>('#send-delay')!.value = '120';
      reset(); await delay(20); const beforeDelayed = rows.length; turn(true);
      await until(() => rows.length === beforeDelayed + 1, 'delayed Send render'); await delay(60);
      assert(controls().querySelector('p')!.textContent !== 'Off', 'Delayed render stopped the bot');
      pass('Delayed Send render waits and submits once without getting stuck');
      document.querySelector<HTMLInputElement>('#send-delay')!.value = '0';
      reset(); await delay(20); const beforeDroppedSend = rows.length;
      document.querySelector<HTMLInputElement>('#drop-send')!.checked = true;
      turn(true);
      await until(() => rows.length === beforeDroppedSend + 1, 'five-second submission recovery', 7000);
      assert(rows.at(-1)!.answer !== lastDroppedAnswer, 'Recovery resent the unconfirmed answer');
      assert(document.querySelector('#attempt-log')!.textContent!.includes('submission.recovery'), 'Recovery was not logged');
      await delay(60);
      pass('A dropped Send recovers after five seconds, selects another answer and logs the circumstances');
      reset(); await delay(20); const beforeReject = rows.length; rejectNext = true; turn(true);
      await until(() => rows.length === beforeReject + 2, 'rejection backup');
      assert(rows[beforeReject]!.answer !== rows[beforeReject + 1]!.answer, 'Retried rejected answer');
      pass('A confirmed rejection advances to a different backup'); await delay(60);
      reset(); stop(); const beforeStop = rows.length; turn(true); await delay(50);
      assert(rows.length === beforeStop, 'Stop did not prevent submission'); pass('Stop prevents submission');
      reset(true); await delay(20); enable(); turn(true);
      await until(() => controls().querySelector('p')!.textContent!.includes('No seed question match.'), 'unknown-category state');
      assert(rows.length === beforeStop, 'Unknown category submitted a guess'); pass('Unknown category stays available for manual entry');
      stop(); reset(true); mockEnabled = true; await delay(20); enable();
      await until(() => controls().querySelector('p')!.textContent!.includes('· llm'), 'mock LLM batch');
      assert(mockCalls === 1, 'Expected one mock LLM call'); pass('Unseeded question receives a structured text batch from the mock provider');
      reset(true); await until(() => controls().querySelector('p')!.textContent!.includes('· cache'), 'persistent cached batch');
      assert(mockCalls === 1, 'Repeated question made another LLM request'); pass('Same question reuses its cached batch without another provider call');
      const beforeLearning = rows.length; turn(true);
      await until(() => rows.length > beforeLearning, 'mock answer submission'); await delay(60);
      reset(true); await until(() => controls().querySelector('p')!.textContent!.includes('· history'), 'confirmed history');
      assert(mockCalls === 1, 'Confirmed history made another LLM request'); pass('Simulated acceptance promotes an answer to confirmed history');
      stop();
      const originalTimeout = milliseconds('mock-timeout'), originalDelay = milliseconds('mock-delay');
      document.querySelector<HTMLInputElement>('#mock-timeout')!.value = '30';
      document.querySelector<HTMLInputElement>('#mock-delay')!.value = '1';
      for (const mode of ['timeout-once', 'rate-once', 'server-once', 'network-once', 'auth', 'json', 'empty', 'timeout-always']) {
        fault.value = mode; scenarioCalls = 0;
        const scenario = makeCache(`krillionbot-fixture:checks:${mode}:`);
        const result = await scenario.resolve(WORK, [], mockSettings(), 'mock-only', true, {
          onProgress: progress => attemptLog(`${mode}: ${progress.message}`),
        });
        if (mode.endsWith('-once')) {
          assert(result.candidates.length > 0 && scenarioCalls === 2, `${mode}: expected recovery on attempt 2`);
        } else {
          assert(!result.candidates.length, `${mode}: failure generated answers`);
          assert(scenarioCalls === (mode === 'timeout-always' ? 3 : 1), `${mode}: incorrect retry count`);
        }
        pass(`Fault harness: ${mode} (${scenarioCalls} mock HTTP attempts)`);
      }
      document.querySelector<HTMLInputElement>('#mock-timeout')!.value = String(originalTimeout);
      document.querySelector<HTMLInputElement>('#mock-delay')!.value = String(originalDelay);
      fault.value = 'normal';
      stop(); reset(); mockEnabled = false;
      text('#results', passed.join('\n') + '\n\nALL LOCAL CHECKS PASSED. Acceptance here is simulated. Next: TESTING.md for real API and game checks.');
    } catch (error) {
      const status = controls().querySelector('p')!.textContent;
      stop(); text('#results', passed.join('\n') + '\nFAIL: ' + String(error) + '\nBot: ' + status + '\n' + document.querySelector('#mock-status')!.textContent);
    }
    finally {
      stop(); cache = makeCache('krillionbot-fixture:manual:');
      run.disabled = false; manual.disabled = false; text('#mock', `Mock LLM: ${mockEnabled ? 'on' : 'off'}`);
    }
  });
}
main().catch(error => { text('#ready', 'Setup failed'); text('#results', String(error)); });
