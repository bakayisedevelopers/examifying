import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../firebase/config';
import { collections } from '../firebase/schema';
import { getActiveSubjectsForStudent, getStudentSubscriptionState } from './firestoreService';
import { normalizeEligibleSubject } from '../utils/tutorSubjects';

const inFlightChecks = new Map();
const VALID_COMPLETION_STATUSES = new Set([
  'incomplete',
  'completed',
  'unpaid_incomplete',
  'paid_incomplete',
  'paid_completed',
]);

const hasQualifyingTutorResult = (profile) => (profile?.tutorSubjectMarks ?? []).some((item) => {
  const subject = normalizeEligibleSubject(item?.subject ?? item?.rawSubject);
  const mark = Number(item?.mark ?? item?.bestMark);
  return Boolean(subject) && Number.isFinite(mark) && mark >= 60 && mark <= 100;
});

const persistStatusIfChanged = async (profile, status) => {
  if (profile?.profileCompletionStatus === status) return profile;
  if (isFirebaseConfigured && db && profile?.uid) {
    await updateDoc(doc(db, collections.users, profile.uid), {
      profileCompletionStatus: status,
      updatedAt: serverTimestamp(),
    });
  }
  return { ...profile, profileCompletionStatus: status };
};

export const reconcileProfileCompletion = (profile) => {
  if (!profile?.uid || !['student', 'tutor', 'teacher'].includes(profile.role)) {
    return Promise.resolve({ profile, subscriptionState: null });
  }

  const activeCheck = inFlightChecks.get(profile.uid);
  if (activeCheck) return activeCheck;

  const request = (async () => {
    if (profile.role === 'tutor' || profile.role === 'teacher') {
      const status = hasQualifyingTutorResult(profile) ? 'completed' : 'incomplete';
      return { profile: await persistStatusIfChanged(profile, status), subscriptionState: null };
    }

    const [subscriptionState, activeSubjects] = await Promise.all([
      getStudentSubscriptionState(profile),
      getActiveSubjectsForStudent(profile.uid),
    ]);
    const verifiedPaidSubscription = subscriptionState?.paymentCompleted === true
      && subscriptionState?.paidSubscriptionActive === true
      && subscriptionState?.subscriptionPaymentVerified === true;
    const status = !verifiedPaidSubscription
      ? 'unpaid_incomplete'
      : activeSubjects.length ? 'paid_completed' : 'paid_incomplete';
    return { profile: await persistStatusIfChanged(profile, status), subscriptionState };
  })().finally(() => {
    if (inFlightChecks.get(profile.uid) === request) inFlightChecks.delete(profile.uid);
  });

  inFlightChecks.set(profile.uid, request);
  return request;
};

export const updateProfileCompletionStatus = async ({ uid, status } = {}) => {
  if (!uid || !VALID_COMPLETION_STATUSES.has(status)) {
    throw new Error('A valid account and profile completion status are required.');
  }
  if (isFirebaseConfigured) {
    await updateDoc(doc(db, collections.users, uid), {
      profileCompletionStatus: status,
      updatedAt: serverTimestamp(),
    });
  }
  return { uid, profileCompletionStatus: status };
};
