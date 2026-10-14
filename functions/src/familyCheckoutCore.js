import { calculateDiscount, normalizeDiscountCode } from './discountCodesCore.js';

export const MAX_FAMILY_STUDENTS = 20;

export const normalizeFamilySelections = (selections) => {
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > MAX_FAMILY_STUDENTS) {
    throw new Error(`Choose between 1 and ${MAX_FAMILY_STUDENTS} students.`);
  }
  const seen = new Set();
  return selections.map((entry) => {
    const studentId = String(entry?.studentId ?? '').trim();
    if (!studentId || seen.has(studentId)) throw new Error('Each student must be selected only once.');
    seen.add(studentId);
    const planId = String(entry?.planId ?? '');
    if (!['circle', 'personalized'].includes(planId)) throw new Error('Choose a paid subscription plan for every student.');
    const billingPeriod = entry?.billingPeriod === 'yearly' ? 'yearly' : 'monthly';
    const subjectCount = Number(entry?.subjectCount);
    if (!Number.isInteger(subjectCount) || subjectCount < 1 || subjectCount > 20) {
      throw new Error('Choose between 1 and 20 subjects for every student.');
    }
    return {
      studentId,
      planId,
      billingPeriod,
      subjectCount,
      discountCode: normalizeDiscountCode(entry?.discountCode),
    };
  });
};

export const normalizeFamilyDraftSlots = (slots, sharedDiscountCode = '') => {
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > MAX_FAMILY_STUDENTS) {
    throw new Error(`Choose between 1 and ${MAX_FAMILY_STUDENTS} students.`);
  }
  const discountCode = normalizeDiscountCode(sharedDiscountCode);
  return slots.map((entry, index) => {
    const planId = String(entry?.planId ?? '');
    if (!['circle', 'personalized'].includes(planId)) throw new Error('Choose a paid subscription plan for every student.');
    const billingPeriod = entry?.billingPeriod === 'yearly' ? 'yearly' : 'monthly';
    const subjectCount = Number(entry?.subjectCount);
    if (!Number.isInteger(subjectCount) || subjectCount < 1 || subjectCount > 20) {
      throw new Error('Choose between 1 and 20 subjects for every student.');
    }
    return { slotIndex: index, planId, billingPeriod, subjectCount, discountCode };
  });
};

export const quoteFamilySelections = ({ selections, quoteSubscription, discountForQuote }) => {
  const normalized = normalizeFamilySelections(selections);
  const allocations = normalized.map((selection) => {
    const quote = quoteSubscription(selection);
    const discount = selection.discountCode ? discountForQuote(selection, quote) : null;
    const finalAmount = discount?.finalAmount ?? quote.amount;
    const amountMinor = Math.round(Number(finalAmount) * 100);
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error('A family subscription amount is invalid.');
    return {
      ...selection,
      quote,
      discount,
      amount: amountMinor / 100,
      amountMinor,
    };
  });
  const totalMinor = allocations.reduce((sum, entry) => sum + entry.amountMinor, 0);
  if (!Number.isSafeInteger(totalMinor)) throw new Error('The family total is invalid.');
  return { allocations, totalAmount: totalMinor / 100, totalMinor };
};

export const allocateGatewayAmount = ({ totalMinor, authorizationOnly }) => {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) throw new Error('The family total is invalid.');
  if (totalMinor === 0) {
    if (!authorizationOnly) throw new Error('A zero-cost family checkout requires card authorization.');
    return 100;
  }
  if (authorizationOnly) throw new Error('Card-only authorization is valid only when the family total is zero.');
  return totalMinor;
};

export const resolveFamilyGatewayPlan = ({ totalMinor, paymentMode = 'new' }) => {
  if (!['new', 'existing'].includes(paymentMode)) throw new Error('Choose a new or saved payment method.');
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) throw new Error('The family total is invalid.');
  if (paymentMode === 'existing' && totalMinor === 0) {
    return { gatewayAmountMinor: 0, authorizationOnly: false, noChargeAuthorizationUse: true };
  }
  const authorizationOnly = paymentMode === 'new' && totalMinor === 0;
  return {
    gatewayAmountMinor: allocateGatewayAmount({ totalMinor, authorizationOnly }),
    authorizationOnly,
    noChargeAuthorizationUse: false,
  };
};

export const buildFamilyCheckoutReference = (parentId, checkoutId) => {
  const safeParentId = String(parentId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const safeCheckoutId = String(checkoutId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
  if (!safeParentId || !safeCheckoutId) throw new Error('A parent and checkout ID are required.');
  return `family-${safeParentId}-${safeCheckoutId}`;
};

export const calculateFamilyDiscount = (quote, percentOff) => calculateDiscount(quote.amount, Number(percentOff));
