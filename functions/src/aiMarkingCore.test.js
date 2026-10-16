import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aiMarkingTaskId,
  excludeScoredMarkingQuestions,
  getPendingMarkingQuestions,
  getRequestedMarkingQuestions,
  groupAiContextRequestsByPaper,
  isRetryableAiMarkingStatus,
  mergeAiMarkingResults,
  mergeAiMarkingAnnotations,
  resolvePaperPageContext,
  runAiMarkingOnce,
  shouldPreserveAuthoritativeMark,
  submissionIsCurrent,
  submissionVersionForRecord,
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

test('routes missing analysis, parent, or page references to full-paper fallback', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [
    link('paper-a', '1.1'), link('paper-a', '2.1', 'Geometry'), link('paper-b', '3.1', 'Statistics'),
  ] });
  const context = resolvePaperPageContext({ requestedQuestions: questions, analysesByPaper: {
    'paper-a': [analysis('1.1', '', 3), analysis('2.1', '2', 0)],
  } });
  assert.deepEqual(new Set(context.fallbackQuestionIds), new Set(questions.map((question) => question.questionId)));
  assert.deepEqual(context.pages, []);
});

test('question identity includes paper ID when an exercise spans papers', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1'), link('paper-b', '1.1')] });
  const response = { status: 'completed', message: '', results: questions.map((item) => ({
    questionId: item.questionId, paperId: item.paperId, questionNumber: item.questionNumber,
    awardedMark: 1, maximumMark: item.maximumMark,
  })) };
  assert.equal(validateAiMarkingResponse({ response, requestedQuestions: questions }).results.length, 2);
});

test('student and peer prompts strictly reconcile handwritten numbering and continuation without guessing', () => {
  for (const instructions of [STUDENT_EXERCISE_MARKING_INSTRUCTIONS, PEER_MARKING_REVIEW_INSTRUCTIONS]) {
    assert.match(instructions, /questionId, paperId, questionNumber.*authoritative/i);
    assert.match(instructions, /formatting variants/i);
    assert.match(instructions, /continuation/i);
    assert.match(instructions, /same array position/i);
    assert.match(instructions, /remains ambiguous.*do not guess/i);
  }
  assert.match(PEER_MARKING_REVIEW_INSTRUCTIONS, /peer marker's annotations, marks, and comments/i);
  assert.match(STUDENT_EXERCISE_MARKING_INSTRUCTIONS, /wrong attempt.*still an attempt/i);
});

test('validates all questions and uses the authoritative maximum mark', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1', 'Algebra', 2)] });
  const response = { status: 'completed', message: '', results: [{
    questionId: questions[0].questionId, paperId: 'paper-a', questionNumber: '1.1', awardedMark: 1, maximumMark: 900,
  }] };
  const result = validateAiMarkingResponse({ response, requestedQuestions: questions });
  assert.equal(result.results[0].totalMarks, 2);
});

test('validates annotation coordinates independently and remains compatible with older responses', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1')] });
  const result = validateAiMarkingResponse({
    response: {
      status: 'completed',
      results: [{ questionId: questions[0].questionId, awardedMark: 1 }],
      annotations: [
        { questionId: questions[0].questionId, questionNumber: '1.1', imageIndex: 0, type: 'tick', x: 0.82, y: 0.35, stepId: 'step_1', confidence: 0.96 },
        { questionId: questions[0].questionId, questionNumber: '1.1', imageIndex: 2, type: 'cross', x: 1.2, y: 0.5, stepId: 'invalid_position', confidence: 0.9 },
        { questionId: 'unknown::1', questionNumber: '1', imageIndex: 0, type: 'cross', x: 0.2, y: 0.2, stepId: 'unknown', confidence: 1 },
      ],
    },
    requestedQuestions: questions,
    answerImageCount: 1,
  });
  assert.equal(result.results[0].earnedMarks, 1);
  assert.deepEqual(result.annotations, [{
    questionId: questions[0].questionId, questionNumber: '1.1', imageIndex: 0,
    type: 'tick', x: 0.82, y: 0.35, stepId: 'step_1', confidence: 0.96,
  }]);

  const legacy = validateAiMarkingResponse({
    response: { status: 'completed', results: [{ questionId: questions[0].questionId, awardedMark: 1 }] },
    requestedQuestions: questions,
  });
  assert.deepEqual(legacy.annotations, []);
  assert.equal(legacy.results[0].earnedMarks, 1);
});

test('ignores malformed annotation coordinates without changing valid scores', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1')] });
  const result = validateAiMarkingResponse({
    response: {
      status: 'completed',
      results: [{ questionId: questions[0].questionId, awardedMark: 0 }],
      annotations: [{ questionId: questions[0].questionId, questionNumber: '1.1', imageIndex: 'bad', type: 'tick', x: 0, y: 0.4, stepId: 'step_1', confidence: 0.7 }],
    },
    requestedQuestions: questions,
  });
  assert.equal(result.results[0].earnedMarks, 0);
  assert.deepEqual(result.annotations, []);
});

test('merges annotations by question, image, and step without duplicating fallback results', () => {
  const first = { questionId: 'paper-a::1.1', imageIndex: 0, stepId: 'step_1', type: 'tick', x: 0.2, y: 0.3 };
  const second = { questionId: 'paper-a::1.1', imageIndex: 0, stepId: 'step_2', type: 'cross', x: 0.4, y: 0.5 };
  assert.deepEqual(mergeAiMarkingAnnotations([first], [first, second]), [first, second]);
});

test('accepts partial marks with a full-paper request for only unresolved questions', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1'), link('paper-b', '2.1', 'Geometry')] });
  const [markedQuestion, fallbackQuestion] = questions;
  const result = validateAiMarkingResponse({ response: {
    status: 'full_paper_search',
    results: [{ questionId: markedQuestion.questionId, awardedMark: 1 }],
    contextRequests: [{ questionId: fallbackQuestion.questionId, material: 'full_paper' }],
    unansweredQuestionIds: [],
  }, requestedQuestions: questions, suppliedMaterialsByQuestion: {
    [markedQuestion.questionId]: ['analysis_pages'],
  } });
  assert.equal(result.results[0].earnedMarks, 1);
  assert.deepEqual(result.contextRequests.map(({ questionId, material }) => ({ questionId, material })), [
    { questionId: fallbackQuestion.questionId, material: 'full_paper' },
  ]);
  assert.deepEqual(getPendingMarkingQuestions(questions, result.results).map((question) => question.questionId), [fallbackQuestion.questionId]);
});

test('accepts partial work and returns only the submitted question mark plus unanswered IDs', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1'), link('paper-a', '1.2', 'Geometry')] });
  const result = validateAiMarkingResponse({ response: {
    status: 'partially_completed',
    results: [{ questionId: questions[0].questionId, awardedMark: 1 }],
    contextRequests: [],
    unansweredQuestionIds: [questions[1].questionId],
  }, requestedQuestions: questions });
  assert.equal(result.status, 'partially_completed');
  assert.deepEqual(result.results.map((item) => item.questionId), [questions[0].questionId]);
  assert.deepEqual(result.unansweredQuestionIds, [questions[1].questionId]);
});

test('rejects partial responses that omit or duplicate a requested question', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1'), link('paper-a', '1.2', 'Geometry')] });
  assert.throws(() => validateAiMarkingResponse({ response: {
    status: 'partially_completed', results: [], contextRequests: [], unansweredQuestionIds: [questions[0].questionId],
  }, requestedQuestions: questions }), /did not account for every requested question/);
  assert.throws(() => validateAiMarkingResponse({ response: {
    status: 'partially_completed', results: [{ questionId: questions[0].questionId, awardedMark: 1 }],
    contextRequests: [], unansweredQuestionIds: [questions[0].questionId, questions[1].questionId],
  }, requestedQuestions: questions }), /more than once/);
});

test('repeat submissions exclude prior saved scores by paper and question identity', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [
    link('paper-a', '1.1'), link('paper-a', '1.2', 'Geometry'), link('paper-b', '1.1', 'Statistics'),
  ] });
  const pending = excludeScoredMarkingQuestions(questions, [
    { sourceType: 'Exercise', paperId: 'paper-a', questionReference: '1.1', markSource: 'ai' },
    { sourceType: 'Marking', paperId: 'paper-a', questionReference: '1.2' },
  ]);
  assert.deepEqual(pending.map((question) => question.questionId), ['paper-a::1.2', 'paper-b::1.1']);
});

test('allows a memo request only for an unresolved question and blocks repeated material', () => {
  const questions = getRequestedMarkingQuestions({ questionLinks: [link('paper-a', '1.1')] });
  const response = { status: 'memo_search', results: [], contextRequests: [{
    questionId: questions[0].questionId, material: 'memo',
  }] };
  assert.throws(() => validateAiMarkingResponse({ response, requestedQuestions: questions }), /before the full question paper was supplied/);
  assert.equal(validateAiMarkingResponse({ response, requestedQuestions: questions, suppliedMaterialsByQuestion: {
    [questions[0].questionId]: ['full_paper'],
  } }).contextRequests[0].material, 'memo');
  assert.throws(() => validateAiMarkingResponse({ response, requestedQuestions: questions, suppliedMaterialsByQuestion: {
    [questions[0].questionId]: ['full_paper', 'memo'],
  } }), /already supplied/);
});

test('deduplicates full paper and memo retrieval plans by paper while retaining question mapping', () => {
  const groups = groupAiContextRequestsByPaper([
    { paperId: 'paper-a', questionId: 'a::1.1', material: 'full_paper' },
    { paperId: 'paper-a', questionId: 'a::1.2', material: 'full_paper' },
    { paperId: 'paper-a', questionId: 'a::1.2', material: 'memo' },
    { paperId: 'paper-b', questionId: 'b::1.1', material: 'full_paper' },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].materials, ['full_paper', 'memo']);
  assert.deepEqual(groups[0].materialsByQuestion['a::1.2'], ['full_paper', 'memo']);
  assert.equal(mergeAiMarkingResults([{ questionId: 'a::1.1', earnedMarks: 1, totalMarks: 2 }], [])
    .length, 1);
  assert.throws(() => mergeAiMarkingResults(
    [{ questionId: 'a::1.1', earnedMarks: 1, totalMarks: 2 }],
    [{ questionId: 'a::1.1', earnedMarks: 2, totalMarks: 2 }],
  ), /conflicting marks/);
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

test('a later image upload always receives a different marking version', () => {
  const first = submissionVersionForRecord({ submittedAt: { toMillis: () => 10 } }, [
    { url: 'https://storage.test/first.jpg', pageNumber: 1 },
  ]);
  const second = submissionVersionForRecord({ submittedAt: { toMillis: () => 20 } }, [
    { url: 'https://storage.test/second.jpg', pageNumber: 1 },
  ]);
  assert.notEqual(first, second);
  assert.notEqual(
    submissionVersionForRecord({ submittedAt: { toMillis: () => 10 }, submissionVersion: 1 }, [
      { url: 'https://storage.test/same.jpg', pageNumber: 1 },
    ]),
    submissionVersionForRecord({ submittedAt: { toMillis: () => 10 }, submissionVersion: 2 }, [
      { url: 'https://storage.test/same.jpg', pageNumber: 1 },
    ]),
  );
});

test('a tutor retry gets a fresh marking version for the same submitted images', () => {
  const images = [{ url: 'https://storage.test/unclear.jpg', pageNumber: 1 }];
  const first = submissionVersionForRecord({ submittedAt: { toMillis: () => 10 }, aiMarking: { retrySequence: 0 } }, images);
  const retry = submissionVersionForRecord({ submittedAt: { toMillis: () => 10 }, aiMarking: { retrySequence: 1 } }, images);
  assert.notEqual(first, retry);
});

test('tutor retries are allowed for failed and unclear AI marking outcomes only', () => {
  assert.equal(isRetryableAiMarkingStatus('failed'), true);
  assert.equal(isRetryableAiMarkingStatus('unclear_images'), true);
  assert.equal(isRetryableAiMarkingStatus('completed'), false);
  assert.equal(isRetryableAiMarkingStatus('pending'), false);
});

test('peer marking and student marking use distinct instructions', () => {
  assert.notEqual(PEER_MARKING_REVIEW_INSTRUCTIONS, STUDENT_EXERCISE_MARKING_INSTRUCTIONS);
  assert.match(PEER_MARKING_REVIEW_INSTRUCTIONS, /marker's understanding/i);
  assert.match(STUDENT_EXERCISE_MARKING_INSTRUCTIONS, /learner's work/i);
  assert.match(PEER_MARKING_REVIEW_INSTRUCTIONS, /only the peer marker's submitted marking images/i);
  assert.match(PEER_MARKING_REVIEW_INSTRUCTIONS, /never annotate the separate original learner answer images/i);
  assert.match(PEER_MARKING_REVIEW_INSTRUCTIONS, /do not return an empty annotations array just because the peer's decisions are correct/i);
  assert.match(STUDENT_EXERCISE_MARKING_INSTRUCTIONS, /normalized coordinates from 0 to 1/i);
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
