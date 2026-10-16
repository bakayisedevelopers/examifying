import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReadyPeerWorkPack, publishPeerWorkWithRetry, selectSystemPeerWorkImages } from './peerWorkPublishCore.js';

test('publication reloads generated images instead of using a stale pre-generation pack snapshot', async () => {
  const savedImages = [{ questionId: 'paper-a::1.1', storagePath: 'pack/question-1.png' }];
  const stalePack = {
    id: 'pack-a',
    status: 'generating',
    ref: { get: async () => ({ exists: true, data: () => ({ status: 'ready', images: savedImages }) }) },
  };

  const readyPack = await loadReadyPeerWorkPack(stalePack);

  assert.equal(readyPack.status, 'ready');
  assert.deepEqual(readyPack.images, savedImages);
});

test('publication refuses to publish a missing or incomplete generated pack', async () => {
  await assert.rejects(() => loadReadyPeerWorkPack({
    ref: { get: async () => ({ exists: false }) },
  }), /unavailable for publication/);
  await assert.rejects(() => loadReadyPeerWorkPack({
    ref: { get: async () => ({ exists: true, data: () => ({ status: 'generating', images: [] }) }) },
  }), /not ready for publication/);
});

test('legacy reusable packs match question images when questionId is absent', () => {
  const image = { questionReference: '4.2', storagePath: 'pack/question-1.png' };
  const selected = selectSystemPeerWorkImages({
    pack: { paperId: 'paper-a', images: [image] },
    questionLinks: [{ paperId: 'paper-a', questionReference: '4.2' }],
  });
  assert.deepEqual(selected, [image]);
});

test('reusable pack image selection returns images in question order and rejects missing questions', () => {
  const first = { questionId: 'paper-a::1.1', storagePath: 'pack/question-1.png' };
  const second = { questionId: 'paper-a::1.2', storagePath: 'pack/question-2.png' };
  const pack = { images: [first, second] };
  assert.deepEqual(selectSystemPeerWorkImages({
    pack,
    questionLinks: [
      { questionId: 'paper-a::1.2' },
      { questionId: 'paper-a::1.1' },
    ],
  }), [second, first]);
  assert.throws(() => selectSystemPeerWorkImages({
    pack,
    questionLinks: [{ paperId: 'paper-a', questionReference: '1.3' }],
  }), /missing a question image/);
});

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
