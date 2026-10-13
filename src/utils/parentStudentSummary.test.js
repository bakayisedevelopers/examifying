import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeParentStudentSubscriptionSummary, summarizeParentStudentProgress } from './parentStudentSummary.js';

test('a verified student subscription remains paid when the default subject has no active episode', () => {
  const result = mergeParentStudentSubscriptionSummary(
    { paymentCompleted: false, paidSubscriptionActive: false, subjectEpisode: null, subjectNotIncluded: true },
    { paymentCompleted: true, paidSubscriptionActive: true, subscriptionPlanId: 'personalized', subscriptionPlanName: 'Personalized' },
  );
  assert.equal(result.paymentCompleted, true);
  assert.equal(result.paidSubscriptionActive, true);
  assert.equal(result.subjectEpisode, null);
  assert.equal(result.subjectNotIncluded, true);
  assert.equal(result.subscriptionPlanName, 'Personalized');
});

test('parent progress combines results from all successful subject reads', () => {
  const result = summarizeParentStudentProgress({
    todayExerciseResults: [
      { status: 'fulfilled', value: { id: 'english-today', subject: 'English' } },
      { status: 'fulfilled', value: { id: 'math-today', subject: 'Mathematics' } },
      { status: 'fulfilled', value: null },
    ],
    completedTopicResults: [
      { status: 'fulfilled', value: [{ topic: 'Fractions', topicStatus: 'done' }] },
      { status: 'fulfilled', value: [{ topic: 'Decimals', topicStatus: 'done' }, { topic: 'Algebra', topicStatus: 'marked' }] },
    ],
  });

  assert.equal(result.todayExercise.id, 'english-today');
  assert.equal(result.todayExercise.subject, 'English');
  assert.equal(result.completedTopicsCount, 2);
  assert.equal(result.todayExerciseUnavailable, false);
  assert.equal(result.completedTopicsUnavailable, false);
});

test('one failed progress read does not discard successful subject progress', () => {
  const result = summarizeParentStudentProgress({
    todayExerciseResults: [
      { status: 'fulfilled', value: { id: 'math-today', subject: 'Mathematics' } },
      { status: 'rejected', reason: new Error('read denied') },
    ],
    completedTopicResults: [
      { status: 'fulfilled', value: [{ topic: 'Fractions', topicStatus: 'done' }] },
      { status: 'rejected', reason: new Error('read denied') },
    ],
  });

  assert.equal(result.todayExercise.id, 'math-today');
  assert.equal(result.completedTopicsCount, 1);
  assert.equal(result.todayExerciseUnavailable, true);
  assert.equal(result.completedTopicsUnavailable, true);
});
