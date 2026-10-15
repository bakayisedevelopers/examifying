import test from 'node:test';
import assert from 'node:assert/strict';
import { publishPeerWorkWithRetry } from './peerWorkPublishCore.js';

test('peer-work publishing retries a transient failure and returns the successful result', async () => {
  let calls = 0;
  const delays = [];
  const retries = [];

  const result = await publishPeerWorkWithRetry({
    publish: async () => {
      calls += 1;
      if (calls < 3) throw new Error('temporary storage failure');
      return 'published';
    },
    retryDelayMs: 100,
    delay: async (milliseconds) => delays.push(milliseconds),
    onRetry: (_error, attempt) => retries.push(attempt),
  });

  assert.equal(result, 'published');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
  assert.deepEqual(retries, [1, 2]);
});

test('peer-work publishing stops after the bounded attempt count', async () => {
  let calls = 0;
  const failure = new Error('permanent storage failure');

  await assert.rejects(() => publishPeerWorkWithRetry({
    publish: async () => {
      calls += 1;
      throw failure;
    },
    maxAttempts: 3,
    delay: async () => {},
  }), failure);

  assert.equal(calls, 3);
});

test('successful peer-work publishing runs only once', async () => {
  let calls = 0;
  const result = await publishPeerWorkWithRetry({
    publish: async () => { calls += 1; return true; },
    delay: async () => assert.fail('successful publish should not wait'),
  });

  assert.equal(result, true);
  assert.equal(calls, 1);
});
