import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  updatePassword,
  deleteUser,
} from 'firebase/auth';
import { deleteField, doc, getDoc as firebaseGetDoc, runTransaction, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { auth, db, functions, isFirebaseConfigured } from '../firebase/config';
import { collections } from '../firebase/schema';
import { mockUsers } from '../data/mockData';
import { normalizeWhatsAppNumber } from '../utils/whatsapp';
import { LEGAL_POLICY_VERSION } from '../lib/legalPolicyVersion';
import { trackFirestoreRead } from './performanceTelemetry';

const provider = isFirebaseConfigured ? new GoogleAuthProvider() : null;
provider?.addScope('email');
const profileRequests = new Map();

export const loginWithEmail = async ({ email, password }) => {
  if (!auth) throw new Error('Firebase not configured. Please set up environment variables.');
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const profile = await getUserProfile(credential.user.uid);
  if (!profile) {
    await signOut(auth);
    throw new Error('This login has no Examify profile. Contact an administrator to restore the account link.');
  }
  return { user: credential.user, profile };
};

export const registerWithEmail = async ({ fullName, email, password, role, extraProfile = {}, legalAcceptance }) => {
  if (!auth) throw new Error('Firebase not configured. Please set up environment variables.');
  if (!['student', 'tutor', 'teacher', 'parent'].includes(role)) throw new Error('Choose a valid account type.');
  if (legalAcceptance?.termsAccepted !== true || legalAcceptance?.privacyNoticeAcknowledged !== true
    || !legalAcceptance?.version) {
    throw new Error('Please accept the current Terms of Use and acknowledge the Privacy Policy before creating an account.');
  }
  const isTutorRole = role === 'tutor' || role === 'teacher';
  const marketingEmailOptIn = extraProfile.marketingEmailOptIn === true;
  const whatsappNumber = role === 'student' ? normalizeWhatsAppNumber(extraProfile.whatsappNumber) : '';
  const tutorWhatsAppNumber = isTutorRole ? normalizeWhatsAppNumber(extraProfile.whatsappNumber) : '';
  const safeExtraProfile = Object.fromEntries(Object.entries(extraProfile)
    .filter(([key]) => key !== 'marketingEmailOptIn' && (!isTutorRole || key !== 'whatsappNumber')));
  const studentDefaults = role === 'student'
    ? {
      paymentCompleted: false,
      subscriptionStatus: 'pending',
      profileCompletionStatus: 'unpaid_incomplete',
    }
    : {};

  const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
  const profile = Object.fromEntries(Object.entries({
    ...safeExtraProfile,
    ...studentDefaults,
    uid: credential.user.uid,
    email: credential.user.email || email.trim(),
    emailLowercase: (credential.user.email || email.trim()).toLowerCase(),
    displayName: fullName.trim(),
    role,
    accountSetupStatus: 'completed',
    marketingEmailOptIn,
    termsAccepted: true,
    termsAcceptedAt: serverTimestamp(),
    termsVersion: legalAcceptance.version,
    privacyNoticeAcknowledged: true,
    privacyNoticeAcknowledgedAt: serverTimestamp(),
    privacyNoticeVersion: legalAcceptance.version,
    ...(isTutorRole ? { subject: null, subjects: [] } : {}),
    ...(isTutorRole ? { profileCompletionStatus: 'incomplete' } : {}),
    isTeacher: role === 'teacher' || extraProfile.isTeacher === true || extraProfile.isTeacher === 'true',
    createdAt: serverTimestamp(),
    ...(role === 'student' ? { whatsappNumber } : {}),
  }).filter(([, value]) => value !== undefined));

  try {
    await updateProfile(credential.user, { displayName: fullName.trim() });
    await setDoc(doc(db, collections.users, credential.user.uid), profile);
    if (isTutorRole) {
      if (!functions) throw new Error('Firebase Functions are not configured. Tutor WhatsApp setup is temporarily unavailable.');
      await httpsCallable(functions, 'saveTutorWhatsAppNumber')({ whatsappNumber: tutorWhatsAppNumber });
    }
    return { user: credential.user, profile };
  } catch (error) {
    try {
      await deleteUser(credential.user);
    } catch {
      // Preserve the original profile creation error if account cleanup also fails.
    }
    throw error;
  }
};

export const registerWithGoogle = async ({ role, marketingEmailOptIn = false } = {}) => {
  if (!auth || !db) throw new Error('Firebase is not configured. Please set up environment variables.');
  if (!['student', 'tutor', 'teacher', 'parent'].includes(role)) throw new Error('Choose a valid account type.');

  const credential = await signInWithPopup(auth, provider);
  if (!credential.user.email) {
    await signOut(auth);
    throw new Error('Google did not provide an email address. Allow email sharing in Google and try again.');
  }
  const profileRef = doc(db, collections.users, credential.user.uid);
  const effectiveRole = role === 'teacher' ? 'tutor' : role;
  const isTeacher = role === 'teacher';
  const setupRequired = ['student', 'tutor', 'teacher'].includes(role);
  const initialProfile = {
    uid: credential.user.uid,
    email: credential.user.email || '',
    emailLowercase: (credential.user.email || '').toLowerCase(),
    displayName: credential.user.displayName?.trim() || '',
    photoURL: credential.user.photoURL || '',
    role: effectiveRole,
    isTeacher,
    accountSetupStatus: setupRequired ? 'required' : 'completed',
    marketingEmailOptIn: marketingEmailOptIn === true,
    termsAccepted: true,
    termsAcceptedAt: serverTimestamp(),
    termsVersion: LEGAL_POLICY_VERSION,
    privacyNoticeAcknowledged: true,
    privacyNoticeAcknowledgedAt: serverTimestamp(),
    privacyNoticeVersion: LEGAL_POLICY_VERSION,
    createdAt: serverTimestamp(),
    ...(effectiveRole === 'student' ? {
      paymentCompleted: false,
      subscriptionStatus: 'pending',
      profileCompletionStatus: 'unpaid_incomplete',
    } : {}),
    ...(effectiveRole === 'tutor' ? {
      profileCompletionStatus: 'incomplete',
      subject: null,
      subjects: [],
    } : {}),
  };

  try {
    const created = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(profileRef);
      if (snapshot.exists()) return false;
      transaction.set(profileRef, initialProfile);
      return true;
    });
    profileRequests.delete(credential.user.uid);
    const profileSnapshot = await firebaseGetDoc(profileRef);
    const profile = profileSnapshot.exists() ? profileSnapshot.data() : null;
    if (!profile) throw new Error('Your Google account was signed in, but its Examify profile could not be loaded. Please try again.');
    return { user: credential.user, profile, created };
  } catch (error) {
    try {
      await signOut(auth);
    } catch {
      // Keep the original profile creation error if sign-out also fails.
    }
    throw error;
  }
};

export const updateStudentOnboarding = async ({ uid, previousYearMark }) => {
  if (!isFirebaseConfigured) {
    return { uid, previousYearMark, latestMark: previousYearMark, paymentCompleted: false, subscriptionStatus: 'pending' };
  }

  const payload = {
    previousYearMark: Number(previousYearMark),
    latestMark: Number(previousYearMark),
    updatedAt: serverTimestamp(),
  };

  await updateDoc(doc(db, collections.users, uid), payload);
  return { uid, ...payload };
};

export const signInWithGoogle = async () => {
  if (!auth) throw new Error('Firebase not configured. Please set up environment variables.');
  const credential = await signInWithPopup(auth, provider);
  const profile = await getUserProfile(credential.user.uid);
  if (!profile) {
    await signOut(auth);
    throw new Error('This login has no Examify profile. Contact an administrator to restore the account link.');
  }
  return { user: credential.user, profile };
};

export const completeAccountSetup = async ({ uid, displayName, grade, province, school, whatsappNumber } = {}) => {
  if (!isFirebaseConfigured || !auth?.currentUser || auth.currentUser.uid !== uid) {
    throw new Error('Sign in to the account you are setting up.');
  }
  const profile = await getUserProfile(uid);
  if (!profile || profile.accountSetupStatus !== 'required') throw new Error('This account does not need setup details.');
  const isStudent = profile.role === 'student';
  const isTutor = profile.role === 'tutor' || profile.role === 'teacher' || profile.isTeacher === true || profile.isTeacher === 'true';
  if (!isStudent && !isTutor) throw new Error('This account does not support additional setup details.');

  const cleanName = String(displayName || '').trim();
  if (!cleanName) throw new Error('Enter your full name.');
  const normalizedWhatsAppNumber = normalizeWhatsAppNumber(whatsappNumber);
  const updates = {
    displayName: cleanName,
    accountSetupStatus: 'completed',
    updatedAt: serverTimestamp(),
  };

  if (isStudent) {
    if (!grade || grade === 'Select Grade') throw new Error('Choose your grade.');
    if (!province || province === 'National') throw new Error('Choose your province.');
    const cleanSchool = String(school || '').trim();
    if (!cleanSchool) throw new Error('Enter your school name.');
    if (!functions) throw new Error('Firebase Functions are not configured. Please try again later.');
    await httpsCallable(functions, 'changeStudentGrade')({ studentId: uid, newGrade: grade, restoreSubjectInstanceIds: [] });
    updates.province = province;
    updates.school = cleanSchool;
    updates.whatsappNumber = normalizedWhatsAppNumber;
  } else {
    if (profile.isTeacher === true || profile.isTeacher === 'true' || profile.role === 'teacher') {
      const cleanSchool = String(school || '').trim();
      if (!cleanSchool) throw new Error('Enter the school you teach at.');
      updates.school = cleanSchool;
    }
    if (!functions) throw new Error('Firebase Functions are not configured. Please try again later.');
    await httpsCallable(functions, 'saveTutorWhatsAppNumber')({ whatsappNumber: normalizedWhatsAppNumber });
  }

  await updateProfile(auth.currentUser, { displayName: cleanName });
  await updateDoc(doc(db, collections.users, uid), updates);
  return { uid, ...updates };
};

export const getUserProfile = async (uid) => {
  if (!isFirebaseConfigured) {
    return Object.values(mockUsers).find((user) => user.uid === uid) ?? null;
  }

  const existingRequest = profileRequests.get(uid);
  if (existingRequest) return existingRequest;

  const request = trackFirestoreRead('getUserProfile', () => firebaseGetDoc(doc(db, collections.users, uid)))
    .then((snapshot) => snapshot.exists() ? snapshot.data() : null);
  profileRequests.set(uid, request);
  try {
    return await request;
  } finally {
    if (profileRequests.get(uid) === request) profileRequests.delete(uid);
  }
};

export const logout = async () => {
  if (!isFirebaseConfigured) return true;
  await signOut(auth);
  return true;
};

export const updateUserProfileDetails = async ({ uid, displayName, grade, whatsappNumber, role, newPassword, restoreSubjectInstanceIds = [] }) => {

  const normalizedWhatsAppNumber = whatsappNumber === undefined ? undefined : normalizeWhatsAppNumber(whatsappNumber);
  let gradeChangeResult = null;

  if (isFirebaseConfigured && auth?.currentUser) {
    if (displayName) {
      await updateProfile(auth.currentUser, { displayName });
    }
    if (newPassword) {
      await updatePassword(auth.currentUser, newPassword);
    }
    
    if (grade) {
      if (!functions) throw new Error('Firebase Functions are not configured. Grade changes are temporarily unavailable.');
      const changeGrade = httpsCallable(functions, 'changeStudentGrade');
      gradeChangeResult = (await changeGrade({ studentId: uid, newGrade: grade, restoreSubjectInstanceIds })).data;
    }

    const payload = { updatedAt: serverTimestamp() };
    if (displayName) payload.displayName = displayName;
    if (role === 'tutor' || role === 'teacher') {
      if (normalizedWhatsAppNumber) {
        if (!functions) throw new Error('Firebase Functions are not configured. Tutor WhatsApp setup is temporarily unavailable.');
        await httpsCallable(functions, 'saveTutorWhatsAppNumber')({ whatsappNumber: normalizedWhatsAppNumber });
      }
      await updateDoc(doc(db, collections.users, uid), { ...payload, whatsappNumber: deleteField() });
    } else {
      if (normalizedWhatsAppNumber) payload.whatsappNumber = normalizedWhatsAppNumber;
      await updateDoc(doc(db, collections.users, uid), payload);
    }
    return { uid, ...payload, gradeChangeResult };
  } else {
    // Demo mode bypass
    return { uid, displayName, grade, whatsappNumber: normalizedWhatsAppNumber };
  }
};


export const scheduleCurrentUserAccountDeletion = async () => {
  if (!auth?.currentUser) throw new Error('Sign in before scheduling account deletion.');
  if (!functions) throw new Error('Firebase Functions are not configured. Account deletion is temporarily unavailable.');
  const schedule = httpsCallable(functions, 'scheduleAccountDeletion');
  return (await schedule({})).data;
};

export const cancelCurrentUserAccountDeletion = async () => {
  if (!auth?.currentUser) throw new Error('Sign in before cancelling account deletion.');
  if (!functions) throw new Error('Firebase Functions are not configured. Account deletion is temporarily unavailable.');
  const cancel = httpsCallable(functions, 'cancelAccountDeletion');
  return (await cancel({})).data;
};
