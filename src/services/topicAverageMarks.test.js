import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGlobalTopicPlanningSummary, calculateTopicAverageMarks } from './topicAverageMarks.js';

test('averages allocated topic marks per analyzed paper', () => {
  const result = calculateTopicAverageMarks('Linear Equations | Algebra', [
    { analysisStatus: 'Analyzed', questions: [
      { topics: ['Linear Equations | Algebra'], marks: 3 },
      { topic: 'Linear Equations | Algebra', marks: 2 },
      { topic: 'Quadratic Equations | Algebra', marks: 8 },
    ] },
    { analysisStatus: 'Analyzed', questions: [
      { topic: 'Linear Equations | Algebra', marks: 7 },
    ] },
    { analysisStatus: 'Needs review', questions: [
      { topic: 'Linear Equations | Algebra', marks: 100 },
    ] },
  ]);

  assert.equal(result, 6);
});

test('uses at most twenty analyzed papers that contain the topic', () => {
  const papers = Array.from({ length: 23 }, (_, index) => ({
    analysisStatus: 'Analyzed',
    questions: [{ topic: 'Fractions | Number', marks: index + 1 }],
  }));
  papers.unshift({ analysisStatus: 'Analyzed', questions: [{ topic: 'Other | Topic', marks: 200 }] });

  assert.equal(calculateTopicAverageMarks('Fractions | Number', papers), 10.5);
});

test('returns null when no analyzed paper has allocated marks for the topic', () => {
  assert.equal(calculateTopicAverageMarks('Fractions | Number', [
    { analysisStatus: 'Analyzed', questions: [{ topic: 'Other | Topic', marks: 3 }] },
    { analysisStatus: 'Analyzed', questions: [{ topic: 'Fractions | Number' }] },
    { analysisStatus: 'Needs review', questions: [{ topic: 'Fractions | Number', marks: 4 }] },
  ]), null);
});

test('uses one shared paper sample and counts absent topics as zero in its average', () => {
  const summary = calculateGlobalTopicPlanningSummary(['Topic A', 'Topic B'], [
    { analysisStatus: 'Analyzed', questions: [
      { topic: 'Topic A', marks: 6 },
      { topic: 'Topic B', marks: 4 },
    ] },
    { analysisStatus: 'Analyzed', questions: [{ topic: 'Topic B', marks: 10 }] },
    { analysisStatus: 'Needs review', questions: [{ topic: 'Topic A', marks: 100 }] },
  ], { random: () => 0.999 });

  assert.equal(summary.samplePaperCount, 2);
  assert.equal(summary.averagePaperMarks, 10);
  assert.deepEqual(summary.topics, [
    { topic: 'Topic A', averageMarks: 3 },
    { topic: 'Topic B', averageMarks: 7 },
  ]);
});

test('splits shared-question marks across topics to avoid double-counting', () => {
  const summary = calculateGlobalTopicPlanningSummary(['Topic A', 'Topic B'], [
    { analysisStatus: 'Analyzed', questions: [{ topics: ['Topic A', 'Topic B'], marks: 6 }] },
  ], { random: () => 0.999 });

  assert.equal(summary.averagePaperMarks, 6);
  assert.deepEqual(summary.topics.map((item) => item.averageMarks), [3, 3]);
});

test('randomly samples no more than twenty analyzed papers for the planning comparison', () => {
  const papers = Array.from({ length: 25 }, (_, index) => ({
    analysisStatus: 'Analyzed',
    questions: [{ topic: 'Topic A', marks: index + 1 }],
  }));
  const summary = calculateGlobalTopicPlanningSummary(['Topic A'], papers, { random: () => 0.999 });

  assert.equal(summary.samplePaperCount, 20);
  assert.equal(summary.averagePaperMarks, 10.5);
  assert.equal(summary.topics[0].averageMarks, 10.5);
});
