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

test('student exercise marking requires evidence-based correctness scoring and rejects attempt-based full marks', () => {
  assert.match(STUDENT_EXERCISE_MARKING_INSTRUCTIONS, /This is an assessment of whether the learner's submitted work is academically correct/i);
  assert.match(STUDENT_EXERCISE_MARKING_INSTRUCTIONS, /Award each allocated mark only when the corresponding answer or required reasoning is correct/i);
  assert.match(STUDENT_EXERCISE_MARKING_INSTRUCTIONS, /Do not award full marks just because an answer is present or the method looks plausible/i);
  assert.match(STUDENT_EXERCISE_MARKING_INSTRUCTIONS, /Before returning a result, check that every awarded mark has evidence/i);
  assert.match(STUDENT_EXERCISE_MARKING_INSTRUCTIONS, /official memo page is supplied.*authoritative rubric/i);
});

test('peer annotation coordinates must sit beside existing marks with a visible gap', () => {
  assert.match(PEER_MARKING_REVIEW_INSTRUCTIONS, /x\/y coordinate identifies the CENTER of the peer marker's existing tick\/cross/i);
  assert.match(PEER_MARKING_REVIEW_INSTRUCTIONS, /renderer will place the AI symbol in nearby whitespace/i);
  assert.match(PEER_MARKING_REVIEW_INSTRUCTIONS, /The AI symbol must be distinct from and beside the peer's original decision/i);
});

test('peer score instructions award the marker for marking accuracy rather than the source answer score', () => {
  assert.match(PEER_MARKING_REVIEW_INSTRUCTIONS, /PEER MARKER'S MARKING-ACCURACY SCORE, never the original learner's earned mark/i);
  assert.match(PEER_MARKING_REVIEW_INSTRUCTIONS, /source answer earns 3\/3 but the peer marker correctly awards credit for only one of three separate one-mark decisions.*return awardedMark 1.*not 3/i);
  assert.match(PEER_MARKING_REVIEW_INSTRUCTIONS, /The source learner's correct answer is evidence used to judge the peer marker; it is not itself the peer marker's score/i);
});

test('existing compact response schema and fields are unchanged', () => {
  assert.deepEqual(Object.keys(AI_MARKING_RESULT_SCHEMA.properties), [
    'status', 'results', 'contextRequests', 'unansweredQuestionIds', 'annotations',
  ]);
  assert.deepEqual(AI_MARKING_RESULT_SCHEMA.required, [
    'status', 'results', 'contextRequests', 'unansweredQuestionIds', 'annotations',
  ]);
});
