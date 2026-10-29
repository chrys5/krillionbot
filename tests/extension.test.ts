import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { BotController, type Fallback, type InputTiming } from '../src/extension/controller.js';
import type { FallbackResult } from '../src/llm/cache.js';
import { PartyFeed, cleanState, usedAnswers, type PartyState } from '../src/extension/protocol.js';
import { SeedLookup } from '../src/resolver/seed-lookup.js';
import { emptyDatabase } from '../src/data/update.js';
import type { DiagnosticEvent } from '../src/extension/diagnostics.js';

const PROMPT = 'Name a pasta dish';
test('fallback errors explain recovery in status and copied events without exposing raw secrets', async () => {
  const f = setup({
    resolve: async () => { throw new Error('Extension context invalidated. mock-secret'); },
    record: async () => { throw new Error('Extension context invalidated. mock-secret'); },
  });
  try {
    const current = state();
    current.category!.text = 'Name a country with land classified as tropical rainforest climate';
    current.category!.accepted = 1;
    current.events.push({ seq: 2, kind: 'pass', answer: 'Brazil' });
    f.bot.observe({ type: 'state', state: current }); f.bot.enable();
    await until(() => f.bot.getStatus().message.includes('Fallback failed.'), 'actionable fallback error');
    const status = f.bot.getStatus();
    assert.match(status.message, /Refresh the Krillion tab/);
    assert.ok(status.events?.some(event => event.message.includes('Could not save answer history.') && event.message.includes('Refresh')));
    assert.ok(!JSON.stringify(status).includes('mock-secret'));
    assert.deepEqual(f.submissions, []);
  } finally { f.close(); }
});
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await wait(5); }
  assert.fail(`Timed out waiting for ${label}`);
}
const html = `<div class="pf-root" data-phase="answering"><div class="ds-card"><div class="prompt">${PROMPT}</div></div><input aria-label="Your answer" placeholder="your puffer — type!"><button aria-label="Send answer" disabled>SEND</button></div>`;
function state(index = 1): PartyState {
  return { code: 'TEST', version: 1, phase: 'round', gameNumber: 1, holderSince: 100,
    category: { index, text: PROMPT, accepted: 0 }, events: [{ seq: 1, kind: 'category', index }] };
}
function setup(fallback?: Fallback, timing?: InputTiming, diagnostics: DiagnosticEvent[] = []) {
  const dom = new JSDOM(html, { url: 'https://krillion.io/party/TEST' });
  const document = dom.window.document;
  const input = document.querySelector('input')!;
  const button = document.querySelector('button')!;
  input.addEventListener('input', () => { button.disabled = !input.value.trim(); });
  const submissions: string[] = [];
  button.addEventListener('click', () => { submissions.push(input.value); });
  const database = emptyDatabase();
  database.days['2026-10-28'] = { date: '2026-10-28', dive: 105, sourceUrl: 'fixture', prompts: [{
    text: PROMPT, key: PROMPT.toLowerCase(), answers: [
      { text: 'First', score: 100, tier: 'krillion', aliases: ['First alias'] },
      { text: 'Second', score: 85, tier: 'deepcut', aliases: [] },
      { text: 'Third', score: 60, tier: 'rare', aliases: [] },
    ],
  }] };
  const bot = new BotController(document, new SeedLookup(database), () => {}, fallback, timing,
    event => diagnostics.push(structuredClone(event)));
  const close = () => { bot.stop(); dom.window.close(); };
  return { dom, document, input, button, submissions, bot, close };
}

test('passive feed applies versioned patches without retaining private fields', () => {
  const feed = new PartyFeed();
  feed.receive({ t: 'snap', room: { ...state(), chat: ['private'], playerKey: 'secret' } });
  const update = feed.receive({ t: 'patch', patch: { base: 1, v: 2,
    set: { category: { index: 1, text: PROMPT, accepted: 1 } },
    events: [{ seq: 2, kind: 'pass', answer: 'First' }],
  } });
  assert.equal(update?.type, 'state');
  assert.deepEqual(usedAnswers(feed.state!), ['First']);
  assert.ok(!JSON.stringify(feed.state).includes('secret'));
  assert.ok(!JSON.stringify(feed.state).includes('private'));
  assert.equal(feed.receive({ t: 'patch', patch: { base: 99, v: 100 } })?.type, 'disconnected');
});

test('feed correlates only actual submit acknowledgements, not chat/typing or stale commands', () => {
  const feed = new PartyFeed();
  feed.receive({ t: 'snap', room: state() });
  feed.outgoing({ t: 'act', cid: 'one', action: { type: 'submit', text: 'First' } });
  assert.equal(feed.receive({ t: 'ack', cid: 'typing', ok: true }), null);
  assert.deepEqual(feed.receive({ t: 'ack', cid: 'one', submit: { accepted: true } }), {
    type: 'result', answer: 'First', category: 'TEST:1:1', accepted: true, why: '',
  });
  assert.equal(feed.receive({ t: 'ack', cid: 'one', submit: { accepted: true } }), null);
});

test('missing used answers are not treated as an empty room', () => {
  const value = state(); value.category!.accepted = 2;
  assert.equal(usedAnswers(value), null);
  assert.equal(cleanState({ ...value, category: { text: PROMPT } }), null);
});

test('prepares off-turn, then submits once on our turn despite repeated updates', async () => {
  const f = setup();
  try {
    f.input.placeholder = 'other player is up…';
    f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
    await wait(10); assert.equal(f.submissions.length, 0);
    f.input.placeholder = 'your puffer — type!';
    await Promise.all([f.bot.tick(), f.bot.tick(), f.bot.tick()]);
    assert.deepEqual(f.submissions, ['First']);
    await f.bot.tick(); assert.equal(f.submissions.length, 1);
  } finally { f.close(); }
});

test('opponents used answers and aliases are excluded before submission', async () => {
  const f = setup();
  try {
    const current = state(); current.category!.accepted = 1;
    current.events.push({ seq: 2, kind: 'pass', answer: 'First alias' });
    f.bot.observe({ type: 'state', state: current }); f.bot.enable();
    await until(() => f.submissions.length === 1, 'alias-filtered submission'); assert.deepEqual(f.submissions, ['Second']);
  } finally { f.close(); }
});

test('confirmed rejection retries a backup; acceptance latches the turn', async () => {
  const f = setup();
  try {
    f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
    await until(() => f.submissions.length === 1, 'first submission'); f.input.value = '';
    f.bot.observe({ type: 'result', answer: 'First', category: 'TEST:1:1', accepted: false, why: 'miss' });
    await until(() => f.submissions.length === 2, 'rejection backup'); assert.deepEqual(f.submissions, ['First', 'Second']);
    f.input.value = '';
    f.bot.observe({ type: 'result', answer: 'Second', category: 'TEST:1:1', accepted: true, why: '' });
    await wait(20); await f.bot.tick(); assert.equal(f.submissions.length, 2);
  } finally { f.close(); }
});

const recoveryTiming = { readyTimeoutMs: 100, retryDelayMs: 10, submissionTimeoutMs: 50 };
test('missing submission results recover automatically, exclude uncertain answers and remain bounded', async () => {
  const diagnostics: DiagnosticEvent[] = [], learned: string[] = [];
  const f = setup({ resolve: async () => ({ candidates: [], message: 'No suggestions', requests: 0, cacheHits: 0, networkUsed: false }),
    record: async (_prompt, _answer, result) => { learned.push(result); } }, recoveryTiming, diagnostics);
  try {
    f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
    await until(() => f.bot.getStatus().message.includes('Three attempts'), 'bounded submission recovery');
    assert.deepEqual(f.submissions, ['First', 'Second', 'Third']);
    assert.equal(f.bot.getStatus().enabled, true);
    assert.equal(f.bot.getStatus().submissionTimeouts, 3);
    assert.equal(f.input.value, '');
    assert.deepEqual(learned, [], 'A missing acknowledgement never proves an answer invalid');
    assert.equal(diagnostics.filter(event => event.event === 'submission.recovery').length, 3);
    const context = diagnostics.find(event => event.event === 'submission.recovery')!.context as any;
    assert.equal(context.pending.answer, 'First'); assert.equal(context.pending.turn, 100);
    assert.equal(context.game.version, 1); assert.equal(context.dom.ourTurn, true);
    const next = state(2); next.holderSince = 200;
    f.bot.observe({ type: 'state', state: next });
    await until(() => f.submissions.length === 4, 'recovery at the next category');
    assert.equal(f.submissions[3], 'First');
  } finally { f.close(); }
});

test('missing acknowledgement reconciles accepted answers and turn changes without stale retries', async () => {
  const f = setup(undefined, recoveryTiming);
  try {
    f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
    await until(() => f.submissions.length === 1, 'initial send');
    const next = state(); next.version = 2; next.holderSince = 200;
    next.category!.accepted = 1; next.events.push({ seq: 2, kind: 'pass', answer: 'First alias' });
    f.input.placeholder = 'other player is up…';
    f.bot.observe({ type: 'state', state: next });
    await wait(80);
    assert.deepEqual(f.submissions, ['First']); assert.equal(f.bot.getStatus().enabled, true);
    f.input.placeholder = 'your puffer — type!'; next.holderSince = 300;
    f.bot.observe({ type: 'state', state: { ...next } });
    await until(() => f.submissions.length === 2, 'next turn after lost acknowledgement');
    assert.deepEqual(f.submissions, ['First', 'Second']);
  } finally { f.close(); }
});

test('timeout preserves manual edits and Stop cancels automatic recovery', async () => {
  for (const action of ['edit', 'stop', 'off', 'phase']) {
    const f = setup(undefined, recoveryTiming);
    try {
      if (action === 'off') f.bot.setAutoRecovery(false);
      f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
      await until(() => f.submissions.length === 1, 'send before timeout');
      if (action === 'edit') {
        f.input.value = 'My manual answer';
        f.input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
      }
      if (action === 'stop') f.bot.stop();
      if (action === 'phase') { const next = state(); next.phase = 'over'; f.bot.observe({ type: 'state', state: next }); }
      await wait(100);
      assert.deepEqual(f.submissions, ['First']);
      if (action === 'edit') assert.equal(f.input.value, 'My manual answer');
      assert.equal(f.bot.getStatus().enabled, action === 'edit' || action === 'phase');
    } finally { f.close(); }
  }
});

test('late acknowledgements cannot clear a newer pending submission', async () => {
  const f = setup(undefined, recoveryTiming);
  try {
    f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
    await until(() => f.submissions.length === 2, 'second send after timeout');
    f.bot.observe({ type: 'result', answer: 'First', category: 'TEST:1:1', accepted: false, why: 'miss' });
    f.bot.observe({ type: 'result', answer: 'Second', category: 'TEST:1:1', accepted: true, why: '' });
    await wait(80);
    assert.deepEqual(f.submissions, ['First', 'Second']); assert.equal(f.bot.getStatus().enabled, true);
  } finally { f.close(); }
});

test('Stop while the input is rendering prevents the click', async () => {
  const f = setup();
  try {
    f.bot.observe({ type: 'state', state: state() }); f.bot.enable(); f.bot.stop();
    await wait(20); assert.equal(f.submissions.length, 0); assert.equal(f.input.value, '');
  } finally { f.close(); }
});

test('a delayed Send render submits once without stopping or losing the prepared value', async () => {
  const f = setup();
  try {
    f.input.addEventListener('input', () => {
      f.button.disabled = true;
      setTimeout(() => { if (!f.input.value) return; f.button.disabled = false; }, 90);
    });
    f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
    await wait(20);
    assert.equal(f.input.value, 'First'); assert.equal(f.submissions.length, 0);
    for (let i = 0; i < 10; i++) { void f.bot.tick(); f.bot.observe({ type: 'state', state: state() }); }
    await until(() => f.submissions.length === 1, 'delayed Send');
    assert.deepEqual(f.submissions, ['First']); assert.equal(f.bot.getStatus().enabled, true);
  } finally { f.close(); }
});

test('unavailable Send clears owned input, retries automatically and resumes on a new turn', async () => {
  const f = setup(undefined, { readyTimeoutMs: 30, retryDelayMs: 10 });
  let blocked = true, fills = 0;
  try {
    f.input.addEventListener('input', () => {
      if (f.input.value) fills++;
      if (blocked) f.button.disabled = true;
    });
    f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
    await until(() => f.bot.getStatus().message.includes('after 3 preparations'), 'bounded input retries');
    assert.equal(fills, 3); assert.equal(f.input.value, ''); assert.equal(f.submissions.length, 0);
    assert.equal(f.bot.getStatus().enabled, true); assert.equal(f.bot.getStatus().inputFailures, 3);
    await f.bot.tick(); assert.equal(fills, 3);
    blocked = false;
    const next = state(); next.holderSince = 200;
    f.bot.observe({ type: 'state', state: next });
    await until(() => f.submissions.length === 1, 'input recovery on new turn');
    assert.deepEqual(f.submissions, ['First']); assert.equal(f.bot.getStatus().inputFailures, 0);
  } finally { f.close(); }
});

test('a temporarily unavailable Send recovers on an automatic preparation retry', async () => {
  const f = setup(undefined, { readyTimeoutMs: 30, retryDelayMs: 10 });
  let fills = 0;
  try {
    f.input.addEventListener('input', () => { if (f.input.value && ++fills === 1) f.button.disabled = true; });
    f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
    await until(() => f.submissions.length === 1, 'automatic input retry');
    assert.equal(fills, 2); assert.deepEqual(f.submissions, ['First']); assert.equal(f.bot.getStatus().enabled, true);
  } finally { f.close(); }
});

test('turn/phase changes and a newly used candidate cancel a delayed input without sending', async () => {
  for (const change of ['turn', 'phase', 'used']) {
    const f = setup();
    try {
      f.input.addEventListener('input', () => { f.button.disabled = true; });
      f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
      await until(() => f.bot.getStatus().message.includes('Preparing answer'), 'preparing input');
      const next = state();
      if (change === 'turn') { next.holderSince = 200; f.input.placeholder = 'other player is up…'; }
      if (change === 'phase') next.phase = 'over';
      if (change === 'used') {
        next.category!.accepted = 1; next.events.push({ seq: 2, kind: 'pass', answer: 'First' });
        f.input.placeholder = 'other player is up…';
      }
      f.bot.observe({ type: 'state', state: next });
      await until(() => f.input.value === '', 'abandoned input cleanup');
      assert.equal(f.submissions.length, 0); assert.equal(f.bot.getStatus().enabled, true);
    } finally { f.close(); }
  }
});

test('manual edits during preparation are preserved, including on Stop', async () => {
  for (const manual of ['My answer', 'First']) {
    const f = setup();
    try {
      f.input.addEventListener('input', () => { f.button.disabled = true; });
      f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
      await until(() => f.bot.getStatus().message.includes('Preparing answer'), 'preparing before manual edit');
      f.input.value = manual;
      f.input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
      f.bot.stop(); await wait(25);
      assert.equal(f.input.value, manual); assert.equal(f.submissions.length, 0);
    } finally { f.close(); }
  }
});

test('a candidate used during preparation is replaced before a click on the same turn', async () => {
  const f = setup();
  try {
    f.input.addEventListener('input', () => { if (f.input.value === 'First') f.button.disabled = true; });
    f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
    await until(() => f.bot.getStatus().message.includes('Preparing answer'), 'waiting before used update');
    const next = state(); next.category!.accepted = 1;
    next.events.push({ seq: 2, kind: 'pass', answer: 'First alias' });
    f.bot.observe({ type: 'state', state: next });
    await until(() => f.submissions.length === 1, 'unused replacement');
    assert.deepEqual(f.submissions, ['Second']);
  } finally { f.close(); }
});

test('a replaced controlled input is re-read and submitted through the current button', async () => {
  const f = setup();
  try {
    f.input.addEventListener('input', () => {
      const replacement = f.input.cloneNode(true) as HTMLInputElement;
      replacement.value = f.input.value;
      f.input.replaceWith(replacement);
    }, { once: true });
    const seen: string[] = [];
    f.button.addEventListener('click', () => seen.push(f.document.querySelector('input')!.value));
    f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
    await until(() => seen.length === 1, 'replacement input submission');
    assert.deepEqual(seen, ['First']); assert.equal(f.bot.getStatus().submissions, 1);
  } finally { f.close(); }
});

test('three rejected attempts exhaust the automatic retry allowance for that turn', async () => {
  const f = setup();
  try {
    f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
    for (const [index, answer] of ['First', 'Second', 'Third'].entries()) {
      await until(() => f.submissions.length === index + 1, `attempt ${index + 1}`); f.input.value = '';
      f.bot.observe({ type: 'result', answer, category: 'TEST:1:1', accepted: false, why: 'miss' });
    }
    await until(() => f.bot.getStatus().message.includes('Three attempts'), 'attempt limit');
    assert.equal(f.submissions.length, 3);
    assert.match(f.bot.getStatus().message, /Three attempts/);
  } finally { f.close(); }
});

test('category changes cancel the prepared submission; late results cannot affect a new category', async () => {
  const f = setup();
  try {
    f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
    const next = state(2); next.category!.text = 'Unknown category';
    f.document.querySelector('.prompt')!.textContent = 'Unknown category';
    f.bot.observe({ type: 'state', state: next });
    await wait(20); assert.equal(f.submissions.length, 0);
    f.bot.observe({ type: 'result', answer: 'First', category: 'TEST:1:1', accepted: true, why: '' });
    assert.equal(f.bot.getStatus().submissions, 0);
  } finally { f.close(); }
});

test('manual input is preserved, incomplete state and disconnect stop automation', async () => {
  const f = setup();
  try {
    f.input.value = 'My answer';
    f.bot.observe({ type: 'state', state: state() }); f.bot.enable();
    await wait(10); assert.equal(f.input.value, 'My answer'); assert.equal(f.submissions.length, 0);
    const incomplete = state(); incomplete.category!.accepted = 1;
    f.bot.observe({ type: 'state', state: incomplete });
    assert.equal(f.bot.getStatus().enabled, false);
    f.bot.observe({ type: 'disconnected' }); assert.equal(f.bot.getStatus().enabled, false);
  } finally { f.close(); }
});

test('an unseeded question prepares off-turn; used answers are filtered when LLM returns', async () => {
  let finish!: (result: FallbackResult) => void;
  let calls = 0;
  const f = setup({ resolve: async () => { calls++; return new Promise(resolve => { finish = resolve; }); }, record: async () => {} });
  try {
    const current = state(); current.category!.text = 'Unseeded question';
    f.document.querySelector('.prompt')!.textContent = current.category!.text;
    f.input.placeholder = 'someone else is up…';
    f.bot.observe({ type: 'state', state: current }); f.bot.enable();
    assert.equal(calls, 1);
    current.category!.accepted = 1; current.events.push({ seq: 2, kind: 'pass', answer: 'Used' });
    f.bot.observe({ type: 'state', state: { ...current } });
    finish({ candidates: [{ text: 'Used', aliases: [], source: 'llm' }, { text: 'Fresh', aliases: [], source: 'llm' }],
      message: 'generated', requests: 1, cacheHits: 0, networkUsed: true });
    await wait(20); assert.equal(f.submissions.length, 0);
    f.input.placeholder = 'your puffer — type!'; await f.bot.tick();
    assert.deepEqual(f.submissions, ['Fresh']); assert.equal(calls, 1);
  } finally { f.close(); }
});

test('late LLM results after Stop or a category change cannot submit', async () => {
  for (const action of ['stop', 'category']) {
    let finish!: (result: FallbackResult) => void;
    const f = setup({ resolve: async () => new Promise(resolve => { finish = resolve; }), record: async () => {} });
    try {
      const current = state(); current.category!.text = 'Unseeded question';
      f.document.querySelector('.prompt')!.textContent = current.category!.text;
      f.bot.observe({ type: 'state', state: current }); f.bot.enable();
      if (action === 'stop') f.bot.stop();
      else {
        f.document.querySelector('.prompt')!.textContent = PROMPT;
        f.input.placeholder = 'someone else is up…';
        f.bot.observe({ type: 'state', state: state(2) });
      }
      finish({ candidates: [{ text: 'Late', aliases: [], source: 'llm' }], message: 'generated', requests: 1, cacheHits: 0, networkUsed: true });
      await wait(20); assert.equal(f.submissions.length, 0);
    } finally { f.close(); }
  }
});

test('seed bypasses fallback; duplicate feedback does not become permanent invalid evidence', async () => {
  let calls = 0; const records: { answer: string; result: string }[] = [];
  const f = setup({ resolve: async () => { calls++; throw new Error('should not be called'); },
    record: async (_prompt, answer, result) => { records.push({ answer, result }); } });
  try {
    f.bot.observe({ type: 'state', state: state() }); f.bot.enable(); await wait(20);
    f.input.value = '';
    f.bot.observe({ type: 'result', answer: 'First', category: 'TEST:1:1', accepted: false, why: 'repeat' });
    await wait(20); assert.equal(calls, 0);
    assert.ok(!records.some(record => record.result === 'invalid'));
  } finally { f.close(); }
});

test('an active question automatically wakes after transient backoff and updates progress diagnostics', async () => {
  let calls = 0;
  const f = setup({
    resolve: async (_prompt, _excluded, _network, options) => {
      calls++;
      options?.onProgress?.({ message: 'LLM attempt 1/3 · timeout 2000 ms', attempt: 1, timeoutMs: 2000, attempts: [] });
      if (calls === 1) return { candidates: [], message: 'LLM timed out.', requests: 1, cacheHits: 0,
        networkUsed: true, retryable: true, retryAt: Date.now() + 20 };
      return { candidates: [{ text: 'workshop', aliases: [], source: 'llm' }], message: 'generated', requests: 2, cacheHits: 0, networkUsed: true };
    }, record: async () => {},
  });
  try {
    const current = state(); current.category!.text = 'Name an English word containing “work”';
    f.document.querySelector('.prompt')!.textContent = current.category!.text;
    f.bot.observe({ type: 'state', state: current }); f.bot.enable();
    await until(() => f.submissions.length === 1, 'automatic retry submission'); assert.equal(calls, 2); assert.deepEqual(f.submissions, ['workshop']);
    assert.ok(f.bot.getStatus().events!.some(event => event.message.includes('LLM attempt 1/3')));
  } finally { f.close(); }
});

test('Stop cancels a scheduled retry and category changes abort the pending lookup signal', async () => {
  let calls = 0;
  const f = setup({ resolve: async () => { calls++; return { candidates: [], message: 'LLM timeout.', requests: 1,
    cacheHits: 0, networkUsed: true, retryable: true, retryAt: Date.now() + 40 }; }, record: async () => {} });
  try {
    const current = state(); current.category!.text = 'Unseeded question';
    f.document.querySelector('.prompt')!.textContent = current.category!.text;
    f.bot.observe({ type: 'state', state: current }); f.bot.enable();
    await wait(10); f.bot.stop(); await wait(70); assert.equal(calls, 1);
  } finally { f.close(); }
  let signal: AbortSignal | undefined;
  const other = setup({ resolve: async (_p, _e, _n, options) => {
    signal = options?.signal;
    return new Promise(resolve => signal!.addEventListener('abort', () => resolve({ candidates: [], message: 'cancelled', requests: 0,
      cacheHits: 0, networkUsed: false })));
  }, record: async () => {} });
  try {
    const current = state(); current.category!.text = 'Unseeded question';
    other.document.querySelector('.prompt')!.textContent = current.category!.text;
    other.bot.observe({ type: 'state', state: current }); other.bot.enable();
    other.input.placeholder = 'other player is up…';
    other.bot.observe({ type: 'state', state: state(2) });
    assert.equal(signal!.aborted, true);
  } finally { other.close(); }
});
