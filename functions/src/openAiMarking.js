import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { STUDENT_EXERCISE_MARKING_INSTRUCTIONS, PEER_MARKING_REVIEW_INSTRUCTIONS, AI_MARKING_RESULT_SCHEMA } from './aiMarkingPrompts.js';

export const OPENAI_MARKING_MODEL = 'gpt-6-luna';

const getSystemInstructions = (submissionType) => submissionType === 'peer_marking'
  ? PEER_MARKING_REVIEW_INSTRUCTIONS
  : STUDENT_EXERCISE_MARKING_INSTRUCTIONS;

export const callOpenAiMarkingOnce = async ({
  submissionType,
  sourceType = 'student_submission',
  questions,
  contextPages,
  originalAnswerImages = [],
  answerImages,
  contextPass = 'analysis_pages',
  suppliedMaterialsByQuestion = {},
  requestId = '',
  clientFactory = (options) => new OpenAI(options),
}) => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured for AI marking.');
  const model = OPENAI_MARKING_MODEL;
  const client = clientFactory({ apiKey, maxRetries: 0, timeout: 240_000 });
  const orderedContextPages = [...contextPages].sort((left, right) => String(left.paperId).localeCompare(String(right.paperId))
    || Number(left.pageNumber) - Number(right.pageNumber));
  const sharedContent = [];
  orderedContextPages.forEach((page) => {
    const documentLabel = page.documentType === 'memo' ? 'Official marking memo' : 'Original question paper';
    sharedContent.push({ type: 'input_text', text: `${documentLabel} ${page.paperId}, page ${page.pageNumber}.` });
    sharedContent.push({ type: 'input_image', image_url: page.dataUrl, detail: 'high' });
  });
  if (sharedContent.length) {
    sharedContent.push({
      type: 'input_text',
      text: 'End of shared source-paper context.',
      prompt_cache_breakpoint: { mode: 'explicit' },
    });
  }

  const userContent = [{
    type: 'input_text',
    text: JSON.stringify({
      operation: submissionType,
      sourceType,
      contextPass,
      suppliedMaterialsByQuestion,
      requestedQuestions: questions.map(({ questionId, paperId, questionNumber, topic, maximumMark }) => ({
        questionId, paperId, questionNumber, topic, maximumMark,
      })),
      instruction: 'Use the shared source images as context only. Mark only the requested questions. If analysis pages are blank, wrong, or insufficient, request the full paper first. Request a memo only if the full question paper has already been supplied for that question and an official memo is still needed. Do not repeat source material already listed in suppliedMaterialsByQuestion.',
    }),
  }];

  if (submissionType === 'peer_marking') {
    originalAnswerImages.forEach((image, index) => {
      userContent.push({ type: 'input_text', text: `Original learner answer image ${image.pageNumber || index + 1}.` });
      userContent.push({ type: 'input_image', image_url: image.dataUrl, detail: 'high' });
    });
    answerImages.forEach((image, index) => {
      userContent.push({ type: 'input_text', text: `Peer marker's submitted marking image ${image.pageNumber || index + 1}.` });
      userContent.push({ type: 'input_image', image_url: image.dataUrl, detail: 'high' });
    });
  } else {
    answerImages.forEach((image, index) => {
      userContent.push({ type: 'input_text', text: `Learner answer image ${image.pageNumber || index + 1}.` });
      userContent.push({ type: 'input_image', image_url: image.dataUrl, detail: 'high' });
    });
  }

  const cacheKeyDigest = createHash('sha256')
    .update(model)
    .update('\0')
    .update(getSystemInstructions(submissionType));
  orderedContextPages.forEach((page) => {
    cacheKeyDigest.update('\0paper\0').update(String(page.paperId));
    cacheKeyDigest.update('\0documentType\0').update(String(page.documentType || 'paper'));
    cacheKeyDigest.update('\0page\0').update(String(page.pageNumber));
    cacheKeyDigest.update('\0image\0').update(String(page.dataUrl));
  });
  const promptCacheKey = sharedContent.length
    ? `examifying-ai-marking-v1-${cacheKeyDigest.digest('hex').slice(0, 32)}`
    : undefined;
  const startedAt = Date.now();
  const response = await client.responses.create({
    model,
    store: false,
    max_output_tokens: 512,
    reasoning: { effort: 'none' },
    input: [
      { role: 'system', content: [{ type: 'input_text', text: getSystemInstructions(submissionType) }] },
      ...(sharedContent.length ? [{ role: 'user', content: sharedContent }] : []),
      { role: 'user', content: userContent },
    ],
    ...(promptCacheKey ? {
      prompt_cache_key: promptCacheKey,
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    } : {}),
    text: {
      format: {
        type: 'json_schema',
        name: 'examifying_marking_result',
        strict: true,
        schema: AI_MARKING_RESULT_SCHEMA,
      },
    },
  }, requestId ? { headers: { 'X-Client-Request-Id': requestId } } : undefined);
  const requestDurationMs = Date.now() - startedAt;
  const output = String(response.output_text ?? '').trim();
  if (!output) throw new Error('OpenAI returned no structured marking result.');
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('OpenAI returned a response that was not valid structured JSON.');
  }
  return {
    ...parsed,
    model: response.model || model,
    requestDurationMs,
    usage: response.usage ? {
      inputTokens: Number(response.usage.input_tokens) || 0,
      outputTokens: Number(response.usage.output_tokens) || 0,
      totalTokens: Number(response.usage.total_tokens) || 0,
      cachedInputTokens: Number(response.usage.input_tokens_details?.cached_tokens) || 0,
      cacheWriteTokens: Number(response.usage.input_tokens_details?.cache_write_tokens) || 0,
    } : null,
    contextCacheStatus: !promptCacheKey ? 'none'
      : Number(response.usage?.input_tokens_details?.cached_tokens) > 0 ? 'hit'
        : Number(response.usage?.input_tokens_details?.cache_write_tokens) > 0 ? 'write' : 'miss',
    contextCacheUsed: Number(response.usage?.input_tokens_details?.cached_tokens) > 0,
    responseId: String(response.id ?? ''),
  };
};
