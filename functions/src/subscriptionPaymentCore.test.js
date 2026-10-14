import test from 'node:test';
import assert from 'node:assert/strict';
import { isVerifiedSubscriptionPaymentRecord } from './subscriptionPaymentCore.js';

const quote = { planId: 'circle', billingPeriod: 'monthly', subjectCount: 1, amount: 199, currency: 'ZAR' };
const subscription = { ...quote, status: 'active', amount: 199, latestReference: 'pay-1' };
const payment = { ...quote, reference: 'pay-1', studentId: 'student-1', status: 'success', amount: 199, subscriptionAmountDue: 199 };

test('accepts a successful payment matching the active subscription', () => {
  assert.equal(isVerifiedSubscriptionPaymentRecord({
    studentId: 'student-1', subscription, payment, paymentDocumentId: 'pay-1', quote,
  }), true);
});

test('rejects a payment that belongs to a different plan or student', () => {
  assert.equal(isVerifiedSubscriptionPaymentRecord({
    studentId: 'student-1', subscription, payment: { ...payment, studentId: 'other' }, paymentDocumentId: 'pay-1', quote,
  }), false);
  assert.equal(isVerifiedSubscriptionPaymentRecord({
    studentId: 'student-1', subscription, payment: { ...payment, planId: 'personalized' }, paymentDocumentId: 'pay-1', quote,
  }), false);
});

test('accepts an old family allocation under its own child payment document ID', () => {
  const familySubscription = { ...subscription, latestReference: 'family-group-ref' };
  const allocation = {
    ...payment,
    reference: 'family-group-ref-child-1',
    familyReference: 'family-group-ref',
    familyAllocation: true,
  };
  assert.equal(isVerifiedSubscriptionPaymentRecord({
    studentId: 'student-1', subscription: familySubscription, payment: allocation,
    paymentDocumentId: allocation.reference, quote,
  }), true);
});

test('rejects altered payment amounts and invalid authorization-only charges', () => {
  assert.equal(isVerifiedSubscriptionPaymentRecord({
    studentId: 'student-1', subscription, payment: { ...payment, amount: 1 }, paymentDocumentId: 'pay-1', quote,
  }), false);
  const zeroQuote = { ...quote, amount: 0 };
  const zeroSubscription = { ...subscription, amount: 0 };
  assert.equal(isVerifiedSubscriptionPaymentRecord({
    studentId: 'student-1', subscription: zeroSubscription,
    payment: { ...payment, amount: 1, subscriptionAmountDue: 0, authorizationOnly: true, authorizationChargeAmount: 1 },
    paymentDocumentId: 'pay-1', quote: zeroQuote,
  }), true);
});
