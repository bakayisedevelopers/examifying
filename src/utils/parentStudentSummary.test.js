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
      { status: 'fulfilled', value: [{ id: 'english-today', subject: 'English' }] },
      { status: 'fulfilled', value: [{ id: 'math-today', subject: 'Mathematics' }] },
    ],
    completedLessonResults: [
      { status: 'fulfilled', value: [{ id: 'lesson-one' }] },
      { status: 'fulfilled', value: [{ id: 'lesson-two' }, { id: 'lesson-three' }] },
    ],
  });

  assert.equal(result.todayExercise.id, 'english-today');
  assert.equal(result.todayExercise.subject, 'English');
  assert.equal(result.completedLessonsCount, 3);
  assert.equal(result.todayExerciseUnavailable, false);
  assert.equal(result.completedLessonsUnavailable, false);
});

test('one failed progress read does not discard successful subject progress', () => {
  const result = summarizeParentStudentProgress({
    todayExerciseResults: [
      { status: 'fulfilled', value: [{ id: 'math-today', subject: 'Mathematics' }] },
      { status: 'rejected', reason: new Error('read denied') },
    ],
    completedLessonResults: [
      { status: 'fulfilled', value: [{ id: 'lesson-one' }] },
      { status: 'rejected', reason: new Error('read denied') },
    ],
  });

  assert.equal(result.todayExercise.id, 'math-today');
  assert.equal(result.completedLessonsCount, 1);
  assert.equal(result.todayExerciseUnavailable, true);
  assert.equal(result.completedLessonsUnavailable, true);
});
