import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTopicAverageMarks } from './topicAverageMarks.js';

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
