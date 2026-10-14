import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { admin, getDb } from './admin.js';
import { calculateSubscriptionQuote } from './subscriptionPricing.js';
import { calculateDiscount, getDiscountEligibilityError, getDiscountUseCounts, normalizeDiscountCode } from './discountCodesCore.js';
import { normalizeFamilyDraftSlots } from './familyCheckoutCore.js';

const userRef = (db, uid) => db.collection('users').doc(uid);
const draftRef = (db, uid, draftId) => userRef(db, uid).collection('familyCheckoutDrafts').doc(draftId);

const requireParent = async (db, uid) => {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in as a parent to manage a family checkout.');
  const snapshot = await userRef(db, uid).get();
  if (!snapshot.exists || snapshot.data()?.role !== 'parent') throw new HttpsError('permission-denied', 'Only a parent can manage a family checkout.');
  return snapshot.data();
};

const validateDraftId = (value) => {
  const draftId = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(draftId)) throw new HttpsError('invalid-argument', 'A valid family setup ID is required.');
  return draftId;
};

export const saveParentFamilyCheckoutDraft = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const db = getDb();
  const uid = request.auth?.uid;
  await requireParent(db, uid);
  const draftId = validateDraftId(request.data?.draftId);
  let slots;
  try {
    slots = normalizeFamilyDraftSlots(request.data?.slots, request.data?.discountCode);
  } catch (error) {
    throw new HttpsError('invalid-argument', error.message);
  }
  const ref = draftRef(db, uid, draftId);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists && ['students_attached', 'checkout_started', 'completed'].includes(snapshot.data()?.status)) {
      throw new HttpsError('failed-precondition', 'This family setup has already moved past plan selection. Continue from the saved setup instead.');
    }
    transaction.set(ref, {
      draftId,
      parentId: uid,
      status: 'draft',
      slots,
      createdAt: snapshot.exists ? snapshot.data()?.createdAt || admin.firestore.FieldValue.serverTimestamp() : admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)),
    }, { merge: true });
  });
  return { draftId, status: 'draft', slots };
});

export const getParentFamilyCheckoutDraft = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const db = getDb();
  const uid = request.auth?.uid;
  await requireParent(db, uid);
  const draftId = validateDraftId(request.data?.draftId);
  const snapshot = await draftRef(db, uid, draftId).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'The saved family setup was not found.');
  const draft = snapshot.data();
  if (draft.parentId !== uid || draft.expiresAt?.toDate?.() <= new Date()) throw new HttpsError('failed-precondition', 'This family setup has expired. Start a new setup.');
  return { ...draft, id: snapshot.id };
});

export const attachStudentsToParentFamilyCheckoutDraft = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const db = getDb();
  const uid = request.auth?.uid;
  await requireParent(db, uid);
  const draftId = validateDraftId(request.data?.draftId);
  const studentIds = Array.isArray(request.data?.studentIds) ? request.data.studentIds.map((id) => String(id ?? '').trim()) : [];
  if (!studentIds.length || studentIds.length > 20 || studentIds.some((id) => !id) || new Set(studentIds).size !== studentIds.length) {
    throw new HttpsError('invalid-argument', 'Provide one unique linked student for every family slot.');
  }
  const refs = studentIds.map((studentId) => userRef(db, studentId));
  const snapshots = await Promise.all(refs.map((ref) => ref.get()));
  if (snapshots.some((snapshot) => !snapshot.exists || snapshot.data()?.role !== 'student' || snapshot.data()?.parentId !== uid)) {
    throw new HttpsError('permission-denied', 'Every student must be linked to your parent account.');
  }
  const ref = draftRef(db, uid, draftId);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data()?.parentId !== uid) throw new HttpsError('not-found', 'The saved family setup was not found.');
    const draft = snapshot.data();
    if (draft.status === 'completed' || draft.status === 'checkout_started') throw new HttpsError('failed-precondition', 'This family setup can no longer be changed.');
    if (!Array.isArray(draft.slots) || draft.slots.length !== studentIds.length) throw new HttpsError('failed-precondition', 'Create exactly the number of student profiles selected for this family setup.');
    transaction.set(ref, {
      status: 'students_attached',
      studentIds,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return { draftId, status: 'students_attached', studentIds };
});

export const previewParentFamilyDiscount = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const code = normalizeDiscountCode(request.data?.discountCode);
  if (!/^[A-Z0-9]{10}$/.test(code)) throw new HttpsError('invalid-argument', 'Enter a valid 10-character discount code.');
  let slots;
  try {
    slots = normalizeFamilyDraftSlots(request.data?.slots, code);
  } catch (error) {
    throw new HttpsError('invalid-argument', error.message);
  }
  const db = getDb();
  const snapshot = await db.collection('discountCodes').doc(code).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'This discount code was not found.');
  const discountCode = snapshot.data();
  const usage = getDiscountUseCounts(discountCode);
  const quotes = slots.map((slot) => {
    const quote = calculateSubscriptionQuote(slot);
    const issue = getDiscountEligibilityError({
      code: discountCode,
      planId: quote.planId,
      subjectCount: quote.subjectCount,
      now: new Date(),
      previewOnly: true,
    });
    if (issue) return { slotIndex: slot.slotIndex, valid: false, message: issue, originalAmount: quote.amount, finalAmount: quote.amount };
    const discount = calculateDiscount(quote.amount, Number(discountCode.percentOff));
    return { slotIndex: slot.slotIndex, valid: true, ...discount, percentOff: Number(discountCode.percentOff), billingDuration: discountCode.billingDuration || 'recurring' };
  });
  if (!usage.available) return { code, valid: false, message: 'This discount code has no remaining uses.', quotes };
  if (usage.remainingUses !== null && usage.remainingUses < slots.length) {
    return {
      code,
      valid: false,
      message: `This discount has ${usage.remainingUses} use${usage.remainingUses === 1 ? '' : 's'} remaining, but ${slots.length} are needed for this family plan.`,
      quotes,
    };
  }
  const invalid = quotes.find((quote) => !quote.valid);
  return {
    code,
    valid: !invalid,
    ...(invalid ? { message: invalid.message } : {}),
    quotes,
    totalAmount: quotes.reduce((sum, quote) => sum + Number(quote.finalAmount || 0), 0),
  };
});
