import test from 'node:test';
import assert from 'node:assert/strict';
import { callGeminiPeerWorkSolution, callOpenAiPeerWorkSolution } from './peerMarkingFallbackAi.js';

const pdf = Buffer.from('%PDF-1.7\nFull source-paper fixture');
const sourcePdf = { fileName: 'source-question-paper.pdf', mimeType: 'application/pdf', buffer: pdf };
const responseText = JSON.stringify({
  status: 'completed',
  solutions: [{ questionId: 'paper-a::2.1', solutionText: 'Worked answer' }],
  questionIdsNeedingContext: [],
});

const withEnv = async (values, action) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await action(); } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
};

test('OpenAI receives one complete question-paper PDF and only question identifiers as metadata', async () => {
  let request;
  await withEnv({ OPENAI_API_KEY: 'test-key' }, async () => callOpenAiPeerWorkSolution({
    sourcePdf,
    questions: [{
      questionId: 'paper-a::2.1', paperId: 'paper-a', questionNumber: '2.1',
      pageNumber: 9, parentQuestion: '2', analysisDescription: 'Must not be passed to the model',
    }],
    clientFactory: () => ({ responses: { create: async (body) => {
      request = body;
      return { output_text: responseText, model: 'gpt-6-luna', usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } };
    } } }),
  }));

  const userContent = request.input.find((item) => item.role === 'user').content;
  const file = userContent.find((item) => item.type === 'input_file');
  assert.equal(file.filename, sourcePdf.fileName);
  assert.equal(file.detail, 'high');
  assert.equal(Buffer.from(file.file_data.replace(/^data:application\/pdf;base64,/, ''), 'base64').toString(), pdf.toString());
  assert.equal(userContent.some((item) => item.type === 'input_image'), false);
  const prompt = userContent.find((item) => item.type === 'input_text').text;
  assert.match(prompt, /"questionNumber":"2\.1"/);
  assert.doesNotMatch(prompt, /pageNumber|parentQuestion|analysisDescription|Must not be passed/);
});

test('Gemini receives the same complete PDF as an application/pdf document part', async () => {
  let request;
  await withEnv({ GEMINI_API_KEY: 'test-key' }, async () => callGeminiPeerWorkSolution({
    sourcePdf,
    questions: [{ questionId: 'paper-a::2.1', paperId: 'paper-a', questionNumber: '2.1', pageNumber: 9 }],
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({
        candidates: [{ content: { parts: [{ text: responseText }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 },
      }) };
    },
  }));

  const parts = request.contents[0].parts;
  const document = parts.find((item) => item.inline_data);
  assert.equal(document.inline_data.mime_type, 'application/pdf');
  assert.equal(Buffer.from(document.inline_data.data, 'base64').toString(), pdf.toString());
  assert.equal(parts.some((item) => item.inline_data?.mime_type?.startsWith('image/')), false);
  const prompt = parts.find((item) => item.text)?.text;
  assert.match(prompt, /"questionNumber":"2\.1"/);
  assert.doesNotMatch(prompt, /pageNumber|parentQuestion/);
});
