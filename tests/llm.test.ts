import assert from 'node:assert/strict';
import test from 'node:test';
import { AnswerCache, cacheKey, type KeyValueStore } from '../src/llm/cache.js';
import { cleanCandidates, createGenerator, DEFAULT_SETTINGS, validateSettings, type GeneratedCandidate } from '../src/llm/provider.js';
import { fitsConstraints, questionConstraints, suggestionTtlMs } from '../src/llm/constraints.js';

class MemoryStore implements KeyValueStore {
  data = new Map<string, unknown>();
  async get(key: string) { return structuredClone(this.data.get(key)); }
  async set(key: string, value: unknown) { this.data.set(key, structuredClone(value)); }
}
const settings = { ...DEFAULT_SETTINGS, enabled: true, model: 'mock-text-model' };
const question = 'Name a distilled spirit or liqueur';
const batch = Array.from({ length: 20 }, (_, i) => `Candidate ${i + 1}`);
const jsonResponse = (answers = batch) => new Response(JSON.stringify({ status: 'completed', output: [
  { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ candidates: answers }) }] },
] }), { status: 200 });

test('Responses adapter requests only text candidates and sends constraints/exclusions', async () => {
  let calls = 0;
  const generate = createGenerator((async (url, init) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.text.format.schema.properties.candidates.items.type, 'string');
    assert.equal(body.max_output_tokens, 400); assert.equal(body.store, false);
    const input = JSON.parse(body.input);
    assert.equal(input.question, 'Name a word starting with Ch');
    assert.equal(input.constraints.startsWith, 'ch'); assert.deepEqual(input.excludedAnswers, ['Chair']);
    return jsonResponse(['Chair', 'Chocolate', 'Spider']);
  }) as typeof fetch);
  const result = await generate({ prompt: 'Name a word starting with Ch', excluded: ['Chair'] }, settings, 'mock-secret');
  // Provider validates constraints; selection/cache additionally filters excluded answers.
  assert.deepEqual(result.map(a => a.text), ['Chair', 'Chocolate']); assert.equal(calls, 1);
});

test('Chat Completions adapter supports alternate endpoint, JSON mode and token field', async () => {
  const generate = createGenerator((async (url, init) => {
    assert.equal(url, 'https://compatible.example/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'another-model'); assert.equal(body.max_tokens, 400);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"candidates":["Gin"]}' } }] }));
  }) as typeof fetch);
  assert.deepEqual(await generate({ prompt: question, excluded: [] }, {
    ...settings, baseUrl: 'https://compatible.example/v1', model: 'another-model', format: 'chat', jsonMode: 'json', chatTokenField: 'max_tokens',
  }, 'mock-secret'), [{ text: 'Gin' }]);
});

test('candidate validation removes invalid shape, duplicates, excess length and simple constraint violations', () => {
  assert.deepEqual(cleanCandidates({ candidates: [' Chair ', 'CHAIR', 'Spider', 'x'.repeat(61), 'Ch\nnews', 4, { text: 'Ch' }] },
    'Name a word starting with Ch'), [{ text: 'Chair' }]);
  assert.throws(() => cleanCandidates({ answers: ['Gin'] }), /candidates array/);
  const constraints = questionConstraints('Name a 3+ letter word you can spell with the letters in "krillion"');
  assert.ok(fitsConstraints('lion', constraints));
  assert.equal(fitsConstraints('lionlion', constraints), false);
  assert.equal(fitsConstraints('in', constraints), false);
  assert.equal(fitsConstraints('cat', questionConstraints('Name a 4-letter word')), false);
  assert.equal(fitsConstraints('Boston', questionConstraints('Name a city ending in ton')), true);
});

test('whole batch persists across service instances and hits cache without a second provider call', async () => {
  const store = new MemoryStore(), session = new MemoryStore(); let calls = 0;
  const generate = createGenerator((async () => { calls++; return jsonResponse(); }) as typeof fetch);
  const first = new AnswerCache(store, session, generate);
  const generated = await first.resolve(question, [], settings, 'mock-key');
  assert.equal(generated.candidates.length, 20); assert.equal(generated.candidates[0]!.source, 'llm');
  const restarted = new AnswerCache(store, new MemoryStore(), generate);
  const reused = await restarted.resolve(' NAME A DISTILLED SPIRIT OR LIQUEUR ', [batch[0]!], settings, '');
  assert.equal(reused.candidates.length, 19); assert.equal(reused.candidates[0]!.source, 'cache');
  assert.equal(calls, 1); assert.equal(reused.requests, 1); assert.equal(reused.cacheHits, 1);
});

test('simultaneous identical cache keys share a request even with different used lists', async () => {
  let calls = 0;
  let finish!: (result: GeneratedCandidate[]) => void;
  const cache = new AnswerCache(new MemoryStore(), new MemoryStore(), async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const one = cache.resolve(question, [], settings, 'mock');
  const two = cache.resolve(question, [batch[0]!], settings, 'mock');
  for (let i = 0; i < 20 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 1));
  finish(batch.map(text => ({ text })));
  const [a, b] = await Promise.all([one, two]);
  assert.equal(calls, 1); assert.equal(a.candidates.length, 20); assert.equal(b.candidates.length, 19);
});

test('actual acceptance promotes history; invalid is scoped and distinct from an excluded duplicate', async () => {
  const store = new MemoryStore(), session = new MemoryStore(); let calls = 0;
  const generate = async () => { calls++; return [{ text: 'Gin' }, { text: 'Rum' }, { text: 'Vodka' }]; };
  const cache = new AnswerCache(store, session, generate);
  await cache.resolve(question, [], settings, 'mock');
  await cache.record(question, 'Rum', 'accepted');
  const confirmed = await new AnswerCache(store, session, generate).resolve(question, [], settings, '');
  assert.equal(confirmed.candidates[0]!.source, 'history'); assert.equal(confirmed.candidates[0]!.text, 'Rum');
  await cache.record(question, 'Gin', 'invalid');
  const filtered = await cache.resolve(question, ['Rum', 'Vodka'], settings, '', false);
  assert.deepEqual(filtered.candidates, []);
  const nextRound = await cache.resolve(question, ['Rum'], settings, '');
  assert.deepEqual(nextRound.candidates.map(a => a.text), ['Vodka']);
  // A duplicate/used answer is excluded only for the caller, not permanently invalidated.
  const allAvailable = await cache.resolve(question, ['Rum'], settings, '');
  assert.ok(allAvailable.candidates.some(a => a.text === 'Vodka'));
  const otherQuestion = await cache.resolve('Name a spirit starting with G', [], settings, 'mock');
  assert.ok(otherQuestion.candidates.some(a => a.text === 'Gin')); assert.equal(calls, 2);
});

test('cache identity includes provider/model/schema and preserves question restrictions', () => {
  assert.equal(cacheKey(question, settings), cacheKey(question.toUpperCase(), settings));
  assert.notEqual(cacheKey(question, settings), cacheKey(question + ' starting with G', settings));
  assert.notEqual(cacheKey(question, settings), cacheKey(question, { ...settings, model: 'another' }));
  assert.notEqual(cacheKey(question, settings), cacheKey(question, { ...settings, baseUrl: 'https://other.example/v1' }));
  assert.match(cacheKey(question, settings), /krillion-text-candidates-v1/);
});

test('expiry refreshes generated answers and current facts expire sooner', async () => {
  let now = 100000, calls = 0;
  const cache = new AnswerCache(new MemoryStore(), new MemoryStore(), async () => { calls++; return [{ text: 'Answer' }]; }, () => now);
  const current = 'Name a current Fortune 500 CEO';
  await cache.resolve(current, [], settings, 'mock');
  await cache.resolve(question, [], settings, 'mock');
  now += 2 * 60 * 60 * 1000;
  await cache.resolve(current, [], settings, 'mock');
  await cache.resolve(question, [], settings, 'mock');
  assert.equal(calls, 3); assert.equal(suggestionTtlMs(current), 3600000); assert.equal(suggestionTtlMs(question), 86400000);
});

test('provider failures are redacted, not cached as answers, and do not trigger rapid retries', async () => {
  const store = new MemoryStore(); let calls = 0;
  const generate = createGenerator((async () => { calls++; return new Response('secret echoed in provider body', { status: 401 }); }) as typeof fetch);
  const cache = new AnswerCache(store, new MemoryStore(), generate);
  const error = await cache.resolve(question, [], settings, 'mock-secret');
  assert.match(error.message, /HTTP 401/); assert.ok(!error.message.includes('secret'));
  assert.equal(store.data.has(cacheKey(question, settings)), false);
  await cache.resolve(question, [], settings, 'mock-secret'); assert.equal(calls, 1);
});

test('missing key or disabled generation makes no request; settings refuse unsafe URLs', async () => {
  let calls = 0;
  const cache = new AnswerCache(new MemoryStore(), new MemoryStore(), async () => { calls++; return []; });
  await cache.resolve(question, [], settings, '');
  await cache.resolve(question, [], { ...settings, enabled: false }, 'mock');
  assert.equal(calls, 0);
  assert.throws(() => validateSettings({ ...settings, baseUrl: 'https://user:password@api.example/v1' }));
  assert.throws(() => validateSettings({ ...settings, baseUrl: 'http://api.example/v1' }));
});

test('cached candidates are consumed before topping up and exhausted network allowance makes no call', async () => {
  let calls = 0;
  const cache = new AnswerCache(new MemoryStore(), new MemoryStore(), async () => {
    calls++; return calls === 1 ? [{ text: 'Gin' }, { text: 'Rum' }] : [{ text: 'Vodka' }];
  });
  await cache.resolve(question, [], settings, 'mock');
  const cached = await cache.resolve(question, ['Gin'], settings, 'mock');
  assert.equal(cached.candidates[0]!.text, 'Rum'); assert.equal(calls, 1);
  const blocked = await cache.resolve(question, ['Gin', 'Rum'], settings, 'mock', false);
  assert.deepEqual(blocked.candidates, []); assert.equal(calls, 1);
  const topup = await cache.resolve(question, ['Gin', 'Rum'], settings, 'mock');
  assert.equal(topup.candidates[0]!.text, 'Vodka'); assert.equal(calls, 2);
});

test('timeout is bounded and reported without leaking credentials', async () => {
  const generate = createGenerator((async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('cancelled')));
  })) as typeof fetch);
  await assert.rejects(generate({ prompt: question, excluded: [] }, { ...settings, timeoutMs: 5 }, 'mock-secret'), /timed out after 5 ms/);
});
