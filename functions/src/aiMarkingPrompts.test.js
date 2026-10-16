import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_MARKING_RESULT_SCHEMA,
  PEER_MARKING_REVIEW_INSTRUCTIONS,
  STUDENT_EXERCISE_MARKING_INSTRUCTIONS,
} from './aiMarkingPrompts.js';

test('student annotation coordinates are explicitly directed to clear space beside the learner work', () => {
  assert.match(STUDENT_EXERCISE_MARKING_INSTRUCTIONS, /x\/y coordinate is the CENTER of the symbol/i);
  assert.match(STUDENT_EXERCISE_MARKING_INSTRUCTIONS, /nearest clear side/i);
  assert.match(STUDENT_EXERCISE_MARKING_INSTRUCTIONS, /never place the symbol on top of, across, or between the learner's writing/i);
});

test('peer annotation coordinates must sit beside existing marks with a visible gap', () => {
  assert.match(PEER_MARKING_REVIEW_INSTRUCTIONS, /clear whitespace immediately beside the peer's existing tick\/cross/i);
  assert.match(PEER_MARKING_REVIEW_INSTRUCTIONS, /never place the AI symbol on top of, touching, replacing, erasing, or imitating the peer's original mark/i);
});

test('existing compact response schema and fields are unchanged', () => {
  assert.deepEqual(Object.keys(AI_MARKING_RESULT_SCHEMA.properties), [
    'status', 'results', 'contextRequests', 'unansweredQuestionIds', 'annotations',
  ]);
  assert.deepEqual(AI_MARKING_RESULT_SCHEMA.required, [
    'status', 'results', 'contextRequests', 'unansweredQuestionIds', 'annotations',
  ]);
});
