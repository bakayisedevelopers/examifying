import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSubscriptionQuote } from './subscriptionPricing.js';
import { calculateDiscount } from './discountCodesCore.js';
import {
  allocateGatewayAmount,
  buildFamilyCheckoutReference,
  normalizeFamilySelections,
  quoteFamilySelections,
  resolveFamilyGatewayPlan,
} from './familyCheckoutCore.js';

test('family selections require unique linked student IDs and valid per-student choices', () => {
  assert.deepEqual(normalizeFamilySelections([
    { studentId: 'student-a', planId: 'circle', subjectCount: 1 },
    { studentId: 'student-b', planId: 'personalized', billingPeriod: 'yearly', subjectCount: 3 },
  ]), [
    { studentId: 'student-a', planId: 'circle', billingPeriod: 'monthly', subjectCount: 1, discountCode: '' },
    { studentId: 'student-b', planId: 'personalized', billingPeriod: 'yearly', subjectCount: 3, discountCode: '' },
  ]);
  assert.throws(() => normalizeFamilySelections([
    { studentId: 'same', planId: 'circle', subjectCount: 1 },
    { studentId: 'same', planId: 'circle', subjectCount: 1 },
  ]), /only once/);
  assert.throws(() => normalizeFamilySelections([{ studentId: 'a', planId: 'free', subjectCount: 0 }]), /paid subscription/);
});

test('family total applies different plans, subjects, and discounts per student in minor units', () => {
  const result = quoteFamilySelections({
    selections: [
      { studentId: 'a', planId: 'circle', subjectCount: 2, discountCode: 'ABCDEF1234' },
      { studentId: 'b', planId: 'personalized', subjectCount: 1 },
    ],
    quoteSubscription: calculateSubscriptionQuote,
    discountForQuote: (_selection, quote) => calculateDiscount(quote.amount, 50),
  });
  assert.equal(result.allocations[0].amount, 124);
  assert.equal(result.allocations[1].amount, 999);
  assert.equal(result.totalAmount, 1123);
  assert.equal(result.totalMinor, 112300);
});

test('zero family total uses a single R1 authorization and never an accidental zero Paystack charge', () => {
  assert.equal(allocateGatewayAmount({ totalMinor: 0, authorizationOnly: true }), 100);
  assert.throws(() => allocateGatewayAmount({ totalMinor: 0, authorizationOnly: false }), /requires card authorization/);
  assert.equal(allocateGatewayAmount({ totalMinor: 1500, authorizationOnly: false }), 1500);
});

test('existing cards are reused for paid family totals and zero totals do not charge them', () => {
  assert.deepEqual(resolveFamilyGatewayPlan({ totalMinor: 0, paymentMode: 'existing' }), {
    gatewayAmountMinor: 0, authorizationOnly: false, noChargeAuthorizationUse: true,
  });
  assert.deepEqual(resolveFamilyGatewayPlan({ totalMinor: 24900, paymentMode: 'existing' }), {
    gatewayAmountMinor: 24900, authorizationOnly: false, noChargeAuthorizationUse: false,
  });
  assert.deepEqual(resolveFamilyGatewayPlan({ totalMinor: 0, paymentMode: 'new' }), {
    gatewayAmountMinor: 100, authorizationOnly: true, noChargeAuthorizationUse: false,
  });
});

test('family references are stable for retries and constrained to safe characters', () => {
  assert.equal(buildFamilyCheckoutReference('parent/unsafe', 'draft:123'), 'family-parentunsafe-draft123');
});
