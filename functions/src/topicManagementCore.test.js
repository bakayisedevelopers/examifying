import test from 'node:test';
import assert from 'node:assert/strict';
import { getLessonTopicRemoval, normalizeTopicKey } from './topicManagementCore.js';

test('topic keys match the existing topic catalogue normalization', () => {
  assert.equal(normalizeTopicKey("Student's Energy & Motion"), 'student energy and motion');
});

test('deleting a selected topic removes lesson, score, and primary-topic references while retaining other topics', () => {
  const result = getLessonTopicRemoval({
    status: 'completed',
    topic: 'Algebra',
    topics: ['Algebra', 'Fractions'],
    topicUnderstandingScores: [
      { topic: 'Algebra', understandingLevel: 0.8 },
      { topic: 'Fractions', understandingLevel: 0.6 },
    ],
  }, new Set(['algebra']));
  assert.equal(result.changed, true);
  assert.deepEqual(result.remainingTopics, ['Fractions']);
  assert.deepEqual(result.remainingScores, [{ topic: 'Fractions', understandingLevel: 0.6 }]);
  assert.equal(result.clearPrimaryTopic, true);
  assert.equal(result.resetCompletion, false);
});

test('deleting the last recorded topic resets its completed lesson state', () => {
  const result = getLessonTopicRemoval({
    status: 'completed', topic: 'Algebra', topics: ['Algebra'],
    topicUnderstandingScores: [{ topic: 'Algebra', understandingLevel: 0.8 }],
  }, new Set(['algebra']));
  assert.equal(result.remainingTopics.length, 0);
  assert.equal(result.resetCompletion, true);
});

test('a lesson with no selected topic is left untouched', () => {
  assert.equal(getLessonTopicRemoval({ topics: ['Geometry'] }, new Set(['algebra'])).changed, false);
});
