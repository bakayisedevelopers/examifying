import OpenAI from 'openai';
import { GEMINI_MARKING_MODEL } from './geminiMarking.js';
import { OPENAI_MARKING_MODEL } from './openAiMarking.js';
import { callMarkingWithFallback } from './aiMarkingProviders.js';
import { validateSystemPeerWorkSolutionResponse } from './peerMarkingFallbackCore.js';

export const SYSTEM_PEER_WORK_INSTRUCTIONS = `You are preparing a concise worked answer sheet for a South African school peer-marking exercise. The complete original question-paper PDF is attached. Search the entire PDF for each exact requested question number; the PDF is the source of truth for the question text, diagrams, data, and instructions. The small metadata list only identifies which question numbers to solve and must not be treated as question content. Do not rely on page numbers or analyzed-paper descriptions. Solve only the exact requested questions. If an exact question cannot be found anywhere in the attached PDF, do not guess or write a refusal as an answer: return status "needs_context" and list its questionId in questionIdsNeedingContext. Otherwise return status "completed" and one correct concise solution for every requested question. Show enough working for a student to assess the answer. Format equations with standard LaTeX delimiters and commands, such as \\(x^2\\), \\[\\frac{a}{b}\\], subscripts, roots, vectors, Greek letters, chemical formulas, and units; the answer sheet renderer will typeset common mathematical and scientific notation. Do not provide chain-of-thought, commentary, marking advice, or answers to surrounding questions. Return only the required structured JSON.`;

export const SYSTEM_PEER_WORK_SOLUTION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['completed', 'needs_context'] },
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
    questionIdsNeedingContext: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'solutions', 'questionIdsNeedingContext'],
});

const requestPayload = ({ questions = [] }) => JSON.stringify({
  requestedQuestions: questions.map(({ questionId, paperId, questionNumber }) => ({
    questionId, paperId, questionNumber,
  })),
  instruction: 'Search the attached complete question-paper PDF and solve every listed question exactly once. The PDF, not analysis metadata, determines the question content.',
});

const validateSourcePdf = (sourcePdf) => {
  if (!sourcePdf || sourcePdf.mimeType !== 'application/pdf' || !Buffer.isBuffer(sourcePdf.buffer)
    || sourcePdf.buffer.length < 8 || !String(sourcePdf.fileName ?? '').toLowerCase().endsWith('.pdf')) {
    throw new Error('Peer-work generation requires the complete source question paper as a PDF.');
  }
  return sourcePdf;
};

export const callOpenAiPeerWorkSolution = async ({
  questions = [], sourcePdf,
  clientFactory = (options) => new OpenAI(options),
}) => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured for peer-work generation.');
  const pdf = validateSourcePdf(sourcePdf);
  const client = clientFactory({ apiKey, maxRetries: 0, timeout: 240_000 });
  const content = [
    {
      type: 'input_file',
      filename: pdf.fileName,
      file_data: `data:application/pdf;base64,${pdf.buffer.toString('base64')}`,
      detail: 'high',
    },
    { type: 'input_text', text: requestPayload({ questions }) },
  ];
  const startedAt = Date.now();
  const response = await client.responses.create({
    model: OPENAI_MARKING_MODEL,
    store: false,
    max_output_tokens: 4096,
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

export const callGeminiPeerWorkSolution = async ({ questions = [], sourcePdf, fetchImpl = globalThis.fetch }) => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured for peer-work generation.');
  if (typeof fetchImpl !== 'function') throw new Error('Gemini fetch is unavailable for peer-work generation.');
  const pdf = validateSourcePdf(sourcePdf);
  const baseUrl = process.env.GEMINI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com/v1beta';
  const startedAt = Date.now();
  const response = await fetchImpl(`${baseUrl}/models/${GEMINI_MARKING_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(240_000),
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PEER_WORK_INSTRUCTIONS }] },
      contents: [{ role: 'user', parts: [
        { inline_data: { mime_type: 'application/pdf', data: pdf.buffer.toString('base64') } },
        { text: requestPayload({ questions }) },
      ] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 4096,
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

export const solveSystemPeerWork = async ({ questions, sourcePdf, callPrimary = callOpenAiPeerWorkSolution, callFallback = callGeminiPeerWorkSolution }) => {
  const request = { questions, sourcePdf };
  const validateCompletedResponse = (response) => {
    const validated = validateSystemPeerWorkSolutionResponse({ response, questionLinks: questions });
    if (validated.status !== 'completed') {
      throw new Error('The model could not locate every selected question in the full source-paper PDF.');
    }
  };
  const result = await callMarkingWithFallback({
    request,
    callPrimary,
    callFallback,
    validateResponse: validateCompletedResponse,
  });
  const validated = validateSystemPeerWorkSolutionResponse({ response: result, questionLinks: questions });
  if (validated.status !== 'completed') throw new Error('A complete source-paper solution was not returned.');
  return { ...result, ...validated };
};
