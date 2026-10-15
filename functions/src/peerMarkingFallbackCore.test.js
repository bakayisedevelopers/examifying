import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectReusableSystemPeerWork,
  selectSystemPeerWorkQuestions,
  selectSystemPeerWorkQuestionsWithFallback,
  systemPeerWorkCohortKey,
  systemPeerWorkTopicSignature,
  validateSystemPeerWorkSolutions,
} from './peerMarkingFallbackCore.js';
import { solveSystemPeerWork } from './peerMarkingFallbackAi.js';
import { questionIdentity } from './aiMarkingCore.js';

const topics = ['Linear functions | Functions', 'Quadratic functions | Functions'];
const paper = (id, subject, grade, questions) => ({
  id, subject, grade, analysisStatus: 'Analyzed', availableForGeneration: true, questions,
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

test('same-day last resort does not repeat the only question already assigned today', () => {
  const usedToday = paper('used-today', 'Mathematics', 'Grade 10', [
    { questionReference: '1.1', pageNumber: 2, marks: 3, topic: topics[0] },
  ]);
  assert.equal(selectSystemPeerWorkQuestionsWithFallback({
    papers: [usedToday], subject: 'Mathematics', grade: 'Grade 10', topics: [topics[0]],
    excludedPaperIds: new Set(['used-today']),
    excludedQuestionIds: new Set([questionIdentity('used-today', '1.1')]),
  }), null);
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
    response: { status: 'completed', solutions: [{ questionId: 'q2', solutionText: 'Answer two' }, { questionId: 'q1', solutionText: 'Answer one' }] },
    questionLinks,
  });
  assert.equal(valid.length, 2);
  assert.throws(() => validateSystemPeerWorkSolutions({
    response: { status: 'completed', solutions: [{ questionId: 'q1', solutionText: 'Answer' }, { questionId: 'q1', solutionText: 'Duplicate' }] },
    questionLinks,
  }));
  assert.throws(() => validateSystemPeerWorkSolutions({
    response: { status: 'completed', solutions: [{ questionId: 'q1', solutionText: 'Answer' }] }, questionLinks,
  }));
});

test('solution generation makes one primary request for the whole pack', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const result = await solveSystemPeerWork({
    questions: [{ questionId: 'q1' }, { questionId: 'q2' }], contextPages: [{ pageNumber: 1 }],
    callPrimary: async ({ questions, contextPages }) => {
      primaryCalls += 1;
      assert.equal(questions.length, 2);
      assert.equal(contextPages.length, 1);
      return { status: 'completed', solutions: questions.map(({ questionId }) => ({ questionId, solutionText: 'Worked answer' })) };
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
  const result = await solveSystemPeerWork({
    questions: [{ questionId: 'q1' }], contextPages: [],
    callPrimary: async () => { throw new Error('Primary unavailable'); },
    callFallback: async ({ questions }) => {
      fallbackQuestions = questions.length;
      return { status: 'completed', solutions: [{ questionId: 'q1', solutionText: 'Worked answer' }] };
    },
  });
  assert.equal(fallbackQuestions, 1);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.provider, 'gemini');
});
