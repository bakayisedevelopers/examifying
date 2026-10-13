import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extendTopicOptionsWithDriveLabels,
  normalizeDriveAnalysisTopicLabels,
} from './driveAnalysisTopicLabels.js';

test('accepts a structurally valid Drive topic absent from the approved catalog', () => {
  const labels = normalizeDriveAnalysisTopicLabels({
    values: ['Fraction of a set | Fractions'],
    allowedTopics: ['Fraction addition | Fractions'],
    questionReference: '2.3(b)',
  });

  assert.deepEqual(labels, ['Fraction of a set | Fractions']);
});

test('keeps the approved catalog spelling when a Drive label matches it', () => {
  const labels = normalizeDriveAnalysisTopicLabels({
    values: ['subtraction|operations'],
    allowedTopics: ['Subtraction | Operations'],
    questionReference: '3.2',
  });

  assert.deepEqual(labels, ['Subtraction | Operations']);
});

test('rejects duplicate labels even when their spacing or capitalization differs', () => {
  assert.throws(() => normalizeDriveAnalysisTopicLabels({
    values: ['Fraction of a set | Fractions', 'fraction of a set|fractions'],
    questionReference: '2.3(b)',
  }), /Question 2\.3\(b\) contains duplicate topic labels/);
});

test('rejects labels that do not have exactly two nonempty sides', () => {
  assert.throws(() => normalizeDriveAnalysisTopicLabels({
    values: ['Fractions'],
    questionReference: '2.3(b)',
  }), /Question 2\.3\(b\) contains a topic that is not in Child \| Parent format/);
});

test('adds uncatalogued Drive labels to the effective options without duplicating approved labels', () => {
  assert.deepEqual(extendTopicOptionsWithDriveLabels(
    [{ topic: 'Subtraction | Operations', difficulty: 'easy' }],
    [['Subtraction | Operations', 'Fraction of a set | Fractions']],
  ), [
    { topic: 'Subtraction | Operations', difficulty: 'easy' },
    'Fraction of a set | Fractions',
  ]);
});
