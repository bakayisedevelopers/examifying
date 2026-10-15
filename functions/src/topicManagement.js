import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { admin, getDb } from './admin.js';
import { enqueueExerciseGenerationAfterTopicChange } from './exerciseGeneration.js';
import { getLessonTopicRemoval, normalizeTopicKey } from './topicManagementCore.js';

const normalizeSubject = (value = '') => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const requireTopicManager = async (db, uid) => {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before deleting student topics.');
  const snapshot = await db.doc(`users/${uid}`).get();
  if (!snapshot.exists || !['admin', 'tutor', 'teacher'].includes(snapshot.data().role)) {
    throw new HttpsError('permission-denied', 'Only a tutor or admin can delete student topics.');
  }
  return snapshot.data();
};

export const deleteStudentTopics = onCall({ cpu: 'gcf_gen1', timeoutSeconds: 300 }, async (request) => {
  const uid = String(request.auth?.uid ?? '').trim();
  const {
    studentId = '', subjectInstanceId = '', subject = '', topicIds = [], operationId = '',
  } = request.data ?? {};
  if (![studentId, subjectInstanceId, subject, operationId].every((item) => typeof item === 'string' && item.trim())
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(studentId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(subjectInstanceId)
    || !Array.isArray(topicIds) || !topicIds.length || topicIds.length > 50
    || !/^[a-zA-Z0-9_-]{8,100}$/.test(operationId)) {
    throw new HttpsError('invalid-argument', 'Choose up to 50 topics and provide a valid deletion request.');
  }
  const normalizedTopicIds = [...new Set(topicIds.map((item) => String(item ?? '').trim()))];
  if (normalizedTopicIds.some((item) => !/^[a-z0-9 ]{1,120}$/.test(item) || normalizeTopicKey(item) !== item)) {
    throw new HttpsError('invalid-argument', 'The selected topic identifiers are invalid. Reload the topic list and try again.');
  }

  const db = getDb();
  const actor = await requireTopicManager(db, uid);
  const isAdmin = actor.role === 'admin';
  const episodeRef = db.doc(`users/${studentId}/subjects/${subjectInstanceId}`);
  const operationRef = episodeRef.collection('topicDeletionOperations').doc(operationId);
  const [episodeSnapshot, studentSnapshot] = await Promise.all([
    episodeRef.get(),
    db.doc(`users/${studentId}`).get(),
  ]);
  const episode = episodeSnapshot.exists ? episodeSnapshot.data() : null;
  const student = studentSnapshot.exists ? studentSnapshot.data() : null;
  if (!episode || episode.status !== 'active'
    || (episode.studentId && episode.studentId !== studentId)
    || normalizeSubject(episode.subjectKey ?? episode.subjectName) !== normalizeSubject(subject)) {
    throw new HttpsError('failed-precondition', 'The selected active student subject could not be verified.');
  }
  const actorRole = uid === episode.primaryTutorId ? 'co-owner' : episode.staffByUid?.[uid];
  if (!isAdmin && actorRole !== 'co-owner') {
    throw new HttpsError('permission-denied', 'Co-owner access is required to permanently delete topics.');
  }
  const verifiedGrade = String(episode.grade ?? episode.gradeLevel ?? student?.grade ?? student?.gradeLevel ?? '').trim();

  const operation = await db.runTransaction(async (transaction) => {
    const [snapshot, currentEpisodeSnapshot] = await Promise.all([
      transaction.get(operationRef),
      transaction.get(episodeRef),
    ]);
    const currentEpisode = currentEpisodeSnapshot.exists ? currentEpisodeSnapshot.data() : null;
    const currentRole = uid === currentEpisode?.primaryTutorId ? 'co-owner' : currentEpisode?.staffByUid?.[uid];
    if (!currentEpisode || currentEpisode.status !== 'active'
      || normalizeSubject(currentEpisode.subjectKey ?? currentEpisode.subjectName) !== normalizeSubject(subject)
      || (!isAdmin && currentRole !== 'co-owner')) {
      throw new HttpsError('permission-denied', 'The active subject or your co-owner access has changed. Reload and try again.');
    }
    if (snapshot.exists && snapshot.data().status === 'completed') return { completed: true, result: snapshot.data().result ?? {} };
    if (snapshot.exists && snapshot.data().status === 'processing'
      && Date.now() - Number(snapshot.data().startedAtMs ?? 0) < 5 * 60 * 1000) {
      throw new HttpsError('already-exists', 'This topic deletion is already being processed.');
    }
    transaction.set(operationRef, {
      status: 'processing', startedAtMs: Date.now(), actorId: uid,
      subject, subjectInstanceId, topicIds: normalizedTopicIds,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { completed: false };
  });
  if (operation.completed) return operation.result;

  try {
    const topicRefs = normalizedTopicIds.map((topicId) => episodeRef.collection('topics').doc(topicId));
    const [topicSnapshots, lessonsSnapshot] = await Promise.all([
      Promise.all(topicRefs.map((ref) => ref.get())),
      episodeRef.collection('lessons').get(),
    ]);
    const existingTopics = topicSnapshots.filter((snapshot) => snapshot.exists);
    const existingIds = new Set(existingTopics.map((snapshot) => snapshot.id));
    const namesById = new Map(existingTopics.map((snapshot) => [
      snapshot.id,
      String(snapshot.data().topicName ?? snapshot.data().canonicalTopicKey ?? snapshot.id).trim(),
    ]));
    const deletedNames = normalizedTopicIds.map((id) => namesById.get(id)).filter(Boolean);
    const targetKeys = new Set([...normalizedTopicIds, ...deletedNames].map(normalizeTopicKey));

    const lessonUpdates = lessonsSnapshot.docs.flatMap((lessonSnapshot) => {
      const lesson = lessonSnapshot.data();
      const removal = getLessonTopicRemoval(lesson, targetKeys);
      if (!removal.changed) return [];
      const changes = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (removal.hasTopicsArray) changes.topics = removal.remainingTopics;
      if (removal.clearPrimaryTopic) {
        if (removal.remainingTopics.length) changes.topic = removal.remainingTopics[0];
        else changes.topic = admin.firestore.FieldValue.delete();
      }
      if (removal.remainingScores) {
        changes.topicUnderstandingScores = removal.remainingScores;
      }
      if (removal.resetCompletion) {
        changes.status = 'incomplete';
        changes.completedOn = admin.firestore.FieldValue.delete();
        changes.understandingLevel = admin.firestore.FieldValue.delete();
        changes.attendanceStatus = 'pending';
        changes.attended = null;
      }
      return [{ ref: lessonSnapshot.ref, changes }];
    });

    for (let index = 0; index < lessonUpdates.length; index += 400) {
      const batch = db.batch();
      lessonUpdates.slice(index, index + 400).forEach(({ ref, changes }) => batch.update(ref, changes));
      await batch.commit();
    }

    // recursiveDelete removes the topic document and every nested understandingScores document.
    for (const topicRef of topicRefs) await db.recursiveDelete(topicRef);

    const result = {
      deletedTopicCount: existingIds.size,
      deletedTopicNames: deletedNames,
      updatedLessonCount: lessonUpdates.length,
      subject,
      grade: verifiedGrade,
    };
    await enqueueExerciseGenerationAfterTopicChange({
      studentId,
      subjectInstanceId,
      subject,
      operationId,
    });
    await operationRef.set({
      status: 'completed', result,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return result;
  } catch (error) {
    await operationRef.set({
      status: 'failed',
      errorMessage: String(error?.message ?? 'Topic deletion failed.').slice(0, 240),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', 'The topics could not be deleted. Retry the operation.');
  }
});
