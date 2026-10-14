import OpenAI from 'openai';
import { GEMINI_MARKING_MODEL } from './geminiMarking.js';
import { OPENAI_MARKING_MODEL } from './openAiMarking.js';
import { callMarkingWithFallback } from './aiMarkingProviders.js';
import { validateSystemPeerWorkSolutions } from './peerMarkingFallbackCore.js';

export const SYSTEM_PEER_WORK_INSTRUCTIONS = `You are preparing a concise answer sheet for a South African school peer-marking exercise. Solve only the exact examination questions requested, using the supplied original question-paper page images. Show enough concise working for a student to assess the answer and award the stated maximum marks. Do not invent missing question details. Do not provide chain-of-thought, commentary, marking advice, or answers to surrounding questions. Return only the required structured JSON.`;

export const SYSTEM_PEER_WORK_SOLUTION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['completed'] },
    solutions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          questionId: { type: 'string' },
          solutionText: { type: 'string' },
        },
        required: ['questionId', 'solutionText'],
      },
    },
  },
  required: ['status', 'solutions'],
});

const requestPayload = ({ questions = [] }) => JSON.stringify({
  questions: questions.map(({ questionId, paperId, questionNumber, topic, maximumMark }) => ({
    questionId, paperId, questionNumber, topic, maximumMark,
  })),
  instruction: 'Solve every listed question exactly once. Return concise worked answers, not explanations of your reasoning process.',
});

export const callOpenAiPeerWorkSolution = async ({
  questions = [], contextPages = [],
  clientFactory = (options) => new OpenAI(options),
}) => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured for peer-work generation.');
  const client = clientFactory({ apiKey, maxRetries: 0, timeout: 240_000 });
  const content = [];
  [...contextPages].sort((left, right) => Number(left.pageNumber) - Number(right.pageNumber)).forEach((page) => {
    content.push({ type: 'input_text', text: `Original question paper page ${page.pageNumber}.` });
    content.push({ type: 'input_image', image_url: page.dataUrl, detail: 'high' });
  });
  content.push({ type: 'input_text', text: requestPayload({ questions, contextPages }) });
  const startedAt = Date.now();
  const response = await client.responses.create({
    model: OPENAI_MARKING_MODEL,
    store: false,
    max_output_tokens: 2048,
    reasoning: { effort: 'none' },
    input: [
      { role: 'system', content: [{ type: 'input_text', text: SYSTEM_PEER_WORK_INSTRUCTIONS }] },
      { role: 'user', content },
    ],
    text: { format: { type: 'json_schema', name: 'examifying_peer_work_solutions', strict: true, schema: SYSTEM_PEER_WORK_SOLUTION_SCHEMA } },
  });
  const output = String(response.output_text ?? '').trim();
  if (!output) throw new Error('OpenAI returned no peer-work solutions.');
  let parsed;
  try { parsed = JSON.parse(output); } catch { throw new Error('OpenAI returned invalid structured peer-work solutions.'); }
  return {
    ...parsed,
    provider: 'openai',
    model: response.model || OPENAI_MARKING_MODEL,
    requestDurationMs: Date.now() - startedAt,
    usage: {
      inputTokens: Number(response.usage?.input_tokens) || 0,
      outputTokens: Number(response.usage?.output_tokens) || 0,
      totalTokens: Number(response.usage?.total_tokens) || 0,
      cachedInputTokens: Number(response.usage?.input_tokens_details?.cached_tokens) || 0,
    },
  };
};

const geminiImagePart = (image) => {
  const match = String(image?.dataUrl ?? '').match(/^data:([^;,]+);base64,([\s\S]+)$/);
  if (!match) throw new Error('Peer-work generation received an invalid source-page image.');
  return { inline_data: { mime_type: match[1], data: match[2] } };
};

export const callGeminiPeerWorkSolution = async ({ questions = [], contextPages = [], fetchImpl = globalThis.fetch }) => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured for peer-work generation.');
  if (typeof fetchImpl !== 'function') throw new Error('Gemini fetch is unavailable for peer-work generation.');
  const baseUrl = process.env.GEMINI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com/v1beta';
  const parts = [...contextPages].sort((left, right) => Number(left.pageNumber) - Number(right.pageNumber))
    .flatMap((page) => [{ text: `Original question paper page ${page.pageNumber}.` }, geminiImagePart(page)]);
  parts.push({ text: requestPayload({ questions, contextPages }) });
  const startedAt = Date.now();
  const response = await fetchImpl(`${baseUrl}/models/${GEMINI_MARKING_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(240_000),
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PEER_WORK_INSTRUCTIONS }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingLevel: 'MINIMAL', includeThoughts: false },
        responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: SYSTEM_PEER_WORK_SOLUTION_SCHEMA } },
      },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Gemini peer-work generation failed with HTTP ${response.status}.`);
  const output = (data?.candidates?.[0]?.content?.parts ?? []).map((part) => part?.text ?? '').filter(Boolean).join('').trim();
  if (!output) throw new Error('Gemini returned no peer-work solutions.');
  let parsed;
  try { parsed = JSON.parse(output); } catch { throw new Error('Gemini returned invalid structured peer-work solutions.'); }
  return {
    ...parsed,
    provider: 'gemini',
    model: GEMINI_MARKING_MODEL,
    requestDurationMs: Date.now() - startedAt,
    usage: {
      inputTokens: Number(data?.usageMetadata?.promptTokenCount) || 0,
      outputTokens: Number(data?.usageMetadata?.candidatesTokenCount) || 0,
      totalTokens: Number(data?.usageMetadata?.totalTokenCount) || 0,
    },
  };
};

export const solveSystemPeerWork = async ({ questions, contextPages, callPrimary = callOpenAiPeerWorkSolution, callFallback = callGeminiPeerWorkSolution }) => {
  const result = await callMarkingWithFallback({
    request: { questions, contextPages },
    callPrimary,
    callFallback,
    validateResponse: (response) => validateSystemPeerWorkSolutions({ response, questionLinks: questions }),
  });
  return {
    ...result,
    solutions: validateSystemPeerWorkSolutions({ response: result, questionLinks: questions }),
  };
};
