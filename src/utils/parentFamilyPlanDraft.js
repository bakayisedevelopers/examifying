export const normalizeParentFamilyPlanDraft = (value, expectedDraftId = '') => {
  const draftId = String(value?.draftId || '').trim();
  if (!draftId || (expectedDraftId && draftId !== expectedDraftId)) {
    throw new Error('The saved family plan could not be matched to this signup.');
  }
  if (!Array.isArray(value?.slots) || value.slots.length < 1 || value.slots.length > 20) {
    throw new Error('The family plan must contain between 1 and 20 student plans.');
  }

  const slots = value.slots.map((slot) => {
    const planId = String(slot?.planId || '');
    if (!['circle', 'personalized'].includes(planId)) throw new Error('Choose a valid plan for every student.');
    const billingPeriod = slot?.billingPeriod === 'yearly' ? 'yearly' : 'monthly';
    const subjectCount = Number(slot?.subjectCount);
    if (!Number.isInteger(subjectCount) || subjectCount < 1 || subjectCount > 20) {
      throw new Error('Choose between 1 and 20 subjects for every student.');
    }
    return { planId, billingPeriod, subjectCount };
  });
  const discountCode = String(value.discountCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return { draftId, discountCode, slots };
};

export const encodeParentFamilyPlanDraft = (value) => JSON.stringify(normalizeParentFamilyPlanDraft(value));

export const decodeParentFamilyPlanDraft = (serialized, expectedDraftId = '') => {
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('The saved family plan could not be read. Return to parent pricing and build it again.');
  }
  return normalizeParentFamilyPlanDraft(parsed, expectedDraftId);
};

const asDate = (value) => {
  if (value?.toDate) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return null;
};

export const hasCurrentPaidParentStudentSubscription = (student, now = new Date()) => {
  // Only a positively verified subscription summary may schedule a plan change.
  // Raw user documents can retain stale payment fields if the subscription read
  // failed; treating those as paid can delay a free student's first activation.
  if (student?.summaryUnavailable === true || student?.paidSubscriptionActive !== true) return false;
  if (!['circle', 'personalized'].includes(student?.subscriptionPlanId)
    || student?.subscriptionStatus !== 'active'
    || student?.paymentCompleted !== true) return false;
  const renewalDate = asDate(student.subscriptionRenewalDate);
  return renewalDate instanceof Date && !Number.isNaN(renewalDate.getTime()) && renewalDate > now;
};

export const partitionParentGroupCheckoutEntries = (entries = [], students = [], now = new Date()) => {
  const studentsById = new Map(students.map((student) => [student.uid, student]));
  return entries.reduce((groups, entry) => {
    const student = studentsById.get(entry.studentId);
    const group = hasCurrentPaidParentStudentSubscription(student, now) ? 'activePaid' : 'immediate';
    groups[group].push(entry);
    return groups;
  }, { activePaid: [], immediate: [] });
};

export const getSharedParentFamilyDiscountCode = (entries = []) => {
  const codes = [...new Set(entries.map((entry) => String(entry.selection?.discountCode || '').trim().toUpperCase()).filter(Boolean))];
  if (codes.length > 1) {
    throw new Error('Group checkout supports one discount code at a time. Check out students with different codes separately.');
  }
  return codes[0] || '';
};
