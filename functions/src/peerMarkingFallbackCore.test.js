import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPeerWorkImageMetadata,
  selectReusableSystemPeerWork,
  selectReusableSystemPeerWorkWithFallback,
  selectSystemPeerWorkQuestions,
  selectSystemPeerWorkQuestionsWithFallback,
  systemPeerWorkPackId,
  systemPeerWorkCohortKey,
  systemPeerWorkTopicSignature,
  canRegenerateSystemPeerWork,
  validateSystemPeerWorkSolutionResponse,
  validateSystemPeerWorkSolutions,
} from './peerMarkingFallbackCore.js';
import { solveSystemPeerWork } from './peerMarkingFallbackAi.js';
import { questionIdentity } from './aiMarkingCore.js';

const topics = ['Linear functions | Functions', 'Quadratic functions | Functions'];
const paper = (id, subject, grade, questions) => ({
  id, subject, grade, analysisStatus: 'Analyzed', availableForGeneration: true, questions,
});

test('generated image metadata takes its topic from the selected paper question link', () => {
  const metadata = buildSystemPeerWorkImageMetadata({
    question: { questionId: 'paper-1::1.1', questionNumber: '1.1' },
    questionLink: { questionId: 'paper-1::1.1', topic: topics[0] },
    storagePath: 'systemGeneratedPeerWork/pack/question-1.png',
    pageNumber: 1,
    sizeBytes: 512,
  });

  assert.equal(metadata.topic, topics[0]);
  assert.equal(metadata.questionReference, '1.1');
});

test('generated image metadata rejects missing source topics instead of writing undefined to Firestore', () => {
  assert.throws(() => buildSystemPeerWorkImageMetadata({
    question: { questionId: 'paper-1::1.1', questionNumber: '1.1' },
    questionLink: { questionId: 'paper-1::1.1' },
    storagePath: 'systemGeneratedPeerWork/pack/question-1.png',
    pageNumber: 1,
    sizeBytes: 512,
  }), /missing its assigned topic/);
});

test('manual retries get a fresh pack identity while normal pack identities remain stable', () => {
  const input = {
    subject: 'Mathematics', grade: 'Grade 10', topicSignature: 'topics', paperId: 'paper',
    questionLinks: [{ paperId: 'paper', questionReference: '1.1' }],
  };
  const original = systemPeerWorkPackId(input);
  assert.equal(systemPeerWorkPackId(input), original);
  assert.notEqual(systemPeerWorkPackId({ ...input, retryNonce: 'retry-one' }), original);
  assert.notEqual(systemPeerWorkPackId({ ...input, retryNonce: 'retry-two' }), original);
});

test('regeneration is limited to assigned system work that has not been marked', () => {
  assert.equal(canRegenerateSystemPeerWork({ systemGenerated: true, status: 'assigned' }), true);
  assert.equal(canRegenerateSystemPeerWork({ systemGenerated: false, status: 'assigned' }), false);
  assert.equal(canRegenerateSystemPeerWork({ systemGenerated: true, status: 'completed' }), false);
  assert.equal(canRegenerateSystemPeerWork({ systemGenerated: true, status: 'assigned', reviewImageUrl: 'review.png' }), false);
  assert.equal(canRegenerateSystemPeerWork({ systemGenerated: true, status: 'assigned', reviewImages: [{ url: 'review.png' }] }), false);
});

test('saved work is reusable only for the exact normalized subject and grade', () => {
  const pack = { id: 'pack', status: 'ready', subject: 'Mathematics', grade: 'G10', topics: topics.slice(0, 1),
    paperIds: ['paper-a'], questionLinks: [{ questionId: 'q1', topic: topics[0] }], images: [{ questionId: 'q1' }] };
  assert.equal(selectReusableSystemPeerWork([pack], { subject: 'Maths', grade: 'Grade 10', topics })?.pack.id, 'pack');
  assert.equal(selectReusableSystemPeerWork([pack], { subject: 'Mathematics', grade: 'Grade 11', topics }), null);
  assert.equal(systemPeerWorkCohortKey({ subject: 'Maths', grade: 'G10' }), systemPeerWorkCohortKey({ subject: 'Mathematics', grade: 'Grade 10' }));
});

test('new source selection prefers the analyzed paper covering the most requested topics', () => {
  const selected = selectSystemPeerWorkQuestions({
    subject: 'Mathematics', grade: 'Grade 10', topics,
    papers: [
      paper('one-topic', 'Mathematics', 'Grade 10', [
        { questionReference: '1.1', parentQuestion: '1', pageNumber: 2, marks: 3, topic: topics[0] },
      ]),
      paper('both-topics', 'Mathematics', 'G10', [
        { questionReference: '1.1', parentQuestion: '1', pageNumber: 2, marks: 3, topic: topics[0] },
        { questionReference: '2.1', parentQuestion: '2', pageNumber: 4, marks: 5, topic: topics[1] },
      ]),
      paper('wrong-grade', 'Mathematics', 'Grade 11', [
        { questionReference: '1.1', pageNumber: 2, marks: 3, topic: topics[0] },
      ]),
    ],
  });
  assert.equal(selected.paper.id, 'both-topics');
  assert.deepEqual(selected.questionLinks.map((item) => item.topic), topics);
  assert.equal(selected.questionLinks.length, 2);
});

test('a paper already allocated to that day is excluded and missing analysis topics are not fabricated', () => {
  const matching = paper('used-today', 'Mathematics', 'Grade 10', [
    { questionReference: '1.1', parentQuestion: '1', pageNumber: 2, marks: 3, topic: topics[0] },
  ]);
  assert.equal(selectSystemPeerWorkQuestions({ papers: [matching], subject: 'Mathematics', grade: 'Grade 10', topics, excludedPaperIds: new Set(['used-today']) }), null);
});

test('unused matching papers are preferred before same-day papers', () => {
  const usedToday = paper('used-today', 'Mathematics', 'Grade 10', [
    { questionReference: '1.1', pageNumber: 2, marks: 3, topic: topics[0] },
    { questionReference: '1.2', pageNumber: 2, marks: 3, topic: topics[1] },
  ]);
  const unused = paper('unused', 'Mathematics', 'Grade 10', [
    { questionReference: '2.1', pageNumber: 4, marks: 5, topic: topics[0] },
  ]);
  const selected = selectSystemPeerWorkQuestionsWithFallback({
    papers: [usedToday, unused], subject: 'Mathematics', grade: 'Grade 10', topics,
    excludedPaperIds: new Set(['used-today']),
    excludedQuestionIds: new Set([questionIdentity('used-today', '1.1')]),
  });
  assert.equal(selected.sourceSelectionMode, 'unused-paper');
  assert.equal(selected.paper.id, 'unused');
});

test('same-day papers are a last resort and already assigned question references stay excluded', () => {
  const usedToday = paper('used-today', 'Mathematics', 'Grade 10', [
    { questionReference: '1.1', pageNumber: 2, marks: 3, topic: topics[0] },
    { questionReference: '1.2', pageNumber: 3, marks: 4, topic: topics[0] },
  ]);
  const selected = selectSystemPeerWorkQuestionsWithFallback({
    papers: [usedToday], subject: 'Mathematics', grade: 'Grade 10', topics: [topics[0]],
    excludedPaperIds: new Set(['used-today']),
    excludedQuestionIds: new Set([questionIdentity('used-today', '1.1')]),
  });
  assert.equal(selected.sourceSelectionMode, 'same-day-paper-last-resort');
  assert.deepEqual(selected.questionLinks.map((item) => item.questionReference), ['1.2']);
});

test('same-day question reuse is the final last resort when no other matching question exists', () => {
  const usedToday = paper('used-today', 'Mathematics', 'Grade 10', [
    { questionReference: '1.1', pageNumber: 2, marks: 3, topic: topics[0] },
  ]);
  const selected = selectSystemPeerWorkQuestionsWithFallback({
    papers: [usedToday], subject: 'Mathematics', grade: 'Grade 10', topics: [topics[0]],
    excludedPaperIds: new Set(['used-today']),
    excludedQuestionIds: new Set([questionIdentity('used-today', '1.1')]),
  });
  assert.equal(selected.sourceSelectionMode, 'same-day-question-last-resort');
  assert.deepEqual(selected.questionLinks.map((item) => item.questionReference), ['1.1']);
});

test('wrong-subject and wrong-grade papers remain excluded by the repeated-question last resort', () => {
  const selected = selectSystemPeerWorkQuestionsWithFallback({
    papers: [
      paper('wrong-subject', 'Physical Sciences', 'Grade 10', [
        { questionReference: '1.1', pageNumber: 2, marks: 3, topic: topics[0] },
      ]),
      paper('wrong-grade', 'Mathematics', 'Grade 11', [
        { questionReference: '1.1', pageNumber: 2, marks: 3, topic: topics[0] },
      ]),
    ],
    subject: 'Mathematics', grade: 'Grade 10', topics: [topics[0]],
    excludedPaperIds: new Set(['wrong-subject', 'wrong-grade']),
    excludedQuestionIds: new Set([questionIdentity('wrong-subject', '1.1'), questionIdentity('wrong-grade', '1.1')]),
  });
  assert.equal(selected, null);
});

test('saved work using already-assigned questions is reused only after unused options are exhausted', () => {
  const usedPack = {
    id: 'used-pack', status: 'ready', subject: 'Mathematics', grade: 'Grade 10', topics: [topics[0]],
    paperIds: ['used-today'],
    questionLinks: [{ questionId: questionIdentity('used-today', '1.1'), paperId: 'used-today', questionReference: '1.1', topic: topics[0] }],
    images: [{ questionId: questionIdentity('used-today', '1.1') }],
  };
  const unusedPack = {
    ...usedPack, id: 'unused-pack', paperIds: ['unused-paper'],
    questionLinks: [{ questionId: questionIdentity('unused-paper', '1.1'), paperId: 'unused-paper', questionReference: '1.1', topic: topics[0] }],
  };
  const selected = selectReusableSystemPeerWorkWithFallback([usedPack, unusedPack], {
    subject: 'Mathematics', grade: 'Grade 10', topics: [topics[0]],
    excludedPaperIds: new Set(['used-today']),
    excludedQuestionIds: new Set([questionIdentity('used-today', '1.1')]),
  });
  assert.equal(selected.pack.id, 'unused-pack');

  const lastResort = selectReusableSystemPeerWorkWithFallback([usedPack], {
    subject: 'Mathematics', grade: 'Grade 10', topics: [topics[0]],
    excludedPaperIds: new Set(['used-today']),
    excludedQuestionIds: new Set([questionIdentity('used-today', '1.1')]),
  });
  assert.equal(lastResort.pack.id, 'used-pack');
  assert.equal(lastResort.sourceSelectionMode, 'used-question-last-resort');
});

test('fallback topic selection uses the same hierarchical label matching as exercise generation', () => {
  const selected = selectSystemPeerWorkQuestions({
    subject: 'Life Sciences', grade: 'Grade 10',
    topics: ['Scientific Investigation | Scientific Skills'],
    papers: [paper('life-sciences', 'Life Sciences', 'Grade 10', [
      { questionReference: '2.3.1', pageNumber: 10, marks: 2, topic: 'Scientific Investigation' },
    ])],
  });
  assert.equal(selected.questionLinks[0].topic, 'Scientific Investigation | Scientific Skills');
});

test('one multi-topic source question is not duplicated as two separate marking questions', () => {
  const selected = selectSystemPeerWorkQuestions({
    subject: 'Mathematics', grade: 'Grade 10', topics,
    papers: [paper('multi-topic', 'Mathematics', 'Grade 10', [
      { questionReference: '1.1', pageNumber: 2, marks: 4, topics },
    ])],
  });
  assert.equal(selected.questionLinks.length, 1);
  assert.equal(new Set(selected.questionLinks.map((item) => item.questionId)).size, 1);
});

test('reusable work ranks by topic coverage, then by number of prior assignments', () => {
  const packs = [
    { id: 'one', status: 'ready', subject: 'Mathematics', grade: 'Grade 10', topics: [topics[0]], paperIds: ['a'], questionLinks: [{ questionId: 'a', topic: topics[0] }], images: [{ questionId: 'a' }], assignmentCount: 0 },
    { id: 'two', status: 'ready', subject: 'Mathematics', grade: 'Grade 10', topics, paperIds: ['b'], questionLinks: topics.map((topic, index) => ({ questionId: `b${index}`, topic })), images: topics.map((_, index) => ({ questionId: `b${index}` })), assignmentCount: 10 },
  ];
  assert.equal(selectReusableSystemPeerWork(packs, { subject: 'Mathematics', grade: 'Grade 10', topics })?.pack.id, 'two');
  assert.equal(systemPeerWorkTopicSignature(topics), systemPeerWorkTopicSignature([...topics].reverse()));
});

test('reusable work can use a same-day paper but not a question assigned in today’s exercises', () => {
  const pack = {
    id: 'same-day-pack', status: 'ready', subject: 'Mathematics', grade: 'Grade 10', topics: [topics[0]],
    paperId: 'paper-a', paperIds: ['paper-a'],
    questionLinks: [
      { questionId: questionIdentity('paper-a', '1.1'), paperId: 'paper-a', questionReference: '1.1', topic: topics[0] },
      { questionId: questionIdentity('paper-a', '1.2'), paperId: 'paper-a', questionReference: '1.2', topic: topics[0] },
    ],
    images: [{ questionId: questionIdentity('paper-a', '1.1') }, { questionId: questionIdentity('paper-a', '1.2') }],
  };
  const selected = selectReusableSystemPeerWork([pack], {
    subject: 'Mathematics', grade: 'Grade 10', topics: [topics[0]],
    excludedQuestionIds: new Set([questionIdentity('paper-a', '1.1')]),
  });
  assert.deepEqual(selected.questionLinks.map((item) => item.questionReference), ['1.2']);
});

test('solution validation requires exactly one bounded answer per selected question', () => {
  const questionLinks = [{ questionId: 'q1' }, { questionId: 'q2' }];
  const valid = validateSystemPeerWorkSolutions({
    response: { status: 'completed', solutions: [{ questionId: 'q2', solutionText: 'Answer two' }, { questionId: 'q1', solutionText: 'Answer one' }], questionIdsNeedingContext: [] },
    questionLinks,
  });
  assert.equal(valid.length, 2);
  assert.throws(() => validateSystemPeerWorkSolutions({
    response: { status: 'completed', solutions: [{ questionId: 'q1', solutionText: 'Answer' }, { questionId: 'q1', solutionText: 'Duplicate' }], questionIdsNeedingContext: [] },
    questionLinks,
  }));
  assert.throws(() => validateSystemPeerWorkSolutions({
    response: { status: 'completed', solutions: [{ questionId: 'q1', solutionText: 'Answer' }], questionIdsNeedingContext: [] }, questionLinks,
  }));
});

test('solution generation makes one primary request for the whole pack with the source PDF', async () => {
  const sourcePdf = { fileName: 'source.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-test') };
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const result = await solveSystemPeerWork({
    questions: [{ questionId: 'q1' }, { questionId: 'q2' }], sourcePdf,
    callPrimary: async ({ questions, sourcePdf: sentPdf }) => {
      primaryCalls += 1;
      assert.equal(questions.length, 2);
      assert.equal(sentPdf, sourcePdf);
      return { status: 'completed', solutions: questions.map(({ questionId }) => ({ questionId, solutionText: 'Worked answer' })), questionIdsNeedingContext: [] };
    },
    callFallback: async () => { fallbackCalls += 1; throw new Error('Should not be called'); },
  });
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(result.solutions.length, 2);
  assert.equal(result.fallbackUsed, false);
});

test('Gemini is called once for the same complete pack when the primary provider fails', async () => {
  let fallbackQuestions = 0;
  const sourcePdf = { fileName: 'source.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-test') };
  const result = await solveSystemPeerWork({
    questions: [{ questionId: 'q1' }], sourcePdf,
    callPrimary: async () => { throw new Error('Primary unavailable'); },
    callFallback: async ({ questions, sourcePdf: sentPdf }) => {
      fallbackQuestions = questions.length;
      assert.equal(sentPdf, sourcePdf);
      return { status: 'completed', solutions: [{ questionId: 'q1', solutionText: 'Worked answer' }], questionIdsNeedingContext: [] };
    },
  });
  assert.equal(fallbackQuestions, 1);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.provider, 'gemini');
});

test('source-page refusal becomes a request for broader context instead of publishable work', () => {
  const response = validateSystemPeerWorkSolutionResponse({
    questionLinks: [{ questionId: 'q1' }, { questionId: 'q2' }],
    response: {
      status: 'completed',
      solutions: [
        { questionId: 'q1', solutionText: 'No visible question or text on page 5.' },
        { questionId: 'q2', solutionText: 'x = 4' },
      ],
      questionIdsNeedingContext: [],
    },
  });
  assert.equal(response.status, 'needs_context');
  assert.deepEqual(response.questionIdsNeedingContext, ['q1']);
  assert.deepEqual(response.solutions, [{ questionId: 'q2', solutionText: 'x = 4' }]);
});

test('the reported empty-page refusal is never published as a worked answer', () => {
  const response = validateSystemPeerWorkSolutionResponse({
    questionLinks: [{ questionId: 'q1' }],
    response: {
      status: 'completed',
      solutions: [{ questionId: 'q1', solutionText: 'There was no question to answer in the page supplied.' }],
      questionIdsNeedingContext: [],
    },
  });
  assert.equal(response.status, 'needs_context');
  assert.deepEqual(response.solutions, []);
  assert.deepEqual(response.questionIdsNeedingContext, ['q1']);
});

test('a model that cannot locate the question in the PDF triggers the provider fallback with the same PDF', async () => {
  const sourcePdf = { fileName: 'source.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-test') };
  let fallbackCalls = 0;
  const result = await solveSystemPeerWork({
    questions: [{ questionId: 'q1', paperId: 'paper-a', questionNumber: '2.1' }],
    sourcePdf,
    callPrimary: async () => ({
      status: 'needs_context', solutions: [], questionIdsNeedingContext: ['q1'],
    }),
    callFallback: async ({ sourcePdf: fallbackPdf, questions }) => {
      fallbackCalls += 1;
      assert.equal(fallbackPdf, sourcePdf);
      assert.deepEqual(questions.map(({ questionNumber }) => questionNumber), ['2.1']);
      return { status: 'completed', solutions: [{ questionId: 'q1', solutionText: 'Worked answer' }], questionIdsNeedingContext: [] };
    },
  });
  assert.equal(fallbackCalls, 1);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.fallbackUsed, true);
});

test('generation fails rather than publishing an answer when both providers cannot find the question in the PDF', async () => {
  const sourcePdf = { fileName: 'source.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-test') };
  await assert.rejects(() => solveSystemPeerWork({
    questions: [{ questionId: 'q1' }],
    sourcePdf,
    callPrimary: async () => ({ status: 'needs_context', solutions: [], questionIdsNeedingContext: ['q1'] }),
    callFallback: async () => ({ status: 'needs_context', solutions: [], questionIdsNeedingContext: ['q1'] }),
  }), /could not locate every selected question/);
});
