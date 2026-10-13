import { randomUUID } from 'node:crypto';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { admin, getDb, storage } from './admin.js';
import { formatDeletionDate, getScheduledAccountDeletionDate, removeUserFromStaffEpisode, scrubUserReferences } from './accountDeletionCore.js';
import { queueBrandedEmail } from './resendEmail.js';
import { resolveEmailAppUrl } from './emailPortalUrls.js';

const USER_COLLECTION = 'users';
const DELETION_STATUS_FIELD = 'accountDeletionStatus';
const DELETION_DATE_FIELD = 'accountDeletionScheduledFor';
const PAGE_SIZE = 100;
const WRITE_BATCH_SIZE = 400;
const PROCESSING_STATUSES = new Set(['scheduled', 'deleting']);
const SERVER_TIMESTAMP = () => admin.firestore.FieldValue.serverTimestamp();
const DELETE_FIELD = () => admin.firestore.FieldValue.delete();
const requireUid = (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to manage account deletion.');
  return uid;
};
const asDate = (value) => value?.toDate?.() ?? (value instanceof Date ? value : null);
const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
const fieldQuery = (db, collectionName, field, operator, value) => db.collectionGroup(collectionName).where(field, operator, value).get();

const portalSettingsPath = (profile = {}) => {
  const portal = profile.role === 'teacher' || profile.isTeacher === true || profile.isTeacher === 'true'
    ? 'teacher'
    : ['student', 'tutor', 'teacher', 'parent', 'admin'].includes(profile.role) ? profile.role : 'student';
  return `/${portal}/profile/settings`;
};

const notifyAccountDeletion = async ({ uid, profile, scheduledFor, cancelled = false }) => {
  const email = normalizeEmail(profile.emailLowercase || profile.email);
  if (!email) return;
  const dateText = formatDeletionDate(scheduledFor);
  await queueBrandedEmail({
    type: cancelled ? 'account.deletion.cancelled' : 'account.deletion.scheduled',
    eventId: `${uid}-${cancelled ? Date.now() : scheduledFor.getTime()}`,
    to: email,
    profile,
    name: profile.displayName || profile.name || '',
    subject: cancelled ? 'Your account deletion request was cancelled' : 'Your account deletion is scheduled',
    heading: cancelled ? 'Your account will remain active' : 'Your account deletion is scheduled',
    paragraphs: cancelled
      ? ['Your request to delete your Examifying account has been cancelled. Your account and learning records will remain available.']
      : [`Your Examifying account is scheduled for permanent deletion on ${dateText}. You can cancel the request from your account settings before that date.`,
        'Until then, you can sign in and cancel the request if you change your mind.'],
    actionLabel: cancelled ? 'Open Examifying' : 'Review deletion request',
    actionUrl: resolveEmailAppUrl(portalSettingsPath(profile), profile),
  });
};

export const scheduleAccountDeletion = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = requireUid(request);
  const db = getDb();
  const userRef = db.collection(USER_COLLECTION).doc(uid);
  const result = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);
    if (!snapshot.exists) throw new HttpsError('not-found', 'The Examifying account profile could not be found.');
    const profile = snapshot.data();
    if (profile[DELETION_STATUS_FIELD] === 'deleting') {
      throw new HttpsError('failed-precondition', 'Account deletion is already being processed and can no longer be cancelled.');
    }
    const existingDate = asDate(profile[DELETION_DATE_FIELD]);
    if (profile[DELETION_STATUS_FIELD] === 'scheduled' && existingDate) {
      return { scheduledFor: existingDate, profile, alreadyScheduled: true };
    }

    const scheduledFor = getScheduledAccountDeletionDate();
    transaction.update(userRef, {
      [DELETION_STATUS_FIELD]: 'scheduled',
      accountDeletionRequestedAt: SERVER_TIMESTAMP(),
      [DELETION_DATE_FIELD]: admin.firestore.Timestamp.fromDate(scheduledFor),
      accountDeletionProcessingAt: DELETE_FIELD(),
      accountDeletionCancelledAt: DELETE_FIELD(),
      updatedAt: SERVER_TIMESTAMP(),
    });
    return { scheduledFor, profile, alreadyScheduled: false };
  });

  if (!result.alreadyScheduled) {
    try {
      await notifyAccountDeletion({ uid, profile: result.profile, scheduledFor: result.scheduledFor });
    } catch (error) {
      logger.error('Could not queue account deletion confirmation email', { error: error?.message ?? String(error) });
    }
  }
  return { scheduled: true, scheduledFor: result.scheduledFor.toISOString(), alreadyScheduled: result.alreadyScheduled };
});

export const cancelAccountDeletion = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = requireUid(request);
  const db = getDb();
  const userRef = db.collection(USER_COLLECTION).doc(uid);
  const result = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);
    if (!snapshot.exists) throw new HttpsError('not-found', 'The Examifying account profile could not be found.');
    const profile = snapshot.data();
    const status = profile[DELETION_STATUS_FIELD];
    if (status === 'deleting') throw new HttpsError('failed-precondition', 'Account deletion has started and can no longer be cancelled.');
    if (status !== 'scheduled') return { cancelled: true, alreadyCancelled: true, profile };
    const scheduledFor = asDate(profile[DELETION_DATE_FIELD]);
    if (!scheduledFor || scheduledFor.getTime() <= Date.now()) {
      throw new HttpsError('failed-precondition', 'The deletion date has passed and account deletion is being processed.');
    }
    transaction.update(userRef, {
      [DELETION_STATUS_FIELD]: 'cancelled',
      [DELETION_DATE_FIELD]: DELETE_FIELD(),
      accountDeletionRequestedAt: DELETE_FIELD(),
      accountDeletionProcessingAt: DELETE_FIELD(),
      accountDeletionCancelledAt: SERVER_TIMESTAMP(),
      updatedAt: SERVER_TIMESTAMP(),
    });
    return { cancelled: true, alreadyCancelled: false, profile };
  });

  if (!result.alreadyCancelled) {
    try {
      await notifyAccountDeletion({ uid, profile: result.profile, scheduledFor: new Date(), cancelled: true });
    } catch (error) {
      logger.error('Could not queue account deletion cancellation email', { error: error?.message ?? String(error) });
    }
  }
  return { cancelled: true, alreadyCancelled: result.alreadyCancelled };
});

const collectQueryDocuments = async (db, uid) => {
  const searches = [
    ['subjects', 'primaryTutorId', '=='], ['subjects', 'activeStaffIds', 'array-contains'],
    ['subjects', 'historicalStaffIds', 'array-contains'],
    ['peerMarkingAssignments', 'reviewerId', '=='], ['peerMarkingAssignments', 'revieweeId', '=='],
    ['peerReviews', 'reviewerId', '=='], ['peerReviews', 'revieweeId', '=='], ['peerReviews', 'submittedBy', '=='],
    ['lessons', 'tutorId', '=='], ['lessons', 'createdBy', '=='], ['lessons', 'updatedBy', '=='], ['lessons', 'studentId', '=='],
    ['reports', 'tutorId', '=='], ['reports', 'createdBy', '=='], ['reports', 'authorId', '=='], ['reports', 'userId', '=='],
    ['topics', 'tutorId', '=='], ['topics', 'updatedBy', '=='],
    ['understandingScores', 'tutorId', '=='], ['understandingScores', 'createdBy', '=='],
    ['exercises', 'tutorId', '=='], ['exercises', 'studentId', '=='],
    ['exercises', 'peerReviewerId', '=='], ['exercises', 'peerReviewSubmittedBy', '=='],
    ['exercises', 'submittedBy', '=='], ['exercises', 'markedBy', '=='], ['exercises', 'updatedBy', '=='],
    ['submissions', 'studentId', '=='], ['submissions', 'uploadedBy', '=='], ['submissions', 'submittedBy', '=='],
    ['payments', 'payerId', '=='], ['payments', 'parentId', '=='], ['payments', 'studentId', '=='],
    ['subscriptions', 'payerId', '=='], ['subscriptions', 'studentId', '=='], ['subscriptions', 'renewalAttempt.payerId', '=='],
    ['subscriptionAuthorizations', 'payerId', '=='], ['subscriptionAuthorizations', 'studentId', '=='],
    ['notifications', 'actorId', '=='], ['notifications', 'actorUserId', '=='], ['notifications', 'userId', '=='],
    ['notifications', 'data.userId', '=='], ['notifications', 'data.studentId', '=='], ['notifications', 'data.actorId', '=='],
    ['notificationLogs', 'userId', '=='], ['notificationLogs', 'actorId', '=='],
    ['guideQuizResults', 'userId', '=='], ['tutorMarksDocuments', 'tutorId', '=='],
    ['redemptions', 'studentId', '=='], ['redemptions', 'payerId', '=='], ['redemptions', 'parentId', '=='], ['redemptions', 'userId', '=='], ['redemptions', 'redeemedBy', '=='],
    ['paystackWebhookEvents', 'studentId', '=='], ['paystackWebhookEvents', 'payerId', '=='], ['paystackWebhookEvents', 'parentId', '=='], ['paystackWebhookEvents', 'userId', '=='],
    ['analysisRuns', 'createdBy', '=='], ['analysisRuns', 'requestedBy', '=='], ['analysisRuns', 'updatedBy', '=='],
    ['discountCodes', 'createdBy', '=='], ['discountCodes', 'updatedBy', '=='],
    ['topicResolverMappings', 'createdBy', '=='], ['topicResolverMappings', 'updatedBy', '=='],
    ['settings', 'createdBy', '=='], ['settings', 'updatedBy', '=='],
  ];
  const [results, allSubjectDocuments] = await Promise.all([
    Promise.all(searches.map(([collectionName, field, operator]) => fieldQuery(db, collectionName, field, operator, uid))),
    db.collectionGroup('subjects').get(),
  ]);
  const documents = new Map();
  for (const snapshot of results) {
    for (const document of snapshot.docs) documents.set(document.ref.path, document);
  }
  for (const document of allSubjectDocuments.docs) {
    if (scrubUserReferences(document.data(), uid).changed) documents.set(document.ref.path, document);
  }
  return [...documents.values()];
};

const scrubAccountFields = (data, uid, collectionName) => {
  const { value: cleaned, changed } = scrubUserReferences(data, uid);
  if (!changed || !cleaned) return null;
  const next = { ...cleaned };
  if (collectionName === 'payments' && (data.payerId === uid || data.parentId === uid)) {
    for (const key of ['payerName', 'payerEmail', 'payerPhone', 'parentName', 'parentEmail', 'parentPhone', 'customerName', 'customerEmail', 'customerPhone', 'email', 'phone', 'cellNumber']) delete next[key];
  }
  if (collectionName === 'paystackWebhookEvents'
    && [data.studentId, data.payerId, data.parentId].includes(uid)) {
    for (const key of ['email', 'payerName', 'payerEmail', 'payerPhone', 'customerName', 'customerEmail', 'customerPhone']) delete next[key];
  }
  if (['lessons', 'reports', 'understandingScores', 'exercises'].includes(collectionName)
    && [data.tutorId, data.createdBy, data.authorId].includes(uid)) {
    for (const key of ['tutorName', 'tutorEmail', 'authorName', 'authorEmail', 'createdByName', 'createdByEmail']) delete next[key];
  }
  if (data.createdBy === uid || data.uploaderId === uid || data.updatedBy === uid) {
    for (const key of ['createdByName', 'createdByEmail', 'uploaderName', 'uploaderEmail', 'updatedByName', 'updatedByEmail']) delete next[key];
  }
  if (collectionName === 'subscriptions' && (data.payerId === uid || data.renewalAttempt?.payerId === uid)) {
    next.autoRenew = false;
    if (data.status === 'active') next.cancelAtPeriodEnd = true;
    if (next.cancellation && typeof next.cancellation === 'object') {
      next.cancellation = scrubUserReferences(next.cancellation, uid).value;
      if (next.cancellation.requestedBy === undefined) delete next.cancellation.requestedBy;
    }
  }
  return next;
};

const commitWrites = async (db, operations) => {
  for (let offset = 0; offset < operations.length; offset += WRITE_BATCH_SIZE) {
    const batch = db.batch();
    operations.slice(offset, offset + WRITE_BATCH_SIZE).forEach((operation) => operation(batch));
    await batch.commit();
  }
};

const parseStorageUrl = (value) => {
  if (typeof value !== 'string') return null;
  if (value.startsWith('gs://')) {
    const [, bucketName, ...path] = value.slice(5).split('/');
    return bucketName && path.length ? { bucketName, path: path.join('/') } : null;
  }
  try {
    const url = new URL(value);
    const marker = '/o/';
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex >= 0) return { bucketName: url.pathname.slice(0, markerIndex).split('/').at(-1), path: decodeURIComponent(url.pathname.slice(markerIndex + marker.length)) };
    if (url.hostname === 'storage.googleapis.com') {
      const [, bucketName, ...path] = url.pathname.split('/');
      return bucketName && path.length ? { bucketName, path: path.join('/') } : null;
    }
  } catch {
    return null;
  }
  return null;
};

const storageUrl = (bucketName, path, token) => `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;

const copySharedPaperFile = async ({ bucket, value, uid, paperId, kind }) => {
  const parsed = parseStorageUrl(value);
  if (!parsed || parsed.bucketName !== bucket.name || !parsed.path.startsWith(`questionPapers/${uid}/`)) return value;
  const oldFile = bucket.file(parsed.path);
  const basename = parsed.path.split('/').at(-1).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || `${kind}.pdf`;
  const newPath = `questionPapers/shared/${paperId}/${kind}-${basename}`;
  const newFile = bucket.file(newPath);
  await newFile.delete({ ignoreNotFound: true });
  await oldFile.copy(newFile);
  const [metadata] = await newFile.getMetadata();
  let token = metadata.metadata?.firebaseStorageDownloadTokens?.split(',')[0];
  if (!token) {
    token = randomUUID();
    await newFile.setMetadata({ metadata: { ...(metadata.metadata ?? {}), firebaseStorageDownloadTokens: token } });
  }
  return storageUrl(bucket.name, newPath, token);
};

const migratePaperUploadsAndRemoveCreator = async (db, bucket, uid) => {
  const [snapshots, allPapers] = await Promise.all([Promise.all([
    db.collection('questionPapers').where('createdBy', '==', uid).get(),
    db.collection('questionPapers').where('uploaderId', '==', uid).get(),
  ]), db.collection('questionPapers').get()]);
  const papers = new Map();
  snapshots.forEach((snapshot) => snapshot.docs.forEach((document) => papers.set(document.id, document)));
  allPapers.docs.forEach((document) => {
    const data = document.data();
    const ownsStoredFile = ['paperUrl', 'memoUrl'].some((field) =>
      parseStorageUrl(data[field])?.path.startsWith(`questionPapers/${uid}/`));
    if (ownsStoredFile) papers.set(document.id, document);
  });
  const movedFileReferences = [];
  for (const document of papers.values()) {
    const { value: cleaned } = scrubUserReferences(document.data(), uid);
    const paper = cleaned ?? {};
    for (const key of ['createdByName', 'createdByEmail', 'uploaderName', 'uploaderEmail', 'updatedByName', 'updatedByEmail']) delete paper[key];
    const [paperUrl, memoUrl] = await Promise.all([
      copySharedPaperFile({ bucket, value: paper.paperUrl, uid, paperId: document.id, kind: 'paper' }),
      copySharedPaperFile({ bucket, value: paper.memoUrl, uid, paperId: document.id, kind: 'memo' }),
    ]);
    if (paper.paperUrl && paperUrl !== paper.paperUrl) movedFileReferences.push({ oldUrl: paper.paperUrl, newUrl: paperUrl, paperField: 'paperUrl', runField: 'sourcePaperUrl' });
    if (paper.memoUrl && memoUrl !== paper.memoUrl) movedFileReferences.push({ oldUrl: paper.memoUrl, newUrl: memoUrl, paperField: 'memoUrl', runField: 'sourceMemoUrl' });
    await document.ref.set({ ...paper, paperUrl, memoUrl, updatedAt: SERVER_TIMESTAMP() }, { merge: false });
  }

  for (const moved of movedFileReferences) {
    const [paperReferences, analysisReferences] = await Promise.all([
      db.collection('questionPapers').where(moved.paperField, '==', moved.oldUrl).get(),
      db.collectionGroup('analysisRuns').where(moved.runField, '==', moved.oldUrl).get(),
    ]);
    const operations = [];
    paperReferences.docs.forEach((document) => operations.push((batch) => batch.set(document.ref, {
      [moved.paperField]: moved.newUrl, updatedAt: SERVER_TIMESTAMP(),
    }, { merge: true })));
    analysisReferences.docs.forEach((document) => operations.push((batch) => batch.set(document.ref, {
      [moved.runField]: moved.newUrl, updatedAt: SERVER_TIMESTAMP(),
    }, { merge: true })));
    await commitWrites(db, operations);
  }
};

const deleteObjectFromUrl = async (bucket, value) => {
  const parsed = parseStorageUrl(value);
  if (!parsed || parsed.bucketName !== bucket.name || !parsed.path.startsWith('users/')) return;
  await bucket.file(parsed.path).delete({ ignoreNotFound: true });
};

const removePeerReviewerRecords = async (db, bucket, uid, documents) => {
  const matching = documents.filter((document) => document.ref.parent.id === 'peerReviews'
    && (document.data().reviewerId === uid || document.data().revieweeId === uid));
  if (!matching.length) return;
  const operations = [];
  for (const review of matching) {
    const data = review.data();
    const urls = [];
    const visit = (value) => {
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) urls.push(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(data);
    await Promise.all(urls.map((url) => deleteObjectFromUrl(bucket, url)));
    operations.push((batch) => batch.delete(review.ref));
    const exerciseRef = review.ref.parent.parent;
    if (exerciseRef && data.reviewerId === uid) operations.push((batch) => batch.set(exerciseRef, {
      peerReviewed: 'No', peerReviewStatus: 'pending', peerReviewDate: null,
      peerMarkedImages: DELETE_FIELD(), peerReviewerId: DELETE_FIELD(), peerReviewSubmittedBy: DELETE_FIELD(),
      updatedAt: SERVER_TIMESTAMP(),
    }, { merge: true }));
  }
  await commitWrites(db, operations);
};

const stopRenewalsPaidByDeletingUser = async (db, uid) => {
  const [subscriptions, authorizations] = await Promise.all([
    fieldQuery(db, 'subscriptions', 'payerId', '==', uid),
    fieldQuery(db, 'subscriptionAuthorizations', 'payerId', '==', uid),
  ]);
  const studentIds = new Set();
  subscriptions.docs.forEach((document) => {
    const studentId = document.ref.parent.parent?.id;
    if (studentId && studentId !== uid) studentIds.add(studentId);
  });
  authorizations.docs.forEach((document) => {
    const studentId = document.ref.parent.parent?.id;
    if (studentId && studentId !== uid) studentIds.add(studentId);
  });

  const writes = [];
  for (const studentId of studentIds) {
    const subscriptionRef = db.collection(USER_COLLECTION).doc(studentId).collection('subscriptions').doc('current');
    const subscription = await subscriptionRef.get();
    if (subscription.exists) {
      const data = subscription.data();
      writes.push((batch) => batch.set(subscriptionRef, {
        autoRenew: false,
        ...(data.status === 'active' ? { cancelAtPeriodEnd: true } : {}),
        cancellation: {
          requestedAt: admin.firestore.Timestamp.now(),
          effectiveAt: data.renewalDate ?? admin.firestore.Timestamp.now(),
          reason: 'payer_account_deleted',
        },
        pendingPlan: DELETE_FIELD(), pendingPlanReference: DELETE_FIELD(), pendingPlanSetAt: DELETE_FIELD(),
        nextRenewalAttemptAt: DELETE_FIELD(), renewalVerificationHoldUntil: DELETE_FIELD(),
        renewalAttempt: DELETE_FIELD(), renewalChargeLock: DELETE_FIELD(),
        updatedAt: SERVER_TIMESTAMP(),
      }, { merge: true }));
    }
    const authorizationRef = db.collection(USER_COLLECTION).doc(studentId).collection('subscriptionAuthorizations').doc('current');
    const authorization = await authorizationRef.get();
    if (authorization.exists && authorization.data().payerId === uid) {
      await db.recursiveDelete(authorizationRef);
    }
  }
  await commitWrites(db, writes);
};

const scrubLinkedRecords = async (db, bucket, uid, userEmail) => {
  await migratePaperUploadsAndRemoveCreator(db, bucket, uid);
  await stopRenewalsPaidByDeletingUser(db, uid);

  const [userProfiles, linkedDocuments] = await Promise.all([
    db.collection(USER_COLLECTION).get(),
    collectQueryDocuments(db, uid),
  ]);
  await removePeerReviewerRecords(db, bucket, uid, linkedDocuments);

  const operations = [];
  for (const profile of userProfiles.docs) {
    if (profile.id === uid) continue;
    const { value, changed } = scrubUserReferences(profile.data(), uid);
    if (changed && value) operations.push((batch) => batch.set(profile.ref, { ...value, updatedAt: SERVER_TIMESTAMP() }, { merge: false }));
  }

  for (const document of linkedDocuments) {
    if (document.ref.path.startsWith(`${USER_COLLECTION}/${uid}/`)) continue;
    const collectionName = document.ref.parent.id;
    const data = document.data();
    if (collectionName === 'peerReviews' && (data.reviewerId === uid || data.revieweeId === uid)) continue;
    if (collectionName === 'peerMarkingAssignments' && (data.reviewerId === uid || data.revieweeId === uid)) {
      operations.push((batch) => batch.delete(document.ref));
      continue;
    }
    if (collectionName === 'subscriptionAuthorizations' && data.payerId === uid) {
      operations.push((batch) => batch.delete(document.ref));
      continue;
    }
    if (collectionName === 'redemptions'
      && [data.studentId, data.payerId, data.parentId, data.userId, data.redeemedBy].includes(uid)) {
      operations.push((batch) => batch.delete(document.ref));
      continue;
    }
    if (collectionName === 'paystackWebhookEvents'
      && [data.studentId, data.payerId, data.parentId, data.userId].includes(uid)) {
      operations.push((batch) => batch.delete(document.ref));
      continue;
    }
    if (collectionName === 'notifications'
      && [data.userId, data.actorId, data.actorUserId, data.data?.userId, data.data?.studentId, data.data?.actorId].includes(uid)) {
      operations.push((batch) => batch.delete(document.ref));
      continue;
    }
    if (collectionName === 'subjects') {
      const cleaned = removeUserFromStaffEpisode(data, uid);
      operations.push((batch) => batch.set(document.ref, { ...cleaned, updatedAt: SERVER_TIMESTAMP() }, { merge: false }));
      continue;
    }
    const cleaned = scrubAccountFields(data, uid, collectionName);
    if (cleaned) operations.push((batch) => batch.set(document.ref, { ...cleaned, updatedAt: SERVER_TIMESTAMP() }, { merge: false }));
  }

  if (userEmail) {
    const emailJobs = await db.collection('emailNotificationOutbox').where('to', '==', userEmail).get();
    emailJobs.docs.forEach((document) => operations.push((batch) => batch.delete(document.ref)));
  }
  await commitWrites(db, operations);
};

const deleteAccountData = async (db, uid, profile) => {
  const bucket = storage.bucket();
  const userRef = db.collection(USER_COLLECTION).doc(uid);
  await scrubLinkedRecords(db, bucket, uid, normalizeEmail(profile.emailLowercase || profile.email));
  await bucket.deleteFiles({ prefix: `users/${uid}/`, force: true });
  await bucket.deleteFiles({ prefix: `questionPapers/${uid}/`, force: true });

  try {
    await admin.auth().deleteUser(uid);
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') throw error;
  }
  await db.recursiveDelete(userRef);
};

const processOneScheduledDeletion = async (db, userSnapshot) => {
  const uid = userSnapshot.id;
  const userRef = userSnapshot.ref;
  const claim = await db.runTransaction(async (transaction) => {
    const current = await transaction.get(userRef);
    if (!current.exists) return null;
    const profile = current.data();
    const dueDate = asDate(profile[DELETION_DATE_FIELD]);
    if (!PROCESSING_STATUSES.has(profile[DELETION_STATUS_FIELD]) || !dueDate || dueDate > new Date()) return null;
    if (profile[DELETION_STATUS_FIELD] === 'scheduled') {
      transaction.update(userRef, { [DELETION_STATUS_FIELD]: 'deleting', accountDeletionProcessingAt: SERVER_TIMESTAMP(), updatedAt: SERVER_TIMESTAMP() });
    }
    return profile;
  });
  if (!claim) return false;

  await deleteAccountData(db, uid, claim);
  logger.info('Scheduled account deletion completed', { uid, role: claim.role || '', scheduledFor: asDate(claim[DELETION_DATE_FIELD])?.toISOString() || '' });
  return true;
};

export const processScheduledAccountDeletions = onSchedule({
  schedule: '0 0 * * *',
  timeZone: 'Africa/Johannesburg',
  timeoutSeconds: 540,
  memory: '1GiB',
  cpu: 1,
  maxInstances: 1,
}, async () => {
  const db = getDb();
  let cursor = null;
  let completed = 0;
  let failures = 0;
  while (true) {
    let query = db.collection(USER_COLLECTION)
      .where(DELETION_DATE_FIELD, '<=', admin.firestore.Timestamp.now())
      .orderBy(DELETION_DATE_FIELD, 'asc')
      .limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    cursor = page.docs.at(-1);
    for (const document of page.docs) {
      try {
        if (await processOneScheduledDeletion(db, document)) completed += 1;
      } catch (error) {
        failures += 1;
        logger.error('Scheduled account deletion failed; it will be retried by the next daily run', {
          role: document.data().role || '', error: error?.message ?? String(error),
        });
      }
    }
    if (page.size < PAGE_SIZE) break;
  }
  logger.info('Scheduled account deletion run completed', { completed, failures });
});
