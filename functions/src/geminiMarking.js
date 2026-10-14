import { AI_MARKING_RESULT_SCHEMA, PEER_MARKING_REVIEW_INSTRUCTIONS, STUDENT_EXERCISE_MARKING_INSTRUCTIONS } from './aiMarkingPrompts.js';
import { getGeminiSourceContextCache, invalidateGeminiSourceContextCache } from './geminiContextCache.js';

export const GEMINI_MARKING_MODEL = 'gemini-3.5-flash-lite';

const getSystemInstructions = (submissionType) => submissionType === 'peer_marking'
  ? PEER_MARKING_REVIEW_INSTRUCTIONS
  : STUDENT_EXERCISE_MARKING_INSTRUCTIONS;

const imagePart = (image) => {
  const match = String(image?.dataUrl ?? '').match(/^data:([^;,]+);base64,([\s\S]+)$/);
  if (!match) throw new Error('AI marking received an invalid image payload.');
  return { inline_data: { mime_type: match[1], data: match[2] } };
};

const addImages = (parts, images = [], label) => {
  images.forEach((image, index) => {
    parts.push({ text: `${label} ${image.pageNumber || index + 1}.` });
    parts.push(imagePart(image));
  });
};

const getUsage = (usage = {}) => ({
  inputTokens: Number(usage.promptTokenCount) || 0,
  outputTokens: Number(usage.candidatesTokenCount) || 0,
  totalTokens: Number(usage.totalTokenCount) || 0,
  thoughtsTokens: Number(usage.thoughtsTokenCount) || 0,
  cachedInputTokens: Number(usage.cachedContentTokenCount) || 0,
});

const providerError = (message, { code, status } = {}) => {
  const error = new Error(message);
  error.code = code || 'gemini_marking_error';
  if (Number.isFinite(status)) error.status = status;
  return error;
};

export const callGeminiMarkingOnce = async ({
  submissionType,
  questions = [],
  contextPages = [],
  originalAnswerImages = [],
  answerImages = [],
  contextPass = 'analysis_pages',
  suppliedMaterialsByQuestion = {},
  fetchImpl = globalThis.fetch,
}) => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw providerError('GEMINI_API_KEY is not configured for AI marking.', { code: 'gemini_key_missing' });
  if (typeof fetchImpl !== 'function') throw providerError('Gemini fetch is unavailable.', { code: 'gemini_fetch_unavailable' });

  const baseUrl = process.env.GEMINI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com/v1beta';
  const systemInstruction = getSystemInstructions(submissionType);
  const orderedContextPages = [...contextPages].sort((left, right) => String(left.paperId).localeCompare(String(right.paperId))
    || Number(left.pageNumber) - Number(right.pageNumber));
  const sourceParts = [];
  orderedContextPages.forEach((page) => {
    const documentLabel = page.documentType === 'memo' ? 'Official marking memo' : 'Original question paper';
    sourceParts.push({ text: `${documentLabel} ${page.paperId}, page ${page.pageNumber}.` });
    sourceParts.push(imagePart(page));
  });
  const dynamicParts = [{ text: JSON.stringify({
    operation: submissionType,
    contextPass,
    suppliedMaterialsByQuestion,
    requestedQuestions: questions.map(({ questionId, paperId, questionNumber, topic, maximumMark }) => ({
      questionId, paperId, questionNumber, topic, maximumMark,
    })),
    instruction: 'Use the supplied source images and assess only the requested questions. If pages are blank, incorrect, or insufficient, request full_paper_search for the affected question IDs. Request memo_search only when an official memo is genuinely required. Do not request material already listed in suppliedMaterialsByQuestion.',
  }) }];
  if (submissionType === 'peer_marking') {
    addImages(dynamicParts, originalAnswerImages, 'Original learner answer image');
    addImages(dynamicParts, answerImages, "Peer marker's submitted marking image");
  } else {
    addImages(dynamicParts, answerImages, 'Learner answer image');
  }

  const sourceCache = await getGeminiSourceContextCache({
    fetchImpl,
    apiKey,
    baseUrl,
    model: GEMINI_MARKING_MODEL,
    submissionType,
    systemInstruction,
    sourceParts,
  });
  const cacheWasUsed = Boolean(sourceCache.cacheName);
  const contents = cacheWasUsed
    ? [{ role: 'user', parts: dynamicParts }]
    : [{ role: 'user', parts: [...sourceParts, ...dynamicParts] }];

  const startedAt = Date.now();
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/models/${GEMINI_MARKING_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(240_000),
      body: JSON.stringify({
        ...(!cacheWasUsed ? { system_instruction: { parts: [{ text: systemInstruction }] } } : {}),
        contents,
        ...(cacheWasUsed ? { cachedContent: sourceCache.cacheName } : {}),
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 512,
          thinkingConfig: { thinkingLevel: 'MINIMAL', includeThoughts: false },
          responseFormat: {
            text: {
              mimeType: 'APPLICATION_JSON',
              schema: AI_MARKING_RESULT_SCHEMA,
            },
          },
        },
      }),
    });
  } catch (error) {
    throw providerError('Gemini marking request could not reach the API.', {
      code: error?.code || 'gemini_network_error',
    });
  }

  let data = await response.json().catch(() => ({}));
  let usedCache = cacheWasUsed;
  let cacheStatus = sourceCache.cacheStatus;
  if (!response.ok && cacheWasUsed && [400, 404].includes(response.status)) {
    invalidateGeminiSourceContextCache(sourceCache.cacheKey);
    cacheStatus = 'rejected_retry_uncached';
    try {
      response = await fetchImpl(`${baseUrl}/models/${GEMINI_MARKING_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(240_000),
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: 'user', parts: [...sourceParts, ...dynamicParts] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 512,
            thinkingConfig: { thinkingLevel: 'MINIMAL', includeThoughts: false },
            responseFormat: {
              text: {
                mimeType: 'APPLICATION_JSON',
                schema: AI_MARKING_RESULT_SCHEMA,
              },
            },
          },
        }),
      });
      data = await response.json().catch(() => ({}));
      usedCache = false;
    } catch (error) {
      throw providerError('Gemini marking request could not reach the API.', {
        code: error?.code || 'gemini_network_error',
      });
    }
  }
  if (!response.ok) {
    throw providerError(`Gemini marking request failed with HTTP ${response.status}.`, {
      code: String(data?.error?.status || `http_${response.status}`).toLowerCase(),
      status: response.status,
    });
  }

  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part?.text ?? '')
    .filter(Boolean)
    .join('')
    .trim();
  if (!text) throw providerError('Gemini returned no structured marking result.', { code: 'gemini_empty_response' });

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw providerError('Gemini returned a response that was not valid structured JSON.', { code: 'gemini_invalid_json' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw providerError('Gemini returned an invalid structured marking result.', { code: 'gemini_invalid_result' });
  }

  return {
    ...parsed,
    model: GEMINI_MARKING_MODEL,
    provider: 'gemini',
    requestDurationMs: Date.now() - startedAt,
    usage: {
      ...getUsage(data?.usageMetadata),
      cacheWriteTokens: sourceCache.cacheWriteTokens,
    },
    contextCacheStatus: cacheStatus,
    contextCacheUsed: usedCache,
    responseId: '',
  };
};
