import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundRequest, ExtensionRequestError, extensionErrorMessage } from '../src/extension/messaging.js';

test('background messaging diagnoses invalidated contexts, unavailable workers, and storage failures safely', async () => {
  const original = globalThis.chrome;
  let response: unknown;
  let failure: Error | undefined;
  globalThis.chrome = { runtime: { sendMessage: async () => {
    if (failure) throw failure;
    return response;
  } } } as unknown as typeof chrome;
  try {
    response = { saved: true };
    assert.deepEqual(await backgroundRequest({ type: 'KRILLIONBOT_RECORD' }), { saved: true });
    for (const [error, expected] of [
      ['Extension context invalidated.', /Refresh the Krillion tab/],
      ['Could not establish connection. Receiving end does not exist.', /background is unavailable/],
      ['The message port closed before a response was received.', /background is unavailable/],
      ['QUOTA_BYTES quota exceeded', /storage is full/],
      ['Access to storage is not allowed from this context.', /storage access was denied/],
    ] as const) {
      failure = new Error(error);
      await assert.rejects(backgroundRequest({}), (value: unknown) => {
        assert.ok(value instanceof ExtensionRequestError);
        assert.match(value.message, expected);
        return true;
      });
    }
    failure = undefined;
    response = undefined;
    await assert.rejects(backgroundRequest({}), /background is unavailable/);
    response = { error: 'QUOTA_BYTES quota exceeded' };
    await assert.rejects(backgroundRequest({}), /storage is full/);
    response = { error: 'Sensitive provider error: mock-secret' };
    await assert.rejects(backgroundRequest({}), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('mock-secret'));
      return true;
    });
    assert.ok(!extensionErrorMessage(new Error('Extension context invalidated: mock-secret')).includes('mock-secret'));
  } finally { globalThis.chrome = original; }
});
