import { createHash } from 'node:crypto';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { admin, getDb } from './admin.js';
import { isSubjectAvailableForGrade, normalizeSupportedSubject } from './subjects.js';

const normalizeTopicKey = (value = '') => String(value)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[’']s\b/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

const currentJohannesburgDate = (value = new Date()) => {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
};

const normalizeTopicScores = (topicScores) => {
  if (!Array.isArray(topicScores) || !topicScores.length || topicScores.length > 25) {
    throw new HttpsError('invalid-argument', 'Choose between 1 and 25 topics.');
  }
  const normalized = topicScores.map((entry) => {
    const topic = String(entry?.topic ?? '').trim();
    const score = Number(entry?.understandingLevel);
    const topicKey = normalizeTopicKey(topic);
    if (!topic || !topicKey || topicKey.length > 120 || !Number.isFinite(score) || score < 0 || score > 10) {
      throw new HttpsError('invalid-argument', 'Each topic needs a valid name and a score from 0 to 10.');
    }
    return {
      topic,
      topicKey,
      scoreOutOfTen: Math.round(score * 100) / 100,
      score: Math.round((score / 10) * 10000) / 10000,
    };
  });
  if (new Set(normalized.map((entry) => entry.topicKey)).size !== normalized.length) {
    throw new HttpsError('invalid-argument', 'A topic can only be added once per save.');
  }
  return normalized;
};

const fingerprintFor = (topicScores) => createHash('sha256')
  .update(JSON.stringify(topicScores.map(({ topicKey, score }) => ({ topicKey, score })).sort((a, b) => a.topicKey.localeCompare(b.topicKey))))
  .digest('hex');

export const addManualCompletedTopics = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before adding completed topics.');

  const data = request.data ?? {};
  const studentId = String(data.studentId ?? '').trim();
  const subjectInstanceId = String(data.subjectInstanceId ?? '').trim();
  const subject = normalizeSupportedSubject(data.subject);
  const grade = String(data.grade ?? '').trim();
  const operationId = String(data.operationId ?? '').trim();
  if (!studentId || !subjectInstanceId || !subject || !grade || !operationId || !/^[a-zA-Z0-9_-]{8,100}$/.test(operationId)) {
    throw new HttpsError('invalid-argument', 'A student, active subject, grade, and valid operation ID are required.');
  }
  if (!isSubjectAvailableForGrade(subject, grade)) {
    throw new HttpsError('failed-precondition', 'The selected subject is not available for this student grade.');
  }
  const topicScores = normalizeTopicScores(data.topicScores);
  const fingerprint = fingerprintFor(topicScores);
  const db = getDb();
  const actorRef = db.collection('users').doc(uid);
  const studentRef = db.collection('users').doc(studentId);
  const episodeRef = db.collection('users').doc(studentId).collection('subjects').doc(subjectInstanceId);
  const catalogRef = db.collection('subjects').doc(subject).collection('grades').doc(grade);
  const lessonId = `manual-topic-${operationId}`;
  const lessonRef = episodeRef.collection('lessons').doc(lessonId);
  const topicRefs = topicScores.map((entry) => ({
    ...entry,
    topicRef: episodeRef.collection('topics').doc(entry.topicKey),
    scoreRef: episodeRef.collection('topics').doc(entry.topicKey)
      .collection('understandingScores').doc(`Lesson-${lessonId}`),
  }));

  const result = await db.runTransaction(async (transaction) => {
    const [actorSnapshot, studentSnapshot, episodeSnapshot, catalogSnapshot, existingLessonSnapshot] = await Promise.all([
      transaction.get(actorRef),
      transaction.get(studentRef),
      transaction.get(episodeRef),
      transaction.get(catalogRef),
      transaction.get(lessonRef),
    ]);
    const actor = actorSnapshot.exists ? actorSnapshot.data() : null;
    const isAdmin = actor?.role === 'admin';
    const isTutorOrTeacher = ['tutor', 'teacher'].includes(actor?.role)
      || actor?.isTeacher === true || actor?.isTeacher === 'true';
    if (!actor || (!isTutorOrTeacher && !isAdmin)) {
      throw new HttpsError('permission-denied', 'Only a tutor, teacher, or admin can record completed topics.');
    }
    const episode = episodeSnapshot.exists ? episodeSnapshot.data() : null;
    const student = studentSnapshot.exists ? studentSnapshot.data() : null;
    const verifiedGrade = String(episode?.grade ?? episode?.gradeLevel ?? student?.grade ?? student?.gradeLevel ?? '').trim();
    if (!episode || episode.status !== 'active'
      || normalizeSupportedSubject(episode.subjectKey ?? episode.subjectName ?? '') !== subject
      || !verifiedGrade || verifiedGrade !== grade
      || (episode.studentId && episode.studentId !== studentId)) {
      throw new HttpsError('failed-precondition', 'The selected active student subject could not be verified.');
    }
    const hasLessonManagementAccess = episode.primaryTutorId === uid || episode.staffByUid?.[uid] === 'co-owner';
    if (!isAdmin && !hasLessonManagementAccess) {
      throw new HttpsError('permission-denied', 'Co-owner access is required to add completed lesson topics.');
    }
    if (!catalogSnapshot.exists || !Array.isArray(catalogSnapshot.data()?.topics)) {
      throw new HttpsError('failed-precondition', `No topic catalogue is available for ${subject}, ${grade}.`);
    }
    const catalogTopicKeys = new Set(catalogSnapshot.data().topics.map(normalizeTopicKey).filter(Boolean));
    if (topicScores.some((entry) => !catalogTopicKeys.has(entry.topicKey))) {
      throw new HttpsError('failed-precondition', 'One or more selected topics are no longer in the subject topic catalogue. Reload the topic list.');
    }

    if (existingLessonSnapshot.exists) {
      const existing = existingLessonSnapshot.data();
      if (existing.recordType !== 'manual_topic_completion'
        || existing.createdBy !== uid
        || existing.operationFingerprint !== fingerprint) {
        throw new HttpsError('already-exists', 'This save ID has already been used for a different topic entry.');
      }
      return { lessonId, topicCount: topicScores.length, alreadySaved: true };
    }

    const topicAndScoreSnapshots = await Promise.all(topicRefs.flatMap((entry) => [
      transaction.get(entry.topicRef), transaction.get(entry.scoreRef),
    ]));
    for (let index = 0; index < topicRefs.length; index += 1) {
      if (topicAndScoreSnapshots[index * 2].exists || topicAndScoreSnapshots[index * 2 + 1].exists) {
        throw new HttpsError('failed-precondition', `“${topicRefs[index].topic}” already exists in this student's subject history. Refresh the topic list.`);
      }
    }

    const now = admin.firestore.Timestamp.now();
    const topics = topicScores.map((entry) => entry.topic);
    const understandingLevel = Math.round((topicScores.reduce((sum, entry) => sum + entry.score, 0) / topicScores.length) * 10000) / 10000;
    const topicReport = 'Manual topic completion recorded by tutor.';
    transaction.set(lessonRef, {
      lessonId,
      studentId,
      tutorId: uid,
      createdBy: uid,
      subject,
      subjectInstanceId,
      grade,
      topic: topics[0],
      topics,
      topicReport,
      note: topicReport,
      understandingLevel,
      status: 'completed',
      attendanceStatus: 'attended',
      attended: true,
      lessonDate: currentJohannesburgDate(),
      completedOn: currentJohannesburgDate(),
      lessonType: 'online',
      sessionMode: 'manual-topic-completion',
      manualTopicCompletion: true,
      recordType: 'manual_topic_completion',
      operationFingerprint: fingerprint,
      createdAt: now,
      updatedAt: now,
    });

    topicRefs.forEach((entry) => {
      transaction.set(entry.scoreRef, {
        sourceType: 'Lesson',
        sourceId: lessonId,
        lessonId,
        studentId,
        subjectInstanceId,
        score: entry.score,
        scoreScale: 'ratio-0-to-1',
        tutorId: uid,
        notes: topicReport,
        createdAt: now,
      });
      transaction.set(entry.topicRef, {
        canonicalTopicKey: entry.topicKey,
        topicName: entry.topic,
        topicStatus: 'done',
        attendanceStatus: 'attended',
        firstCompletedAt: now,
        lastCoveredAt: now,
        understandingLevel: entry.score,
        understandingScale: 'ratio-0-to-1',
        scoreCount: 1,
        latestScore: entry.score,
        scoreWindowDays: 28,
        scoreUpdatedAt: now,
        tutorReport: topicReport,
        createdAt: now,
        updatedAt: now,
      });
    });
    return { lessonId, topicCount: topicScores.length, alreadySaved: false };
  });

  return { ...result, generationWillBeChecked: true };
});
