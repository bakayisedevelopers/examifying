import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeParentStudentSubscriptionSummary } from './parentStudentSummary.js';

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
