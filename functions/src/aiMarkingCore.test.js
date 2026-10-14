import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aiMarkingTaskId,
  getRequestedMarkingQuestions,
  resolvePaperPageContext,
  runAiMarkingOnce,
  shouldPreserveAuthoritativeMark,
  submissionIsCurrent,
  tutorAiMarkingEnabled,
  validateAiMarkingResponse,
} from './aiMarkingCore.js';
import { PEER_MARKING_REVIEW_INSTRUCTIONS, STUDENT_EXERCISE_MARKING_INSTRUCTIONS } from './aiMarkingPrompts.js';

const link = (paperId, questionReference, topic = 'Algebra', marks = 2, pageNumber = 3) => ({
  paperId, questionReference, topic, marks, pageNumber,
});
const analysis = (questionReference, parentQuestion, pageNumber) => ({ questionReference, parentQuestion, pageNumber });

test('resolves one requested question from its own paper and page', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1')] });
  assert.deepEqual(resolvePaperPageContext({ requestedQuestions: questions, analysesByPaper: {
    'paper-a': [analysis('1.1', '1', 3), analysis('2.1', '2', 4)],
  } }).pages, [{ paperId: 'paper-a', pageNumber: 3 }]);
});

test('supports seven requested questions from seven papers in one context result', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: Array.from({ length: 7 }, (_, index) => link(`paper-${index}`, '1.1', `Topic ${index}`)) });
  const analysesByPaper = Object.fromEntries(questions.map((item) => [item.paperId, [analysis('1.1', '1', 1)]]));
  assert.equal(resolvePaperPageContext({ requestedQuestions: questions, analysesByPaper }).pages.length, 7);
});

test('deduplicates repeated questions under the same paper and parent', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1'), link('paper-a', '1.2')] });
  const context = resolvePaperPageContext({ requestedQuestions: questions, analysesByPaper: {
    'paper-a': [analysis('1.1', '1', 3), analysis('1.2', '1', 3)],
  } });
  assert.equal(context.parentGroups.length, 1);
  assert.deepEqual(context.pages, [{ paperId: 'paper-a', pageNumber: 3 }]);
});

test('deduplicates shared pages across different parents of a paper', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1'), link('paper-a', '2.1')] });
  const context = resolvePaperPageContext({ requestedQuestions: questions, analysesByPaper: {
    'paper-a': [analysis('1.1', '1', 3), analysis('2.1', '2', 3), analysis('2.2', '2', 4)],
  } });
  assert.deepEqual(context.pages, [{ paperId: 'paper-a', pageNumber: 3 }, { paperId: 'paper-a', pageNumber: 4 }]);
});

test('keeps same question number distinct across different papers', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '6.6'), link('paper-b', '6.6', 'Geometry', 4, 8)] });
  assert.equal(questions.length, 2);
  const context = resolvePaperPageContext({ requestedQuestions: questions, analysesByPaper: {
    'paper-a': [analysis('6.6', '6', 3)],
    'paper-b': [analysis('6.6', '6', 8)],
  } });
  assert.deepEqual(context.pages, [{ paperId: 'paper-a', pageNumber: 3 }, { paperId: 'paper-b', pageNumber: 8 }]);
});

test('retrieves all sibling pages spanning pages three through five', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '4.2')] });
  const context = resolvePaperPageContext({ requestedQuestions: questions, analysesByPaper: {
    'paper-a': [analysis('4.1', '4', 3), analysis('4.2', '4', 4), analysis('4.3', '4', 5), analysis('5.1', '5', 6)],
  } });
  assert.deepEqual(context.pages.map((page) => page.pageNumber), [3, 4, 5]);
});

test('deduplicates duplicate analyzed page numbers', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1')] });
  const context = resolvePaperPageContext({ requestedQuestions: questions, analysesByPaper: {
    'paper-a': [analysis('1.1', '1', 3), analysis('1.2', '1', 3), analysis('1.3', '1', 4)],
  } });
  assert.deepEqual(context.pages, [{ paperId: 'paper-a', pageNumber: 3 }, { paperId: 'paper-a', pageNumber: 4 }]);
});

test('question identity includes paper ID when an exercise spans papers', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1'), link('paper-b', '1.1')] });
  const response = { status: 'completed', message: '', results: questions.map((item) => ({
    questionId: item.questionId, paperId: item.paperId, questionNumber: item.questionNumber,
    awardedMark: 1, maximumMark: item.maximumMark,
  })) };
  assert.equal(validateAiMarkingResponse({ response, requestedQuestions: questions }).results.length, 2);
});

test('validates all questions and uses the authoritative maximum mark', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1', 'Algebra', 2)] });
  const response = { status: 'completed', message: '', results: [{
    questionId: questions[0].questionId, paperId: 'paper-a', questionNumber: '1.1', awardedMark: 1, maximumMark: 900,
  }] };
  const result = validateAiMarkingResponse({ response, requestedQuestions: questions });
  assert.equal(result.results[0].totalMarks, 2);
});

test('rejects AI marks greater than the authoritative maximum', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1', 'Algebra', 2)] });
  assert.throws(() => validateAiMarkingResponse({ response: { status: 'completed', results: [{
    questionId: questions[0].questionId, paperId: 'paper-a', questionNumber: '1.1', awardedMark: 3,
  }] }, requestedQuestions: questions }), /invalid mark/);
});

test('rejects an unknown exercise question from the model', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1')] });
  assert.throws(() => validateAiMarkingResponse({ response: { status: 'completed', results: [{
    questionId: 'paper-a::9.9', paperId: 'paper-a', questionNumber: '9.9', awardedMark: 1,
  }] }, requestedQuestions: questions }), /unknown exercise question/);
});

test('rejects duplicated and missing question results', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1'), link('paper-a', '1.2')] });
  const duplicate = { questionId: questions[0].questionId, paperId: 'paper-a', questionNumber: '1.1', awardedMark: 1 };
  assert.throws(() => validateAiMarkingResponse({ response: { status: 'completed', results: [duplicate, duplicate] }, requestedQuestions: questions }), /duplicated an exercise question/);
});

test('does not create marks for incorrect or unclear submissions', async () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1')] });
  for (const status of ['incorrect_submission', 'unclear_images']) {
    const result = validateAiMarkingResponse({ response: { status, results: [], message: '' }, requestedQuestions: questions });
    assert.equal(result.status, status);
    assert.deepEqual(result.results, []);
  }
});

test('makes exactly one model call and applies completed scores once', async () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1'), link('paper-a', '1.2')] });
  let modelCalls = 0;
  let applyCalls = 0;
  const result = await runAiMarkingOnce({
    request: { questions },
    callModel: async () => {
      modelCalls += 1;
      return { status: 'completed', message: '', results: questions.map((item) => ({
        questionId: item.questionId, paperId: item.paperId, questionNumber: item.questionNumber,
        awardedMark: 1, maximumMark: item.maximumMark,
      })) };
    },
    applyCompleted: async (marks) => { applyCalls += 1; assert.equal(marks.length, 2); },
  });
  assert.equal(modelCalls, 1);
  assert.equal(applyCalls, 1);
  assert.equal(result.status, 'completed');
});

test('disabled AI marking makes no model call', async () => {
  let modelCalls = 0;
  const result = await runAiMarkingOnce({ enabled: false, request: {}, callModel: async () => { modelCalls += 1; }, applyCompleted: async () => {} });
  assert.equal(result.status, 'skipped');
  assert.equal(modelCalls, 0);
});

test('legacy tutor settings default to enabled and explicit false disables marking', () => {
  assert.equal(tutorAiMarkingEnabled({}), true);
  assert.equal(tutorAiMarkingEnabled({ settings: {} }), true);
  assert.equal(tutorAiMarkingEnabled({ settings: { aiMarkingEnabled: false } }), false);
  assert.equal(tutorAiMarkingEnabled({ settings: { aiMarkingEnabled: true } }), true);
});

test('manual and legacy marks remain authoritative over a delayed AI result', () => {
  assert.equal(shouldPreserveAuthoritativeMark('ai', 'manual'), true);
  assert.equal(shouldPreserveAuthoritativeMark('ai', undefined), true);
  assert.equal(shouldPreserveAuthoritativeMark('ai', 'ai'), false);
  assert.equal(shouldPreserveAuthoritativeMark('manual', 'ai'), false);
});

test('stale AI versions are rejected and versioned task identities differ', () => {
  assert.equal(submissionIsCurrent({ currentVersion: 'v2', requestedVersion: 'v1' }), false);
  assert.equal(submissionIsCurrent({ currentVersion: 'v2', requestedVersion: 'v2' }), true);
  assert.notEqual(aiMarkingTaskId({ submissionType: 'student_exercise', submissionId: 'x', version: 'a' }),
    aiMarkingTaskId({ submissionType: 'student_exercise', submissionId: 'x', version: 'b' }));
});

test('peer marking and student marking use distinct instructions', () => {
  assert.notEqual(PEER_MARKING_REVIEW_INSTRUCTIONS, STUDENT_EXERCISE_MARKING_INSTRUCTIONS);
  assert.match(PEER_MARKING_REVIEW_INSTRUCTIONS, /marker's understanding/i);
  assert.match(STUDENT_EXERCISE_MARKING_INSTRUCTIONS, /learner's work/i);
});

test('OpenAI failure propagates without applying marks', async () => {
  let applied = false;
  await assert.rejects(runAiMarkingOnce({
    request: {},
    callModel: async () => { throw new Error('temporary API outage'); },
    applyCompleted: async () => { applied = true; },
  }), /temporary API outage/);
  assert.equal(applied, false);
});
