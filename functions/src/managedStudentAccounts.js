import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { admin, getDb } from './admin.js';
import { isManagedStudentInviteProfileEligible } from './managedStudentAccountsCore.js';

const inviteCollection = (db, studentId) => db.collection('users').doc(studentId)
  .collection('private').doc('managedStudentInvites').collection('tokens');
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const createManagedStudentInvite = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const parentId = request.auth?.uid;
  const studentId = String(request.data?.studentId ?? '').trim();
  if (!parentId) throw new HttpsError('unauthenticated', 'Sign in as the parent to create an account link.');
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(studentId)) throw new HttpsError('invalid-argument', 'A valid student profile is required.');
  const db = getDb();
  const [parentSnapshot, studentSnapshot] = await Promise.all([
    db.collection('users').doc(parentId).get(),
    db.collection('users').doc(studentId).get(),
  ]);
  const student = studentSnapshot.data();
  if (!parentSnapshot.exists || parentSnapshot.data()?.role !== 'parent'
    || !studentSnapshot.exists || student?.role !== 'student' || student?.parentId !== parentId) {
    throw new HttpsError('permission-denied', 'This student is not linked to your parent account.');
  }
  if (student.authUserExists === true) throw new HttpsError('failed-precondition', 'This student already has a sign-in account.');
  try {
    await admin.auth().getUser(studentId);
    throw new HttpsError('failed-precondition', 'This student already has a sign-in account.');
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    if (error?.code !== 'auth/user-not-found') throw error;
  }

  const token = `${studentId}.${randomBytes(32).toString('base64url')}`;
  const tokenHash = hashToken(token);
  const existingInvites = await inviteCollection(db, studentId).where('status', '==', 'active').get();
  if (!existingInvites.empty) {
    const batch = db.batch();
    existingInvites.docs.forEach((invite) => batch.set(invite.ref, { status: 'revoked', revokedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }));
    await batch.commit();
  }
  await inviteCollection(db, studentId).doc(tokenHash).set({
    studentId,
    parentId,
    tokenHash,
    status: 'active',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
  });
  return { token, studentId, expiresInDays: 7 };
});

export const redeemManagedStudentInvite = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const token = String(request.data?.token ?? '').trim();
  const [studentId, secret, ...extra] = token.split('.');
  const email = String(request.data?.email ?? '').trim().toLowerCase();
  const password = String(request.data?.password ?? '');
  const displayName = String(request.data?.displayName ?? '').trim().replace(/\s+/g, ' ');
  if (extra.length || !studentId || !secret || !/^[A-Za-z0-9_-]{10,80}$/.test(studentId) || secret.length < 40) {
    throw new HttpsError('invalid-argument', 'This student account link is invalid or expired.');
  }
  if (!emailPattern.test(email)) throw new HttpsError('invalid-argument', 'Enter a valid email address.');
  if (password.length < 8) throw new HttpsError('invalid-argument', 'Choose a password with at least 8 characters.');
  if (!displayName) throw new HttpsError('invalid-argument', 'Enter the student’s full name.');
  if (request.data?.termsAccepted !== true || request.data?.privacyNoticeAcknowledged !== true) {
    throw new HttpsError('failed-precondition', 'Accept the Terms of Use and acknowledge the Privacy Policy to create the student account.');
  }

  const db = getDb();
  const tokenHash = hashToken(token);
  const tokenRef = inviteCollection(db, studentId).doc(tokenHash);
  const studentRef = db.collection('users').doc(studentId);
  const now = admin.firestore.Timestamp.now();
  const claimId = randomUUID();
  await db.runTransaction(async (transaction) => {
    const [tokenSnapshot, studentSnapshot] = await Promise.all([transaction.get(tokenRef), transaction.get(studentRef)]);
    if (!tokenSnapshot.exists || !studentSnapshot.exists) throw new HttpsError('permission-denied', 'This student account link is invalid or expired.');
    const invite = tokenSnapshot.data();
    const student = studentSnapshot.data();
    const claimAge = now.toMillis() - (invite.claimedAt?.toMillis?.() ?? 0);
    const claimIsStale = invite.status === 'redeeming' && claimAge >= 10 * 60 * 1000;
    if (invite.tokenHash !== tokenHash || invite.studentId !== studentId
      || (invite.status !== 'active' && !claimIsStale)
      || invite.expiresAt?.toDate?.() <= new Date()) {
      throw new HttpsError('permission-denied', 'This student account link is invalid or expired.');
    }
    if (!isManagedStudentInviteProfileEligible(student, invite.parentId)) {
      throw new HttpsError('failed-precondition', 'This student profile can no longer be connected with this link.');
    }
    transaction.set(tokenRef, { status: 'redeeming', claimId, claimedAt: now }, { merge: true });
  });

  let stage = 'checking_email';
  try {
    const sameEmailProfiles = await db.collection('users').where('emailLowercase', '==', email).limit(2).get();
    if (sameEmailProfiles.docs.some((snapshot) => snapshot.id !== studentId)) {
      throw new HttpsError('already-exists', 'That email is already used by another Examifying profile. Use a different email.');
    }
    stage = 'resolving_auth_account';
    let authUser = null;
    try {
      authUser = await admin.auth().getUser(studentId);
      if (authUser.email?.toLowerCase() !== email) {
        throw new HttpsError('failed-precondition', 'The student profile already has a different sign-in account. Contact the parent who created the profile.');
      }
      authUser = await admin.auth().updateUser(studentId, { email, password, displayName, emailVerified: false, disabled: false });
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      if (error?.code !== 'auth/user-not-found') throw error;
      try {
        const existingEmailUser = await admin.auth().getUserByEmail(email);
        if (existingEmailUser.uid !== studentId) throw new HttpsError('already-exists', 'That email is already connected to another Examifying account. Use a different email.');
        authUser = await admin.auth().updateUser(studentId, { password, displayName, emailVerified: false, disabled: false });
      } catch (emailError) {
        if (emailError instanceof HttpsError) throw emailError;
        if (emailError?.code !== 'auth/user-not-found') throw emailError;
        authUser = await admin.auth().createUser({ uid: studentId, email, password, displayName, emailVerified: false, disabled: false });
      }
    }

    stage = 'saving_student_profile';
    const legalVersion = String(request.data?.legalVersion ?? '2026-10-14').slice(0, 40);
    await studentRef.set({
      uid: studentId,
      role: 'student',
      email: authUser.email || email,
      emailLowercase: (authUser.email || email).toLowerCase(),
      displayName,
      authUserExists: true,
      accountSetupStatus: 'completed',
      termsAccepted: true,
      termsAcceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      termsVersion: legalVersion,
      privacyNoticeAcknowledged: true,
      privacyNoticeAcknowledgedAt: admin.firestore.FieldValue.serverTimestamp(),
      privacyNoticeVersion: legalVersion,
      marketingEmailOptIn: request.data?.marketingEmailOptIn === true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    stage = 'consuming_invite';
    await tokenRef.set({ status: 'consumed', consumedAt: admin.firestore.FieldValue.serverTimestamp(), claimId: admin.firestore.FieldValue.delete() }, { merge: true });
    return { studentId, email: authUser.email || email };
  } catch (error) {
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(tokenRef);
      if (snapshot.exists && snapshot.data()?.status === 'redeeming' && snapshot.data()?.claimId === claimId) {
        transaction.set(tokenRef, {
          status: 'active',
          claimId: admin.firestore.FieldValue.delete(),
          claimedAt: admin.firestore.FieldValue.delete(),
        }, { merge: true });
      }
    }).catch(() => {});
    console.error('Managed student invite redemption failed.', {
      stage,
      errorCode: error?.code || 'unknown',
      errorName: error?.name || 'Error',
    });
    if (error instanceof HttpsError) throw error;
    if (error?.code === 'auth/email-already-exists') throw new HttpsError('already-exists', 'That email is already connected to another Examifying account. Use a different email.');
    throw new HttpsError('internal', 'Could not finish setting up this student account. The student profile was preserved; try again or contact support.');
  }
});
