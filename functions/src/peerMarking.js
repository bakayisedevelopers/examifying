import { randomUUID } from 'node:crypto';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { admin, getDb } from './admin.js';
import { buildAssignments, getExerciseQuestionLinks, getExerciseTopicKeys, getExerciseTopicNames, normalizeExerciseTopicKey } from './peerMarkingAllocation.js';
import { claimPeerMarkingAssignmentSlot } from './peerMarkingAssignmentStore.js';
import {
  canRegenerateSystemPeerWork,
  peerMarkingAllocationLockId,
  peerMarkingLockMatchesAssignment,
} from './peerMarkingFallbackCore.js';
import { questionIdentity } from './aiMarkingCore.js';
import { assignFallbackPeerWork } from './systemPeerWork.js';
import { sendNotificationToUsers } from './notifications.js';

const hasSubmission = (exercise = {}) => exercise.submissionStatus === 'submitted'
  || exercise.submitted === 'Yes' || Boolean(exercise.submittedImageUrl);
const cohortFor = (exercise = {}) => ({
  assignmentDate: exercise.assignmentDate ?? '', subject: exercise.subject ?? '', grade: exercise.grade ?? '',
});
const sameCohort = (left, right) => left.assignmentDate === right.assignmentDate
  && left.subject === right.subject && String(left.grade) === String(right.grade);
const parseExercisePath = (document) => {
  const parts = document.ref.path.split('/');
  return { studentId: parts[1], subjectInstanceId: parts[3], exerciseId: document.id };
};
const getExerciseQuestionIdentities = (exercise = {}) => {
  const identities = new Set();
  const paperIds = Array.isArray(exercise.paperIds) ? exercise.paperIds : [];
  const questionReferences = Array.isArray(exercise.questionReferences) ? exercise.questionReferences : [];
  const rows = [
    ...(Array.isArray(exercise.questionLinks) ? exercise.questionLinks : []),
    ...(Array.isArray(exercise.questions) ? exercise.questions : []),
  ];
  rows.forEach((question, index) => {
    const paperId = String(question?.paperId ?? paperIds[index] ?? paperIds[0] ?? '').trim();
    const reference = String(question?.questionReference ?? question?.questionNumber ?? question?.number
      ?? questionReferences[index] ?? '').trim();
    if (paperId && reference) identities.add(questionIdentity(paperId, reference));
  });
  questionReferences.forEach((reference, index) => {
    const paperId = String(paperIds[index] ?? paperIds[0] ?? '').trim();
    if (paperId && reference) identities.add(questionIdentity(paperId, reference));
  });
  return identities;
};

export const assignPeerMarkingOnSubmission = onDocumentWritten(
  { document: 'users/{studentId}/subjects/{subjectInstanceId}/exercises/{exerciseId}', timeoutSeconds: 180, memory: '1GiB' },
  async (event) => {
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after || !hasSubmission(after)) return;
    const cohort = cohortFor(after);
    if (!cohort.assignmentDate || !cohort.subject || !cohort.grade) return;
    const db = getDb();
    const exerciseSnapshot = await db.collectionGroup('exercises')
      .where('assignmentDate', '==', cohort.assignmentDate)
      .where('subject', '==', cohort.subject)
      .where('grade', '==', cohort.grade).get();
    const submitted = exerciseSnapshot.docs
      .filter((document) => hasSubmission(document.data()))
      .map((document) => ({ id: document.id, ...document.data(), ...parseExercisePath(document), ref: document.ref }));
    const assignmentSnapshot = await db.collectionGroup('peerMarkingAssignments')
      .where('assignmentDate', '==', cohort.assignmentDate)
      .where('subject', '==', cohort.subject)
      .where('grade', '==', cohort.grade).get();
    const assignedReviewerIds = new Set(assignmentSnapshot.docs.map((document) => document.data().reviewerId));
    const reviewerIds = [...new Set(submitted.map((item) => item.studentId))];
    const lockRefs = reviewerIds.map((reviewerId) => db.collection('peerMarkingAssignmentLocks')
      .doc(peerMarkingAllocationLockId({ ...cohort, reviewerId })));
    const lockSnapshots = await Promise.all(lockRefs.map((lockRef) => lockRef.get()));
    const lockChecks = await Promise.all(lockSnapshots.map(async (snapshot, index) => {
      const expectedReviewerId = reviewerIds[index];
      if (!snapshot.exists) return '';
      const lockRef = lockRefs[index];
      const lock = snapshot.data();
      const assignmentPath = String(lock.assignmentPath ?? '');
      const validPath = /^users\/[^/]+\/subjects\/[^/]+\/exercises\/[^/]+\/peerMarkingAssignments\/[^/]+$/.test(assignmentPath)
        && assignmentPath.endsWith(`/peerMarkingAssignments/${expectedReviewerId}`);
      const assignmentRef = validPath ? db.doc(assignmentPath) : null;
      const assignmentSnapshot = assignmentRef ? await assignmentRef.get() : null;
      const assignment = assignmentSnapshot?.exists ? assignmentSnapshot.data() : null;
      if (peerMarkingLockMatchesAssignment({
        lock,
        assignment,
        assignmentPath,
        reviewerId: expectedReviewerId,
        cohort,
      })) return expectedReviewerId;

      // Assignment and lock are normally committed atomically. A lock without a
      // matching assignment is stale and must not permanently block retries.
      await db.runTransaction(async (transaction) => {
        const currentLock = await transaction.get(lockRef);
        if (!currentLock.exists || String(currentLock.data()?.assignmentPath ?? '') !== assignmentPath) return;
        const currentAssignment = assignmentRef ? await transaction.get(assignmentRef) : null;
        const currentAssignmentData = currentAssignment?.exists ? currentAssignment.data() : null;
        if (!peerMarkingLockMatchesAssignment({
          lock: currentLock.data(),
          assignment: currentAssignmentData,
          assignmentPath,
          reviewerId: expectedReviewerId,
          cohort,
        })) transaction.delete(lockRef);
      });
      logger.warn('Removed stale peer-marking allocation lock', {
        subject: cohort.subject,
        grade: cohort.grade,
      });
      return '';
    }));
    const lockedReviewerIds = new Set(lockChecks.filter(Boolean));
    lockedReviewerIds.forEach((reviewerId) => assignedReviewerIds.add(reviewerId));
    const reviewers = submitted.filter((exercise) => !assignedReviewerIds.has(exercise.studentId));
    if (!reviewers.length) {
      logger.info('Peer-marking allocation skipped because submitted reviewers already have assignments', {
        subject: cohort.subject,
        grade: cohort.grade,
        submittedReviewerCount: submitted.length,
      });
      return;
    }
    const historicalSnapshot = await db.collectionGroup('exercises')
      .where('subject', '==', cohort.subject).where('grade', '==', cohort.grade).get();
    const candidates = historicalSnapshot.docs.filter((document) => hasSubmission(document.data()))
      .map((document) => ({ id: document.id, ...document.data(), ...parseExercisePath(document), ref: document.ref }));
    const pairs = buildAssignments({
      reviewers, candidates,
      topicKeysByReviewer: new Map(reviewers.map((reviewer) => [reviewer.studentId, getExerciseTopicKeys(reviewer)])),
      markedExerciseIdsByReviewer: new Map(), recentRevieweesByReviewer: new Map(), assignedReviewerIds,
      currentDate: cohort.assignmentDate, subject: cohort.subject, grade: cohort.grade,
    });
    for (const { reviewer, target } of pairs) {
      if (!sameCohort(cohortFor(reviewer), cohort)) continue;
      const assignmentRef = target.ref.collection('peerMarkingAssignments').doc(reviewer.studentId);
      const reviewerTopics = getExerciseTopicKeys(reviewer);
      const matchedTopics = getExerciseTopicNames(target)
        .filter((topic) => reviewerTopics.has(normalizeExerciseTopicKey(topic)));
      const targetTopics = getExerciseTopicNames(target);
      const assignedTopics = matchedTopics.length ? matchedTopics : targetTopics;
      const assignedTopicKeys = new Set(assignedTopics.map(normalizeExerciseTopicKey));
      const assignedQuestionLinks = getExerciseQuestionLinks(target)
        .filter((link) => !matchedTopics.length || assignedTopicKeys.has(normalizeExerciseTopicKey(link.topic)));
      const assignment = {
        assignmentId: assignmentRef.id,
        reviewerId: reviewer.studentId, reviewerSubjectInstanceId: reviewer.subjectInstanceId,
        reviewerExerciseId: reviewer.id, revieweeId: target.studentId, revieweeSubjectInstanceId: target.subjectInstanceId,
        exerciseId: target.id, assignmentPath: assignmentRef.path, exercisePath: target.ref.path,
        reviewerExercisePath: reviewer.ref.path, assignmentDate: cohort.assignmentDate,
        subject: cohort.subject, grade: cohort.grade, topic: assignedTopics[0] ?? '', topics: assignedTopics,
        matchedTopics, topicMatchType: matchedTopics.length ? 'shared' : 'unshared-fallback',
        topicBreakdown: (Array.isArray(target.topicBreakdown) ? target.topicBreakdown : [])
          .filter((item) => !matchedTopics.length || assignedTopicKeys.has(normalizeExerciseTopicKey(item.topic))),
        questionLinks: assignedQuestionLinks,
        paperIds: Array.isArray(target.paperIds) ? target.paperIds : [],
        title: target.title ?? '', submittedImageUrl: target.submittedImageUrl ?? '', submittedImages: target.submittedImages ?? [],
        status: 'assigned', createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      const assigned = await claimPeerMarkingAssignmentSlot({
        db, assignmentRef, reviewerId: reviewer.studentId, cohort, assignment,
      });
      if (!assigned) continue;
      assignedReviewerIds.add(reviewer.studentId);
      await sendNotificationToUsers({ userIds: [reviewer.studentId], title: 'New work to mark',
        body: `${cohort.subject} exercise is ready for peer marking.`, type: 'peer-marking.assigned', url: '/student?tab=mark',
        data: { assignmentId: assignmentRef.id, assignmentPath: assignmentRef.path, exerciseId: target.id }, tag: `peer-marking-${assignmentRef.id}` });
    }
    const fallbackReviewers = reviewers.filter((reviewer) => !assignedReviewerIds.has(reviewer.studentId));
    if (fallbackReviewers.length) {
      const excludedPaperIds = new Set(exerciseSnapshot.docs.flatMap((document) => {
        const exercise = document.data();
        return [...(Array.isArray(exercise.paperIds) ? exercise.paperIds : []),
          ...(Array.isArray(exercise.questionLinks) ? exercise.questionLinks.map((link) => link.paperId) : [])]
          .map((paperId) => String(paperId ?? '').trim()).filter(Boolean);
      }));
      const excludedQuestionIds = new Set(exerciseSnapshot.docs.flatMap((document) =>
        [...getExerciseQuestionIdentities(document.data())]));
      await assignFallbackPeerWork({ db, cohort, reviewers: fallbackReviewers, excludedPaperIds, excludedQuestionIds });
    }
    logger.info('Nested peer-marking allocation completed', {
      reviewerCount: reviewers.length,
      pairCount: pairs.length,
      fallbackReviewerCount: fallbackReviewers.length,
    });
  },
);

export const retryPeerMarkingFallbackForTutor = onCall({ cpu: 'gcf_gen1', timeoutSeconds: 180 }, async (request) => {
  const uid = String(request.auth?.uid ?? '').trim();
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before retrying work generation.');
  const { studentId, subjectInstanceId, exerciseId, regenerate = false } = request.data ?? {};
  if (typeof regenerate !== 'boolean') throw new HttpsError('invalid-argument', 'The regenerate option must be true or false.');
  const forceRegenerate = regenerate === true;
  if (![studentId, subjectInstanceId, exerciseId].every((value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.trim()))) {
    throw new HttpsError('invalid-argument', 'Student, subject episode, and exercise are required.');
  }

  const db = getDb();
  const [actorSnapshot, episodeSnapshot, exerciseSnapshot] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`users/${studentId}/subjects/${subjectInstanceId}`).get(),
    db.doc(`users/${studentId}/subjects/${subjectInstanceId}/exercises/${exerciseId}`).get(),
  ]);
  if (!actorSnapshot.exists || !['admin', 'tutor', 'teacher'].includes(actorSnapshot.data()?.role)) {
    throw new HttpsError('permission-denied', 'Only an assigned tutor or admin can retry work generation.');
  }
  if (!episodeSnapshot.exists || episodeSnapshot.data()?.status !== 'active' || !exerciseSnapshot.exists) {
    throw new HttpsError('failed-precondition', 'The student exercise or active subject is no longer available.');
  }
  const episode = episodeSnapshot.data();
  const actorRole = uid === episode.primaryTutorId ? 'co-owner' : episode.staffByUid?.[uid];
  if (actorSnapshot.data()?.role !== 'admin' && !['co-owner', 'marker'].includes(actorRole)) {
    throw new HttpsError('permission-denied', 'Your tutor access does not allow work-generation retries.');
  }
  const exercise = exerciseSnapshot.data();
  if (String(exercise.subjectInstanceId ?? subjectInstanceId) !== subjectInstanceId
    || String(exercise.studentId ?? studentId) !== studentId
    || !hasSubmission(exercise)) {
    throw new HttpsError('failed-precondition', 'This exercise has no submitted work to generate a marking task for.');
  }
  const cohort = cohortFor(exercise);
  if (!cohort.assignmentDate || !cohort.subject || !cohort.grade) {
    throw new HttpsError('failed-precondition', 'The exercise is missing its subject, grade, or assignment date.');
  }

  const reviewerAssignments = await db.collectionGroup('peerMarkingAssignments')
    .where('reviewerId', '==', studentId).get();
  const reviewerExerciseRef = exerciseSnapshot.ref;
  const fallbackAssignmentRef = reviewerExerciseRef.collection('peerMarkingAssignments').doc(studentId);
  const currentAssignment = reviewerAssignments.docs.find((document) => {
    const assignment = document.data();
    return assignment.reviewerExerciseId === exerciseId
      && assignment.reviewerSubjectInstanceId === subjectInstanceId
      && assignment.assignmentDate === cohort.assignmentDate
      && assignment.subject === cohort.subject
      && String(assignment.grade) === String(cohort.grade);
  });
  if (forceRegenerate && (!currentAssignment
    || currentAssignment.ref.path !== fallbackAssignmentRef.path
    || !canRegenerateSystemPeerWork(currentAssignment.data()))) {
    throw new HttpsError('failed-precondition', 'Only assigned, unmarked system-generated work can be regenerated.');
  }
  if (!forceRegenerate && currentAssignment && currentAssignment.data().status !== 'fallback_failed') {
    return { status: currentAssignment.data().status, alreadyAllocated: true };
  }
  if (currentAssignment && currentAssignment.data().systemGenerated !== true) {
    throw new HttpsError('failed-precondition', 'Only failed system-generated work can be retried from here.');
  }

  const lockRef = db.collection('peerMarkingAssignmentLocks')
    .doc(peerMarkingAllocationLockId({ ...cohort, reviewerId: studentId }));
  await db.runTransaction(async (transaction) => {
    const [assignmentSnapshot, lockSnapshot] = await Promise.all([
      transaction.get(fallbackAssignmentRef), transaction.get(lockRef),
    ]);
    const existing = assignmentSnapshot.exists ? assignmentSnapshot.data() : null;
    if (forceRegenerate && (!existing || !canRegenerateSystemPeerWork(existing))) {
      throw new HttpsError('failed-precondition', 'The system-generated work has already been marked or is no longer available to regenerate.');
    }
    if (!forceRegenerate && existing && existing.status !== 'fallback_failed') {
      throw new HttpsError('already-exists', 'Work is already assigned or being prepared.');
    }
    if (existing && existing.systemGenerated !== true) {
      throw new HttpsError('failed-precondition', 'This assignment is not a system-generated fallback.');
    }
    if (lockSnapshot.exists && lockSnapshot.data()?.assignmentPath
      && lockSnapshot.data().assignmentPath !== fallbackAssignmentRef.path) {
      throw new HttpsError('already-exists', 'A peer-marking task is already assigned for this exercise.');
    }
    if (existing) transaction.delete(fallbackAssignmentRef);
    if (lockSnapshot.exists) transaction.delete(lockRef);
    transaction.set(reviewerExerciseRef, {
      peerMarkingWorkStatus: 'pending',
      peerMarkingWorkAssignmentId: admin.firestore.FieldValue.delete(),
      peerMarkingWorkAssignmentPath: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  const sameDayExercises = await db.collectionGroup('exercises')
    .where('assignmentDate', '==', cohort.assignmentDate)
    .where('subject', '==', cohort.subject)
    .where('grade', '==', cohort.grade).get();
  const excludedPaperIds = new Set(sameDayExercises.docs.flatMap((document) => {
    const row = document.data();
    return [...(Array.isArray(row.paperIds) ? row.paperIds : []),
      ...(Array.isArray(row.questionLinks) ? row.questionLinks.map((link) => link.paperId) : [])]
      .map((paperId) => String(paperId ?? '').trim()).filter(Boolean);
  }));
  const excludedQuestionIds = new Set(sameDayExercises.docs.flatMap((document) => [...getExerciseQuestionIdentities(document.data())]));
  const reviewer = { ...exercise, id: exerciseId, studentId, subjectInstanceId, ref: reviewerExerciseRef };
  await assignFallbackPeerWork({
    db,
    cohort,
    reviewers: [reviewer],
    excludedPaperIds,
    excludedQuestionIds,
    retryNonce: randomUUID(),
    forceRegenerate,
  });

  const finalAssignment = await fallbackAssignmentRef.get();
  const finalStatus = finalAssignment.exists ? finalAssignment.data()?.status : 'not_available';
  if (finalStatus === 'not_available') {
    await reviewerExerciseRef.set({
      peerMarkingWorkStatus: 'not_available',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  logger.info('Tutor retried system-generated peer-work fallback', {
    studentId,
    exerciseId,
    assignmentDate: cohort.assignmentDate,
    status: finalStatus,
    regenerated: forceRegenerate,
  });
  return { status: finalStatus, assignmentPath: finalAssignment.exists ? finalAssignment.ref.path : '' };
});

export const completePeerMarkingAssignment = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to submit peer marking.');
  const { assignmentPath, reviewImages = [], reviewImageUrl, reviewFileName } = request.data ?? {};
  if (!assignmentPath || !/^users\/[^/]+\/subjects\/[^/]+\/exercises\/[^/]+\/peerMarkingAssignments\/[^/]+$/.test(assignmentPath)) {
    throw new HttpsError('invalid-argument', 'A valid nested assignment path is required.');
  }
  const pages = reviewImages.length ? reviewImages : reviewImageUrl ? [{ url: reviewImageUrl, fileName: reviewFileName, pageNumber: 1 }] : [];
  if (!pages.length) throw new HttpsError('invalid-argument', 'At least one marked image is required.');
  const db = getDb();
  const assignmentRef = db.doc(assignmentPath);
  const assignmentSnapshot = await assignmentRef.get();
  if (!assignmentSnapshot.exists) throw new HttpsError('not-found', 'Peer-marking assignment not found.');
  const assignment = assignmentSnapshot.data();
  const reviewerId = assignment.reviewerId;
  if (!reviewerId) throw new HttpsError('failed-precondition', 'This marking assignment has no reviewer.');
  let actingAsParent = false;
  if (reviewerId !== uid) {
    const [actorSnapshot, reviewerSnapshot] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('users').doc(reviewerId).get(),
    ]);
    actingAsParent = actorSnapshot.exists && actorSnapshot.data().role === 'parent'
      && reviewerSnapshot.exists && reviewerSnapshot.data().parentId === uid;
    if (!actingAsParent) throw new HttpsError('permission-denied', 'This work is assigned to another student.');
  }
  if (assignment.status !== 'assigned') throw new HttpsError('failed-precondition', 'This assignment is no longer available.');
  const now = admin.firestore.Timestamp.now();
  const primary = pages[0];
  const reviewRef = assignmentRef.parent.parent.collection('peerReviews').doc();
  const batch = db.batch();
  batch.set(reviewRef, { reviewerId, reviewerSubjectInstanceId: assignment.reviewerSubjectInstanceId,
    peerAssignmentId: assignmentRef.id, reviewImages: pages, reviewImageUrl: primary.url,
    reviewedAt: now, submittedBy: uid, submittedByParent: actingAsParent, status: 'completed' });
  batch.update(assignmentRef, { reviewId: reviewRef.id, reviewImages: pages, reviewImageUrl: primary.url,
    reviewFileName: primary.fileName ?? '', status: 'completed', completedAt: now, updatedAt: now });
  batch.update(assignmentRef.parent.parent, { peerReviewed: 'Yes', peerReviewStatus: 'completed',
    peerReviewDate: now, peerMarkedImages: pages, peerReviewerId: reviewerId, peerReviewSubmittedBy: uid, updatedAt: now });
  if (assignment.reviewerExercisePath) batch.set(db.doc(assignment.reviewerExercisePath), {
    peerMarkingImages: pages, markedPeerExerciseId: assignment.exerciseId,
    peerMarkingAssignmentId: assignmentRef.id, peerMarkingStatus: 'completed', updatedAt: now,
    peerMarkingWorkStatus: 'completed', peerMarkingWorkAssignmentId: assignmentRef.id,
    peerMarkingWorkAssignmentPath: assignmentRef.path,
  }, { merge: true });
  await batch.commit();
  return { success: true, assignmentId: assignmentRef.id, reviewId: reviewRef.id, status: 'completed' };
});
