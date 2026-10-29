import assert from 'node:assert/strict';
import test from 'node:test';
import { AnswerCache, type KeyValueStore } from '../src/llm/cache.js';
import { ProviderError, retryAfterMs } from '../src/llm/failure.js';
import { createGenerator, DEFAULT_SETTINGS, validateSettings, type Generate } from '../src/llm/provider.js';
import { generateWithRetries, LookupError } from '../src/llm/retry.js';

const question = 'Name an English word containing “work”';
const config = { ...DEFAULT_SETTINGS, enabled: true, model: 'mock-model', timeoutMs: 2000 };
class MemoryStore implements KeyValueStore {
  data = new Map<string, unknown>();
  async get(key: string) { return structuredClone(this.data.get(key)); }
  async set(key: string, value: unknown) { this.data.set(key, structuredClone(value)); }
}

test('the reported 2-second timeout recovers with larger per-attempt deadlines', async () => {
  let now = 0, calls = 0; const timeouts: number[] = [], progress: string[] = [];
  const result = await generateWithRetries(async (_request, settings) => {
    timeouts.push(settings.timeoutMs); calls++;
    if (calls < 3) { now += settings.timeoutMs; throw new ProviderError('timeout', `LLM timed out after ${settings.timeoutMs} ms.`, true); }
    return [{ text: 'workshop' }, { text: 'network' }];
  }, { prompt: question, excluded: [] }, config, 'mock', {
    now: () => now, random: () => 0, sleep: async ms => { now += ms; },
    onProgress: event => progress.push(event.message),
  });
  assert.deepEqual(timeouts, [2000, 4000, 8000]); assert.equal(result.attempts.length, 3);
  assert.deepEqual(result.candidates.map(a => a.text), ['workshop', 'network']);
  assert.ok(progress.some(line => line.includes('Retrying attempt 2/3'))); assert.ok(now <= 15000);
  const { cleanCandidates } = await import('../src/llm/provider.js');
  assert.deepEqual(cleanCandidates({ candidates: ['workshop', 'network', 'orange'] }, question).map(a => a.text), ['workshop', 'network']);
});

test('429 honors Retry-After, including HTTP dates, before retrying', async () => {
  let now = 100000, calls = 0; const waits: number[] = [];
  const result = await generateWithRetries(async () => {
    if (++calls === 1) throw new ProviderError('rate-limit', 'LLM HTTP 429.', true, 429, 1800);
    return [{ text: 'workshop' }];
  }, { prompt: question, excluded: [] }, config, 'mock', {
    now: () => now, random: () => 0, sleep: async ms => { waits.push(ms); now += ms; },
  });
  assert.deepEqual(waits, [1800]); assert.equal(result.attempts.length, 2);
  assert.equal(retryAfterMs('2', 0), 2000);
  assert.equal(retryAfterMs(new Date(10000).toUTCString(), 5000), 5000);
  assert.equal(retryAfterMs('invalid'), undefined);
});

test('short backoff leaves enough budget for a successful retry without shortening request deadlines', async () => {
  let now = 0, calls = 0;
  const waits: number[] = [], deadlines: number[] = [];
  const result = await generateWithRetries(async (_request, settings) => {
    deadlines.push(settings.timeoutMs);
    if (++calls === 1) throw new ProviderError('server', 'LLM HTTP 503.', true, 503);
    const responseTime = 850;
    now += Math.min(responseTime, settings.timeoutMs);
    if (settings.timeoutMs < responseTime) throw new ProviderError('timeout', 'LLM timeout.', true);
    return [{ text: 'workshop' }];
  }, { prompt: question, excluded: [] }, { ...config, timeoutMs: 1000, retryBudgetMs: 1000 }, 'mock', {
    now: () => now, random: () => 0, sleep: async ms => { waits.push(ms); now += ms; },
  });
  assert.deepEqual(waits, [100]);
  assert.deepEqual(deadlines, [1000, 900]);
  assert.equal(now, 950);
  assert.equal(result.candidates[0]!.text, 'workshop');
});

test('transient retries use 100/200 ms backoff with bounded jitter', async () => {
  for (const jitter of [0, 1]) {
    let calls = 0;
    const waits: number[] = [];
    await generateWithRetries(async () => {
      if (++calls < 3) throw new ProviderError('network', 'LLM connection failed.', true);
      return [{ text: 'workshop' }];
    }, { prompt: question, excluded: [] }, config, 'mock', {
      now: () => 0, random: () => jitter, sleep: async ms => { waits.push(ms); },
    });
    assert.deepEqual(waits, jitter ? [125, 250] : [100, 200]);
  }
});

test('failed lookup cooldown permits a new batch after 250 ms and prevents an immediate duplicate', async () => {
  let now = 1000, calls = 0;
  const cache = new AnswerCache(new MemoryStore(), new MemoryStore(), async () => {
    if (++calls === 1) throw new ProviderError('server', 'LLM HTTP 503.', true, 503);
    return [{ text: 'workshop' }];
  }, () => now);
  const settings = { ...config, maxAttempts: 1 };
  const first = await cache.resolve(question, [], settings, 'mock');
  assert.equal(first.retryAt, 1250);
  now = 1249;
  await cache.resolve(question, [], settings, 'mock');
  assert.equal(calls, 1);
  now = 1250;
  const recovered = await cache.resolve(question, [], settings, 'mock');
  assert.equal(calls, 2);
  assert.equal(recovered.candidates[0]!.text, 'workshop');
});

test('rate-limit delays longer than the total budget stop without premature retry', async () => {
  let calls = 0;
  await assert.rejects(generateWithRetries(async () => {
    calls++; throw new ProviderError('rate-limit', 'LLM HTTP 429.', true, 429, 60000);
  }, { prompt: question, excluded: [] }, config, 'mock', { sleep: async () => assert.fail('must not wait/retry') }), error => {
    assert.ok(error instanceof LookupError); assert.equal(error.failure.retryAfterMs, 60000); return true;
  });
  assert.equal(calls, 1);
});

test('hard total deadline and attempt count bound repeated transient failures', async () => {
  let now = 0, calls = 0;
  await assert.rejects(generateWithRetries(async (_request, settings) => {
    calls++; now += settings.timeoutMs; throw new ProviderError('timeout', 'LLM timeout.', true);
  }, { prompt: question, excluded: [] }, { ...config, retryBudgetMs: 2500 }, 'mock', {
    now: () => now, random: () => 0, sleep: async ms => { now += ms; },
  }), LookupError);
  assert.equal(calls, 2); assert.ok(now <= 2500);
});

test('auth, request, billing, malformed JSON and incomplete output are not retried', async () => {
  for (const scenario of ['auth', 'bad-request', 'quota', 'json', 'incomplete']) {
    let calls = 0;
    const generate = createGenerator((async () => {
      calls++;
      if (scenario === 'auth') return new Response('{}', { status: 401 });
      if (scenario === 'bad-request') return new Response('{}', { status: 400 });
      if (scenario === 'quota') return new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 });
      if (scenario === 'json') return new Response('invalid JSON');
      return new Response('{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}');
    }) as typeof fetch);
    await assert.rejects(generateWithRetries(generate, { prompt: question, excluded: [] }, config, 'mock'), error => {
      assert.ok(error instanceof LookupError); assert.equal(error.failure.retryable, false); return true;
    });
    assert.equal(calls, 1, scenario);
  }
});

test('time spent checking request budgets is deducted from the next provider deadline', async () => {
  let now = 0, deadline = 0;
  await generateWithRetries(async (_request, settings) => {
    deadline = settings.timeoutMs; return [{ text: 'workshop' }];
  }, { prompt: question, excluded: [] }, { ...config, retryBudgetMs: 2500 }, 'mock', {
    now: () => now, beforeAttempt: async () => { now += 1000; },
  });
  assert.equal(deadline, 1500);
});

test('cancelling during backoff prevents the next request', async () => {
  const abort = new AbortController(); let calls = 0;
  await assert.rejects(generateWithRetries(async () => {
    calls++; throw new ProviderError('server', 'LLM HTTP 503.', true, 503);
  }, { prompt: question, excluded: [] }, config, 'mock', {
    signal: abort.signal, onProgress: event => { if (event.message.includes('Retrying')) abort.abort(); },
  }), error => { assert.ok(error instanceof LookupError); assert.equal(error.failure.kind, 'cancelled'); return true; });
  assert.equal(calls, 1);
});

test('cache retry chains deduplicate concurrent subscribers and count each HTTP attempt', async () => {
  let calls = 0;
  const cache = new AnswerCache(new MemoryStore(), new MemoryStore(), async () => {
    calls++; if (calls === 1) throw new ProviderError('server', 'LLM HTTP 503.', true, 503);
    return [{ text: 'workshop' }];
  });
  const [one, two] = await Promise.all([
    cache.resolve(question, [], config, 'mock'), cache.resolve(question, [], config, 'mock'),
  ]);
  assert.equal(calls, 2); assert.equal(one.requests, 2); assert.equal(two.requests, 2);
  assert.equal(one.diagnostics!.attempts.length, 2);
  assert.equal((await cache.resolve(question, [], config, '')).candidates[0]!.source, 'cache');
});

test('cancelling one shared subscriber preserves another; cancelling the last aborts the provider', async () => {
  let finish!: (value: { text: string }[]) => void; let providerSignal: AbortSignal | undefined;
  const generate: Generate = async request => {
    providerSignal = request.signal;
    return new Promise((resolve, reject) => {
      finish = resolve; request.signal!.addEventListener('abort', () => reject(new ProviderError('cancelled', 'LLM lookup cancelled.', false)));
    });
  };
  const cache = new AnswerCache(new MemoryStore(), new MemoryStore(), generate);
  const a = new AbortController(), b = new AbortController();
  const one = cache.resolve(question, [], config, 'mock', true, { signal: a.signal });
  const two = cache.resolve(question, [], config, 'mock', true, { signal: b.signal });
  for (let i = 0; i < 100 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 1));
  a.abort(); assert.equal((await one).diagnostics!.failure!.kind, 'cancelled');
  assert.equal(providerSignal!.aborted, false);
  finish([{ text: 'workshop' }]); assert.equal((await two).candidates[0]!.text, 'workshop');
  let lastSignal: AbortSignal | undefined;
  const stopped = new AnswerCache(new MemoryStore(), new MemoryStore(), async request => {
    lastSignal = request.signal;
    return new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new ProviderError('cancelled', 'LLM lookup cancelled.', false))));
  });
  const c = new AbortController();
  const last = stopped.resolve(question, [], config, 'mock', true, { signal: c.signal });
  for (let i = 0; i < 100 && !lastSignal; i++) await new Promise(resolve => setTimeout(resolve, 1));
  c.abort(); await last; assert.equal(lastSignal!.aborted, true);
});

test('empty completed output is distinguished from timeout and settings changes clear old failures', async () => {
  let calls = 0;
  const cache = new AnswerCache(new MemoryStore(), new MemoryStore(), async () => {
    calls++; return calls === 1 ? [] : [{ text: 'workshop' }];
  });
  const empty = await cache.resolve(question, [], config, 'mock');
  assert.equal(empty.diagnostics!.failure!.kind, 'empty'); assert.equal(empty.retryable, false);
  const recent = await cache.resolve(question, [], config, 'mock');
  assert.match(recent.message, /completed but returned zero/); assert.equal(calls, 1);
  cache.resetFailures(); const fixed = await cache.resolve(question, [], config, 'mock');
  assert.equal(fixed.candidates[0]!.text, 'workshop'); assert.equal(calls, 2);
  assert.equal(validateSettings({ ...config, maxAttempts: 1 }).maxAttempts, 1);
  assert.throws(() => validateSettings({ ...config, maxAttempts: 100 }));
});

test('provider Retry-After gate survives worker recreation and applies across questions', async () => {
  const local = new MemoryStore(), session = new MemoryStore(); let calls = 0;
  const generate: Generate = async () => { calls++; throw new ProviderError('rate-limit', 'LLM HTTP 429.', true, 429, 60000); };
  const first = new AnswerCache(local, session, generate);
  assert.equal((await first.resolve(question, [], config, 'mock')).retryable, true);
  const restarted = new AnswerCache(local, session, generate);
  const held = await restarted.resolve('Different unseeded category', [], config, 'mock');
  assert.match(held.message, /Retry-After/); assert.equal(calls, 1); assert.equal(held.networkUsed, false);
});

test('empty and non-retryable failures allow a manual retry after 2.5 seconds', async () => {
  for (const kind of ['empty', 'invalid-output', 'incomplete', 'authentication', 'request', 'quota', 'budget'] as const) {
    let now = 10000, calls = 0;
    const cache = new AnswerCache(new MemoryStore(), new MemoryStore(), async () => {
      if (++calls === 1) {
        if (kind === 'empty') return [];
        throw new ProviderError(kind, 'LLM failed.', false);
      }
      return [{ text: 'workshop' }];
    }, () => now);
    const failed = await cache.resolve(question, [], config, 'mock');
    assert.equal(failed.retryAt, 12500, kind);
    assert.equal(failed.retryable, false, 'Hard failures must not automatically repeat API calls');
    now = 12499;
    await cache.resolve(question, [], config, 'mock');
    assert.equal(calls, 1, kind);
    now = 12500;
    const retried = await cache.resolve(question, [], config, 'mock');
    assert.equal(calls, 2, kind);
    assert.equal(retried.candidates[0]!.text, 'workshop', kind);
  }
});
