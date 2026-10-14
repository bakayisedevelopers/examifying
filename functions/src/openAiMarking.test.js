import test from 'node:test';
import assert from 'node:assert/strict';
import { callOpenAiMarkingOnce } from './openAiMarking.js';

const withOpenAiEnv = async (callback) => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'unit-test-openai-key';
  try {
    await callback();
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
};

const call = async ({ contextPages, questions, answerText }) => {
  let request;
  const result = await callOpenAiMarkingOnce({
    submissionType: 'student_exercise',
    contextPages,
    questions,
    answerImages: [{ pageNumber: 1, dataUrl: `data:image/jpeg;base64,${answerText}` }],
    clientFactory: () => ({ responses: { create: async (payload) => {
      request = payload;
      return {
        output_text: '{"status":"unclear_images","results":[]}',
        model: 'gpt-6-luna',
        usage: {
          input_tokens: 2000,
          output_tokens: 10,
          total_tokens: 2010,
          input_tokens_details: { cached_tokens: 1200, cache_write_tokens: 800 },
        },
      };
    } } }),
  });
  return { request, result };
};

test('Luna caches only the shared exam-page prefix and leaves answer images uncached', async () => {
  await withOpenAiEnv(async () => {
    const { request, result } = await call({
      contextPages: [{ paperId: 'paper-a', pageNumber: 3, dataUrl: 'data:image/jpeg;base64,c291cmNl' }],
      questions: [{ questionId: 'paper-a::1.1', paperId: 'paper-a', questionNumber: '1.1', topic: 'Algebra', maximumMark: 2 }],
      answerText: 'c3R1ZGVudC1hbnN3ZXI=',
    });

    assert.equal(request.prompt_cache_options.mode, 'explicit');
    assert.equal(request.prompt_cache_options.ttl, '30m');
    assert.match(request.prompt_cache_key, /^examifying-ai-marking-v1-[a-f0-9]{32}$/);
    assert.equal(request.input[1].role, 'user');
    assert.equal(request.input[1].content.at(-1).prompt_cache_breakpoint.mode, 'explicit');
    assert.match(request.input[1].content[0].text, /paper-a, page 3/);
    assert.doesNotMatch(JSON.stringify(request.input[1]), /c3R1ZGVudC1hbnN3ZXI=/);
    assert.match(JSON.stringify(request.input[2]), /c3R1ZGVudC1hbnN3ZXI=/);
    assert.equal(result.usage.cachedInputTokens, 1200);
    assert.equal(result.usage.cacheWriteTokens, 800);
  });
});

test('Luna uses the same stable cache key for the same paper context across submissions', async () => {
  await withOpenAiEnv(async () => {
    const contextPages = [{ paperId: 'paper-a', pageNumber: 3, dataUrl: 'data:image/jpeg;base64,c291cmNl' }];
    const first = await call({ contextPages, questions: [], answerText: 'Zmlyc3Q=' });
    const second = await call({ contextPages, questions: [], answerText: 'c2Vjb25k' });
    assert.equal(first.request.prompt_cache_key, second.request.prompt_cache_key);
    assert.notEqual(JSON.stringify(first.request.input[2].content), JSON.stringify(second.request.input[2].content));
  });
});

test('Luna does not write a cache when the task has no shared source pages', async () => {
  await withOpenAiEnv(async () => {
    const { request } = await call({ contextPages: [], questions: [], answerText: 'c3R1ZGVudA==' });
    assert.equal('prompt_cache_options' in request, false);
    assert.equal('prompt_cache_key' in request, false);
    assert.equal(request.input.length, 2);
  });
});
