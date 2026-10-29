import assert from 'node:assert/strict';
import test from 'node:test';
import { DiagnosticLog, diagnosticLevel, DIAGNOSTICS_KEY, LOG_BYTES, LOG_LIMIT } from '../src/extension/diagnostics.js';

function fixture() {
  const data = new Map<string, unknown>();
  const store = { get: async (key: string) => structuredClone(data.get(key)),
    set: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); } };
  return { data, store, log: new DiagnosticLog(store) };
}

test('diagnostic history serializes concurrent writes, survives restart, scrubs private fields and clears independently', async () => {
  const { data, store, log } = fixture();
  data.set('unrelated', 'retain');
  await Promise.all(Array.from({ length: 10 }, (_, i) => log.append({ level: 'warning', event: 'submission.recovery',
    message: `Retry ${i}`, context: { prompt: 'Name a pasta dish', answer: 'First', apiKey: 'private-key',
      nested: { authorization: 'private-header', inputValue: 'manual text', chat: ['private chat'],
        failure: { kind: 'timeout', status: 429, retryAfterMs: 250 }, tokenLimit: 400 },
      hint: 'Bearer secret-token sk-example123 https://example.com/?key=secret' } }, { tabId: 7, frameId: 0 })));
  const secretLog = new DiagnosticLog(store, async () => ['custom-provider-credential']);
  await secretLog.append({ level: 'error', event: 'exception', message: 'Request failed: custom-provider-credential',
    context: { stack: 'Error custom-provider-credential at worker.js:5' } });
  const entries = await new DiagnosticLog(store).read();
  assert.equal(entries.length, 11);
  assert.equal(entries[0]!.tabId, 7); assert.equal(entries[0]!.version, '0.3.6');
  assert.ok(Number.isFinite(Date.parse(entries[0]!.at)));
  const serialized = JSON.stringify(entries);
  for (const secret of ['private-key', 'private-header', 'manual text', 'private chat', 'secret-token', 'sk-example123', '?key=secret', 'custom-provider-credential']) {
    assert.ok(!serialized.includes(secret), secret);
  }
  assert.match(serialized, /retryAfterMs/); assert.match(serialized, /First/);
  await log.clear(); assert.deepEqual(await log.read(), []); assert.equal(data.get('unrelated'), 'retain');
});

test('diagnostic history is bounded by entry count and byte budget', async () => {
  const { log } = fixture();
  for (let i = 0; i < LOG_LIMIT + 5; i++) await log.append({ level: 'info', event: 'test', message: `${i}` });
  let entries = await log.read();
  assert.equal(entries.length, LOG_LIMIT); assert.equal(entries[0]!.message, '5');
  for (let i = 0; i < 150; i++) await log.append({ level: 'error', event: 'large', message: 'Unexpected state',
    context: { values: Array.from({ length: 5 }, () => '🐡'.repeat(500)) } });
  entries = await log.read();
  assert.ok(Buffer.byteLength(JSON.stringify(entries)) <= LOG_BYTES);
  assert.ok(entries.length < LOG_LIMIT);
});

test('log write errors propagate without poisoning subsequent writes and malformed entries are rejected', async () => {
  const { data, store } = fixture();
  let fail = true;
  const log = new DiagnosticLog({ ...store, set: async (key, value) => {
    if (fail) { fail = false; throw new Error('storage full'); }
    await store.set(key, value);
  } });
  await assert.rejects(log.append({ level: 'error', event: 'test', message: 'Failure' }), /storage full/);
  await log.append({ level: 'warning', event: 'test', message: 'Retry' });
  assert.equal((await log.read()).length, 1);
  await assert.rejects(log.append({ level: 'bad' }), /Invalid diagnostic/);
  assert.ok(data.has(DIAGNOSTICS_KEY));
  assert.equal(diagnosticLevel('Three attempts this turn. Manual entry is available.'), 'warning');
  assert.equal(diagnosticLevel('Fallback failed.'), 'error');
  assert.equal(diagnosticLevel('Ready; waiting for your turn'), undefined);
});
