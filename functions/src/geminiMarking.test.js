import test from 'node:test';
import assert from 'node:assert/strict';
import { callGeminiMarkingOnce, GEMINI_MARKING_MODEL } from './geminiMarking.js';
import { resetGeminiContextCacheForTests } from './geminiContextCache.js';

const withGeminiEnv = async (callback) => {
  const original = {
    key: process.env.GEMINI_API_KEY,
    baseUrl: process.env.GEMINI_BASE_URL,
  };
  process.env.GEMINI_API_KEY = 'unit-test-gemini-key';
  process.env.GEMINI_BASE_URL = 'https://gemini.example.test/v1beta';
  try {
    await callback();
  } finally {
    if (original.key === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = original.key;
    if (original.baseUrl === undefined) delete process.env.GEMINI_BASE_URL;
    else process.env.GEMINI_BASE_URL = original.baseUrl;
  }
};

test('sends a compact structured marking request to Gemini Flash-Lite', async () => {
  resetGeminiContextCacheForTests();
  await withGeminiEnv(async () => {
    let call;
    const result = await callGeminiMarkingOnce({
      submissionType: 'student_exercise',
      questions: [{ questionId: 'paper-a::1.1', paperId: 'paper-a', questionNumber: '1.1', topic: 'Algebra', maximumMark: 2 }],
      contextPages: [{ paperId: 'paper-a', pageNumber: 3, dataUrl: 'data:image/jpeg;base64,AA==' }],
      answerImages: [{ pageNumber: 1, dataUrl: 'data:image/jpeg;base64,AQ==' }],
      fetchImpl: async (url, options) => {
        call = { url, options, body: JSON.parse(options.body) };
        return {
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '{"status":"completed","results":[{"questionId":"paper-a::1.1","awardedMark":1}],"contextRequests":[],"unansweredQuestionIds":[],"annotations":[]}' }] } }],
            usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 12, totalTokenCount: 92 },
          }),
        };
      },
    });

    assert.equal(call.url, `https://gemini.example.test/v1beta/models/${GEMINI_MARKING_MODEL}:generateContent`);
    assert.equal(call.options.headers['x-goog-api-key'], 'unit-test-gemini-key');
    assert.equal(new URL(call.url).search, '');
    assert.equal(call.body.generationConfig.maxOutputTokens, 2048);
    assert.equal(call.body.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
    assert.equal(call.body.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
    assert.deepEqual(Object.keys(call.body.generationConfig.responseFormat.text.schema.properties), ['status', 'results', 'contextRequests', 'unansweredQuestionIds', 'annotations']);
    assert.deepEqual(Object.keys(call.body.generationConfig.responseFormat.text.schema.properties.results.items.properties), ['questionId', 'awardedMark']);
    assert.deepEqual(Object.keys(call.body.generationConfig.responseFormat.text.schema.properties.annotations.items.properties), [
      'questionId', 'questionNumber', 'imageIndex', 'type', 'x', 'y', 'stepId', 'confidence',
    ]);
    assert.equal(call.body.contents[0].parts.filter((part) => part.inline_data).length, 2);
    assert.deepEqual(call.body.contents[0].parts.filter((part) => part.inline_data)
      .map((part) => part.media_resolution.level), ['MEDIA_RESOLUTION_ULTRA_HIGH', 'MEDIA_RESOLUTION_ULTRA_HIGH']);
    assert.equal(result.status, 'completed');
    assert.equal(result.model, 'gemini-3.5-flash-lite');
    assert.equal(result.usage.totalTokens, 92);
  });
});

test('peer-marking request carries both original work and marker images', async () => {
  resetGeminiContextCacheForTests();
  await withGeminiEnv(async () => {
    let requestBody;
    await callGeminiMarkingOnce({
      submissionType: 'peer_marking',
      questions: [],
      contextPages: [],
      originalAnswerImages: [{ pageNumber: 2, dataUrl: 'data:image/jpeg;base64,AA==' }],
      answerImages: [{ pageNumber: 1, dataUrl: 'data:image/jpeg;base64,AQ==' }],
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"status":"unclear_images","results":[],"contextRequests":[],"unansweredQuestionIds":[],"annotations":[]}' }] } }] }) };
      },
    });
    const parts = requestBody.contents[0].parts;
    assert.match(parts[0].text, /return one AI annotation beside each visible decision/i);
    assert.match(parts[0].text, /Use imageIndex 0 for the first peer marker image/i);
    assert.match(requestBody.system_instruction.parts[0].text, /reviewing a learner's marking/i);
    assert.match(requestBody.system_instruction.parts[0].text, /VISUAL PEER-MARKING REVIEW ANNOTATIONS/i);
    assert.equal(parts.filter((part) => part.inline_data).length, 2);
    assert.match(parts[1].text, /Original learner answer image 2/);
    assert.match(parts[3].text, /Peer marker's submitted marking image 1/);
    assert.match(parts[3].text, /imageIndex=0/);
  });
});

test('repairs fenced or lightly malformed Gemini JSON before authoritative response validation', async () => {
  resetGeminiContextCacheForTests();
  await withGeminiEnv(async () => {
    const result = await callGeminiMarkingOnce({
      submissionType: 'peer_marking',
      questions: [],
      contextPages: [],
      originalAnswerImages: [],
      answerImages: [],
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{
          text: '```json\n{"status":"completed","results":[],"contextRequests":[],"unansweredQuestionIds":[],"annotations":[],}\n```',
        }] } }] }),
      }),
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.annotations, []);
  });
});

test('Gemini source labels distinguish fallback memos from full question papers', async () => {
  resetGeminiContextCacheForTests();
  await withGeminiEnv(async () => {
    let requestBody;
    await callGeminiMarkingOnce({
      submissionType: 'student_exercise',
      contextPass: 'memo_search',
      questions: [{ questionId: 'paper-a::1.1', paperId: 'paper-a', questionNumber: '1.1', topic: 'Algebra', maximumMark: 2 }],
      contextPages: [{ paperId: 'paper-a', pageNumber: 2, documentType: 'memo', dataUrl: 'data:image/jpeg;base64,AA==' }],
      answerImages: [],
      suppliedMaterialsByQuestion: { 'paper-a::1.1': ['analysis_pages', 'memo'] },
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"status":"completed","results":[{"questionId":"paper-a::1.1","awardedMark":1}],"contextRequests":[],"unansweredQuestionIds":[]}' }] } }] }) };
      },
    });
    assert.match(requestBody.contents[0].parts[0].text, /Official marking memo paper-a, page 2/);
    assert.match(requestBody.contents[0].parts[1].inline_data.mime_type, /image/);
  });
});

test('Gemini errors are reported without including the API key', async () => {
  resetGeminiContextCacheForTests();
  await withGeminiEnv(async () => {
    await assert.rejects(callGeminiMarkingOnce({
      submissionType: 'student_exercise',
      fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { status: 'RESOURCE_EXHAUSTED' } }) }),
    }), (error) => error.status === 429 && error.code === 'resource_exhausted'
      && !error.message.includes('unit-test-gemini-key'));
  });
});

test('Gemini explicitly caches shared paper pages but excludes student answer images', async () => {
  resetGeminiContextCacheForTests();
  await withGeminiEnv(async () => {
    const requests = [];
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (url.endsWith('/cachedContents')) {
        return {
          ok: true,
          json: async () => ({ name: 'cachedContents/paper-context', expireTime: new Date(Date.now() + 300_000).toISOString(), usageMetadata: { totalTokenCount: 1100 } }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"status":"unclear_images","results":[],"contextRequests":[],"unansweredQuestionIds":[]}' }] } }],
          usageMetadata: { promptTokenCount: 510, candidatesTokenCount: 10, totalTokenCount: 520, cachedContentTokenCount: 1100 },
        }),
      };
    };
    const result = await callGeminiMarkingOnce({
      submissionType: 'student_exercise',
      contextPages: [{ paperId: 'paper-a', pageNumber: 2, dataUrl: 'data:image/jpeg;base64,c291cmNl' }],
      questions: [{ questionId: 'paper-a::1.1', paperId: 'paper-a', questionNumber: '1.1', topic: 'Algebra', maximumMark: 2 }],
      answerImages: [{ pageNumber: 1, dataUrl: 'data:image/jpeg;base64,c3R1ZGVudC1hbnN3ZXI=' }],
      fetchImpl,
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].url.endsWith('/cachedContents'), true);
    assert.equal(requests[0].body.ttl, '300s');
    assert.equal(requests[0].body.model, `models/${GEMINI_MARKING_MODEL}`);
    assert.equal(requests[0].body.contents[0].parts.filter((part) => part.inline_data).length, 1);
    assert.doesNotMatch(JSON.stringify(requests[0].body), /c3R1ZGVudC1hbnN3ZXI=/);
    assert.equal(requests[1].body.cachedContent, 'cachedContents/paper-context');
    assert.equal(requests[1].body.contents[0].parts.filter((part) => part.inline_data).length, 1);
    assert.doesNotMatch(JSON.stringify(requests[1].body), /c291cmNl/);
    assert.match(JSON.stringify(requests[1].body), /c3R1ZGVudC1hbnN3ZXI=/);
    assert.equal(result.contextCacheStatus, 'created');
    assert.equal(result.usage.cachedInputTokens, 1100);
    assert.equal(result.usage.cacheWriteTokens, 1100);
  });
});

test('Gemini reuses a live context cache for another submission with the same source pages', async () => {
  resetGeminiContextCacheForTests();
  await withGeminiEnv(async () => {
    let cacheCreates = 0;
    let generationRequests = 0;
    const fetchImpl = async (url, options) => {
      if (url.endsWith('/cachedContents')) {
        cacheCreates += 1;
        return { ok: true, json: async () => ({ name: 'cachedContents/shared-paper', expireTime: new Date(Date.now() + 300_000).toISOString() }) };
      }
      generationRequests += 1;
      assert.equal(JSON.parse(options.body).cachedContent, 'cachedContents/shared-paper');
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"status":"unclear_images","results":[],"contextRequests":[],"unansweredQuestionIds":[]}' }] } }] }) };
    };
    const common = {
      submissionType: 'student_exercise',
      contextPages: [{ paperId: 'paper-b', pageNumber: 4, dataUrl: 'data:image/jpeg;base64,cGFnZQ==' }],
      questions: [],
      fetchImpl,
    };
    const first = await callGeminiMarkingOnce({ ...common, answerImages: [{ dataUrl: 'data:image/jpeg;base64,YW5zd2VyMQ==' }] });
    const second = await callGeminiMarkingOnce({ ...common, answerImages: [{ dataUrl: 'data:image/jpeg;base64,YW5zd2VyMg==' }] });
    assert.equal(first.contextCacheStatus, 'created');
    assert.equal(second.contextCacheStatus, 'hit');
    assert.equal(cacheCreates, 1);
    assert.equal(generationRequests, 2);
  });
});

test('Gemini cache creation failure safely falls back to a regular Gemini request', async () => {
  resetGeminiContextCacheForTests();
  await withGeminiEnv(async () => {
    const requests = [];
    const result = await callGeminiMarkingOnce({
      submissionType: 'student_exercise',
      contextPages: [{ paperId: 'paper-c', pageNumber: 1, dataUrl: 'data:image/jpeg;base64,cGFnZQ==' }],
      questions: [],
      answerImages: [],
      fetchImpl: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return url.endsWith('/cachedContents')
          ? { ok: false, status: 400, json: async () => ({ error: { status: 'INVALID_ARGUMENT' } }) }
          : { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"status":"unclear_images","results":[],"contextRequests":[],"unansweredQuestionIds":[]}' }] } }] }) };
      },
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.cachedContent, undefined);
    assert.equal(requests[1].body.contents[0].parts.some((part) => part.inline_data), true);
    assert.equal(result.contextCacheStatus, 'unavailable');
    assert.equal(result.status, 'unclear_images');
  });
});

test('Gemini retries uncached if a previously cached context is rejected or expired', async () => {
  resetGeminiContextCacheForTests();
  await withGeminiEnv(async () => {
    let generationCalls = 0;
    const result = await callGeminiMarkingOnce({
      submissionType: 'student_exercise',
      contextPages: [{ paperId: 'paper-d', pageNumber: 2, dataUrl: 'data:image/jpeg;base64,cGFnZQ==' }],
      questions: [],
      answerImages: [],
      fetchImpl: async (url, options) => {
        if (url.endsWith('/cachedContents')) {
          return { ok: true, json: async () => ({ name: 'cachedContents/expired', expireTime: new Date(Date.now() + 300_000).toISOString() }) };
        }
        generationCalls += 1;
        if (generationCalls === 1) return { ok: false, status: 404, json: async () => ({ error: { status: 'NOT_FOUND' } }) };
        const body = JSON.parse(options.body);
        assert.equal(body.cachedContent, undefined);
        assert.equal(body.contents[0].parts.some((part) => part.inline_data), true);
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"status":"unclear_images","results":[],"contextRequests":[],"unansweredQuestionIds":[]}' }] } }] }) };
      },
    });
    assert.equal(generationCalls, 2);
    assert.equal(result.contextCacheStatus, 'rejected_retry_uncached');
    assert.equal(result.contextCacheUsed, false);
  });
});
