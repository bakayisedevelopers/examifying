import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeParentFamilyPlanDraft,
  encodeParentFamilyPlanDraft,
  getSharedParentFamilyDiscountCode,
  hasCurrentPaidParentStudentSubscription,
  partitionParentGroupCheckoutEntries,
} from './parentFamilyPlanDraft.js';

test('family signup state round-trips all student plan slots and the shared discount', () => {
  const draft = {
    draftId: 'family-draft-123',
    discountCode: 'offer-2026',
    slots: [
      { planId: 'circle', billingPeriod: 'monthly', subjectCount: 2 },
      { planId: 'personalized', billingPeriod: 'yearly', subjectCount: 1 },
    ],
  };
  assert.deepEqual(decodeParentFamilyPlanDraft(encodeParentFamilyPlanDraft(draft), draft.draftId), {
    draftId: 'family-draft-123',
    discountCode: 'OFFER2026',
    slots: draft.slots,
  });
});

test('family signup state rejects a mismatched draft and malformed student plan', () => {
  const serialized = JSON.stringify({ draftId: 'other-draft', discountCode: '', slots: [{ planId: 'circle', subjectCount: 1 }] });
  assert.throws(() => decodeParentFamilyPlanDraft(serialized, 'family-draft-123'), /could not be matched/);
  assert.throws(() => encodeParentFamilyPlanDraft({ draftId: 'family-draft-123', slots: [{ planId: 'free', subjectCount: 0 }] }), /valid plan/);
});

test('parent uses immediate family checkout for free or expired plans, scheduling only current paid plans', () => {
  const now = new Date('2026-10-14T00:00:00Z');
  assert.equal(hasCurrentPaidParentStudentSubscription({
    subscriptionPlanId: 'circle', subscriptionStatus: 'active', paymentCompleted: true,
    paidSubscriptionActive: true,
    subscriptionRenewalDate: new Date('2026-11-14T00:00:00Z'),
  }, now), true);
  assert.equal(hasCurrentPaidParentStudentSubscription({
    subscriptionPlanId: 'free', subscriptionStatus: 'active', paymentCompleted: false,
  }, now), false);
  assert.equal(hasCurrentPaidParentStudentSubscription({
    subscriptionPlanId: 'circle', subscriptionStatus: 'active', paymentCompleted: false,
    subscriptionRenewalDate: new Date('2026-11-14T00:00:00Z'),
  }, now), false);
  assert.equal(hasCurrentPaidParentStudentSubscription({
    subscriptionPlanId: 'circle', subscriptionStatus: 'active', paymentCompleted: true,
    paidSubscriptionActive: true,
    subscriptionRenewalDate: new Date('2026-10-13T00:00:00Z'),
  }, now), false);
});

test('group checkout keeps free and unverified students out of scheduled plan changes', () => {
  const now = new Date('2026-10-14T00:00:00Z');
  const entries = [
    { studentId: 'paid', selection: { planId: 'personalized' } },
    { studentId: 'free', selection: { planId: 'circle' } },
    { studentId: 'unverified', selection: { planId: 'circle' } },
    { studentId: 'stale', selection: { planId: 'circle' } },
  ];
  const students = [
    { uid: 'paid', subscriptionPlanId: 'circle', subscriptionStatus: 'active', paymentCompleted: true, paidSubscriptionActive: true, subscriptionRenewalDate: new Date('2026-11-14T00:00:00Z') },
    { uid: 'free', subscriptionPlanId: 'free', subscriptionStatus: 'active', paymentCompleted: false, paidSubscriptionActive: false },
    { uid: 'unverified', subscriptionPlanId: 'circle', subscriptionStatus: 'active', paymentCompleted: true, subscriptionRenewalDate: new Date('2026-11-14T00:00:00Z'), summaryUnavailable: true },
    { uid: 'stale', subscriptionPlanId: 'circle', subscriptionStatus: 'active', paymentCompleted: true, paidSubscriptionActive: false, subscriptionRenewalDate: new Date('2026-11-14T00:00:00Z') },
  ];
  const partition = partitionParentGroupCheckoutEntries(entries, students, now);
  assert.deepEqual(partition.activePaid.map(({ studentId }) => studentId), ['paid']);
  assert.deepEqual(partition.immediate.map(({ studentId }) => studentId), ['free', 'unverified', 'stale']);
});

test('family group checkout preserves a shared discount and rejects mixed codes', () => {
  assert.equal(getSharedParentFamilyDiscountCode([
    { selection: { discountCode: ' SAVE2026 ' } },
    { selection: { discountCode: 'save2026' } },
    { selection: { discountCode: '' } },
  ]), 'SAVE2026');
  assert.throws(() => getSharedParentFamilyDiscountCode([
    { selection: { discountCode: 'SAVE2026' } },
    { selection: { discountCode: 'OTHER2026' } },
  ]), /one discount code/);
});
