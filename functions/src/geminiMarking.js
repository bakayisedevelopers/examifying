import { jsonrepair } from 'jsonrepair';
import { AI_MARKING_RESULT_SCHEMA, PEER_MARKING_REVIEW_INSTRUCTIONS, STUDENT_EXERCISE_MARKING_INSTRUCTIONS } from './aiMarkingPrompts.js';
import { getGeminiSourceContextCache, invalidateGeminiSourceContextCache } from './geminiContextCache.js';

export const GEMINI_MARKING_MODEL = 'gemini-3.5-flash-lite';

const getSystemInstructions = (submissionType) => submissionType === 'peer_marking'
  ? PEER_MARKING_REVIEW_INSTRUCTIONS
  : STUDENT_EXERCISE_MARKING_INSTRUCTIONS;

const imagePart = (image) => {
  const match = String(image?.dataUrl ?? '').match(/^data:([^;,]+);base64,([\s\S]+)$/);
  if (!match) throw new Error('AI marking received an invalid image payload.');
  return {
    inline_data: { mime_type: match[1], data: match[2] },
    media_resolution: { level: 'MEDIA_RESOLUTION_ULTRA_HIGH' },
  };
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
  sourceType = 'student_submission',
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
  const annotationInstruction = submissionType === 'peer_marking'
    ? 'For visual review, the peer marker image is the image explicitly labeled Peer marker. If it contains clearly visible ticks or crosses, return one AI annotation beside each visible decision; do not return annotations:[] just because all peer decisions are correct. A correct peer decision gets an AI tick; an incorrect peer decision gets an AI cross. Use imageIndex 0 for the first peer marker image, regardless of the separate original-answer image.'
    : 'For visual review, annotate each clearly readable learner solution step beside the handwriting; use the corresponding learner-answer imageIndex.';
  const dynamicParts = [{ text: JSON.stringify({
    operation: submissionType,
    sourceType,
    contextPass,
    suppliedMaterialsByQuestion,
    requestedQuestions: questions.map(({ questionId, paperId, questionNumber, topic, maximumMark }) => ({
      questionId, paperId, questionNumber, topic, maximumMark,
    })),
    instruction: `Use the supplied source images and assess only the requested questions. If analysis pages are blank, incorrect, or insufficient, request full_paper_search for the affected question IDs first. Request memo_search only if the full question paper has already been supplied for that question and an official memo is still genuinely required. Do not request material already listed in suppliedMaterialsByQuestion. ${annotationInstruction}`,
  }) }];
  if (submissionType === 'peer_marking') {
    originalAnswerImages.forEach((image, index) => {
      dynamicParts.push({ text: `Original learner answer image ${image.pageNumber || index + 1} (context only; do not annotate).` });
      dynamicParts.push(imagePart(image));
    });
    answerImages.forEach((image, index) => {
      dynamicParts.push({ text: `Peer marker's submitted marking image ${image.pageNumber || index + 1}, imageIndex=${index}.` });
      dynamicParts.push(imagePart(image));
    });
  } else {
    answerImages.forEach((image, index) => {
      dynamicParts.push({ text: `Learner answer image ${image.pageNumber || index + 1}, imageIndex=${index}.` });
      dynamicParts.push(imagePart(image));
    });
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
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: false },
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
            maxOutputTokens: 2048,
            thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: false },
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
  const fencedText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const objectStart = fencedText.indexOf('{');
  const objectEnd = fencedText.lastIndexOf('}');
  const candidates = [fencedText];
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(fencedText.slice(objectStart, objectEnd + 1));
  for (const candidate of [...new Set(candidates)]) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      try {
        parsed = JSON.parse(jsonrepair(candidate));
        break;
      } catch {
        // Keep trying only bounded JSON-shaped candidates; downstream validation remains authoritative.
      }
    }
  }
  if (!parsed) {
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
