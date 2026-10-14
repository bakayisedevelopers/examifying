import { createHash } from 'node:crypto';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { PDFDataRangeTransport, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { getDb, storage } from './admin.js';
import { enqueueTaskOnce, stableTaskId } from './taskQueueUtils.js';
import { callOpenAiMarkingOnce } from './openAiMarking.js';
import { callGeminiMarkingOnce } from './geminiMarking.js';
import { callMarkingWithFallback } from './aiMarkingProviders.js';
import {
  aiMarkingTaskId,
  buildCompactQuestionContext,
  getRequestedMarkingQuestions,
  resolvePaperPageContext,
  submissionVersion,
  tutorAiMarkingEnabled,
  validateAiMarkingResponse,
} from './aiMarkingCore.js';
import { applyAiTutorExerciseScores, applyAiTutorPeerMarkingScores } from './tutorMarking.js';

const MAX_ATTEMPTS = 3;
const LEASE_MS = 12 * 60 * 1000;
const MAX_IMAGE_SIDE = 2200;
const PAGE_RENDER_SCALE = 1.55;
const TASK_OPTIONS = {
  retryConfig: { maxAttempts: MAX_ATTEMPTS, minBackoffSeconds: 30, maxBackoffSeconds: 180, maxDoublings: 2 },
  rateLimits: { maxConcurrentDispatches: 3, maxDispatchesPerSecond: 1 },
  timeoutSeconds: 540,
  memory: '2GiB',
  maxInstances: 3,
  secrets: [],
};

const hash = (value) => createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 24);
const timestampMillis = (value) => value?.toMillis?.() ?? (value instanceof Date ? value.getTime() : 0);
const safeErrorCode = (error) => String(error?.code || error?.name || 'ai_marking_error').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
const safeErrorMessage = (error) => String(error?.message || 'AI marking could not be completed.')
  .replace(/https?:\/\/\S+/g, '[url]')
  .replace(/(?:sk|rk)-[A-Za-z0-9_-]{12,}/g, '[secret]')
  .slice(0, 240);

const normalizeImageRefs = (record = {}, { preferReview = false } = {}) => {
  const rows = preferReview
    ? (Array.isArray(record.reviewImages) ? record.reviewImages : [])
    : Array.isArray(record.submittedImages) ? record.submittedImages
      : Array.isArray(record.peerMarkingImages) ? record.peerMarkingImages : [];
  const fallback = preferReview ? record.reviewImageUrl : record.submittedImageUrl || record.peerMarkingImageUrl || record.imageUrl;
  const images = rows.length ? rows : fallback ? [{ url: fallback, pageNumber: 1 }] : [];
  return images.map((image, index) => ({
    url: String(image?.url ?? image?.downloadUrl ?? '').trim(),
    pageNumber: Number(image?.pageNumber) || index + 1,
  })).filter((image) => image.url);
};

const parseStorageUrl = (value) => {
  const source = String(value ?? '').trim();
  if (source.startsWith('gs://')) {
    const path = source.slice(5);
    const separator = path.indexOf('/');
    return separator > 0 ? { bucketName: path.slice(0, separator), path: decodeURIComponent(path.slice(separator + 1)) } : null;
  }
  try {
    const parsed = new URL(source);
    const match = parsed.pathname.match(/\/b\/([^/]+)\/o\/(.+)$/);
    if (!match) return null;
    return { bucketName: decodeURIComponent(match[1]), path: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
};

const isStoredUnder = (url, bucketName, prefix) => {
  const parsed = parseStorageUrl(url);
  return Boolean(parsed && parsed.bucketName === bucketName && parsed.path.startsWith(prefix));
};

const currentVersionFor = (record, images) => submissionVersion(images.map((image) => ({
  url: image.url,
  pageNumber: image.pageNumber,
})).concat([{ url: String(record?.submittedAt?.toMillis?.() ?? record?.completedAt?.toMillis?.() ?? ''), pageNumber: 0 }]));

const setAiStatus = async ({ ref, status, version, attemptCount, submissionType = '', extra = {} }) => {
  const db = getDb();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return false;
    const record = snapshot.data();
    const prior = record.aiMarking ?? {};
    const type = submissionType || prior.submissionType || '';
    const images = normalizeImageRefs(record, { preferReview: type === 'peer_marking' });
    if (currentVersionFor(record, images) !== version || (prior.version && prior.version !== version)) return false;
    transaction.set(ref, {
      aiMarking: {
        status,
        version,
        attemptCount,
        ...(submissionType ? { submissionType } : {}),
        updatedAt: FieldValue.serverTimestamp(),
        ...extra,
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  });
};

const episodeAndTutorFor = async ({ db, studentId, subjectInstanceId }) => {
  const episodeRef = db.doc(`users/${studentId}/subjects/${subjectInstanceId}`);
  const episodeSnapshot = await episodeRef.get();
  if (!episodeSnapshot.exists) return { episode: null, tutorId: '' };
  const episode = episodeSnapshot.data();
  const tutorId = String(episode.primaryTutorId || Object.entries(episode.staffByUid ?? {})
    .find(([, role]) => role === 'co-owner' || role === 'marker')?.[0] || '').trim();
  return { episode, tutorId };
};

const enqueueAiJob = async ({ ref, studentId, subjectInstanceId, submissionType, version, images }) => {
  const db = getDb();
  const { episode, tutorId } = await episodeAndTutorFor({ db, studentId, subjectInstanceId });
  if (!episode || !tutorId) {
    await setAiStatus({ ref, status: 'skipped', version, submissionType, attemptCount: 0, extra: { skipReason: 'no_assigned_marking_tutor' } });
    return;
  }
  const tutorRef = db.doc(`users/${tutorId}`);
  const tutorSnapshot = await tutorRef.get();
  if (!tutorAiMarkingEnabled(tutorSnapshot.exists ? tutorSnapshot.data() : {})) {
    await setAiStatus({ ref, status: 'skipped', version, submissionType, attemptCount: 0, extra: { skipReason: 'disabled_by_tutor' } });
    return;
  }

  let shouldQueue = false;
  await db.runTransaction(async (transaction) => {
    const current = await transaction.get(ref);
    if (!current.exists) return;
    const data = current.data();
    const currentImages = normalizeImageRefs(data, { preferReview: submissionType === 'peer_marking' });
    if (currentVersionFor(data, currentImages) !== version) return;
    const prior = data.aiMarking ?? {};
    if (prior.version === version && prior.status !== 'pending') return;
    if (prior.version && prior.version !== version) return;
    if (prior.version !== version) transaction.set(ref, {
      aiMarking: {
        status: 'pending', version, submissionType, attemptCount: 0,
        submittedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        validatedResult: FieldValue.delete(), completedAt: FieldValue.delete(), startedAt: FieldValue.delete(),
        leaseExpiresAt: FieldValue.delete(), errorCode: FieldValue.delete(), errorMessage: FieldValue.delete(),
        model: FieldValue.delete(), usage: FieldValue.delete(), message: FieldValue.delete(),
        contextCacheStatus: FieldValue.delete(), contextCacheUsed: FieldValue.delete(),
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    shouldQueue = true;
  });
  if (!shouldQueue) return;

  const submissionId = `${submissionType}:${ref.path}`;
  const taskId = aiMarkingTaskId({ submissionType, submissionId, version });
  await enqueueTaskOnce('processAiMarkingTask', {
    submissionType,
    documentPath: ref.path,
    studentId,
    subjectInstanceId,
    exerciseId: ref.id,
    version,
    imageCount: images.length,
  }, { id: stableTaskId('ai-mark', taskId) });
};

const isExerciseSubmitted = (exercise = {}) => Boolean(exercise.submittedImageUrl || exercise.submitted === 'Yes'
  || exercise.submissionStatus === 'submitted' || (Array.isArray(exercise.submittedImages) && exercise.submittedImages.length));

export const queueStudentExerciseAiMarking = onDocumentWritten({
  document: 'users/{studentId}/subjects/{subjectInstanceId}/exercises/{exerciseId}',
  timeoutSeconds: 90,
  memory: '256MiB',
}, async (event) => {
  const after = event.data?.after?.exists ? event.data.after.data() : null;
  if (!after || !isExerciseSubmitted(after)) return;
  const images = normalizeImageRefs(after);
  if (!images.length) return;
  const version = currentVersionFor(after, images);
  await enqueueAiJob({
    ref: event.data.after.ref,
    studentId: event.params.studentId,
    subjectInstanceId: event.params.subjectInstanceId,
    submissionType: 'student_exercise',
    version,
    images,
  });
});
export const queuePeerMarkingAiReview = onDocumentWritten({
  document: 'users/{studentId}/subjects/{subjectInstanceId}/exercises/{exerciseId}/peerMarkingAssignments/{assignmentId}',
  timeoutSeconds: 90,
  memory: '256MiB',
}, async (event) => {
  const after = event.data?.after?.exists ? event.data.after.data() : null;
  if (!after || after.status !== 'completed' || !after.reviewImages?.length) return;
  const images = normalizeImageRefs(after, { preferReview: true });
  if (!images.length) return;
  const version = currentVersionFor(after, images);
  const reviewerId = String(after.reviewerId || '').trim();
  const reviewerSubjectInstanceId = String(after.reviewerSubjectInstanceId || '').trim();
  if (!reviewerId || !reviewerSubjectInstanceId) {
    await setAiStatus({ ref: event.data.after.ref, status: 'skipped', version, submissionType: 'peer_marking', attemptCount: 0, extra: { skipReason: 'reviewer_context_missing' } });
    return;
  }
  await enqueueAiJob({
    ref: event.data.after.ref,
    studentId: reviewerId,
    subjectInstanceId: reviewerSubjectInstanceId,
    submissionType: 'peer_marking',
    version,
    images,
  });
});

class StorageRangeTransport extends PDFDataRangeTransport {
  constructor(file, length, initialData) {
    super(length, initialData, false);
    this.file = file;
  }

  requestDataRange(begin, end) {
    this.file.download({ start: begin, end: end - 1 }).then(([buffer]) => {
      this.onDataRange(begin, new Uint8Array(buffer));
    }).catch((error) => {
      logger.warn('AI marking could not read one PDF range', { code: safeErrorCode(error) });
      this.onDataRange(begin, new Uint8Array());
    });
  }
}

const loadPageImages = async ({ paper, pageNumbers, bucket }) => {
  const parsed = parseStorageUrl(paper.paperUrl);
  if (!parsed || parsed.bucketName !== bucket.name || !parsed.path.startsWith('questionPapers/')) {
    throw new Error(`Source question paper ${paper.id} is not stored in the configured Firebase Storage bucket.`);
  }
  const file = bucket.file(parsed.path);
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size);
  if (!Number.isSafeInteger(size) || size < 8) throw new Error(`Source question paper ${paper.id} has an invalid file size.`);
  const firstRangeEnd = Math.min(size, 65536);
  const [firstRange] = await file.download({ start: 0, end: firstRangeEnd - 1 });
  const range = new StorageRangeTransport(file, size, new Uint8Array(firstRange));
  const loading = getDocument({ range, disableStream: true, disableAutoFetch: true, rangeChunkSize: 65536 });
  const pdf = await loading.promise;
  try {
    const output = [];
    for (const pageNumber of pageNumbers) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) {
        throw new Error(`Analyzed page ${pageNumber} is outside source question paper ${paper.id}.`);
      }
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: PAGE_RENDER_SCALE });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      output.push({ paperId: paper.id, pageNumber, dataUrl: `data:image/jpeg;base64,${canvas.toBuffer('image/jpeg', 0.82).toString('base64')}` });
      page.cleanup?.();
    }
    return output;
  } finally {
    await pdf.destroy?.();
  }
};

const resizeAnswerImage = async ({ file, url }) => {
  const [buffer] = await file.download();
  const image = await loadImage(buffer);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  const jpeg = canvas.toBuffer('image/jpeg', 0.82);
  return { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, sizeBytes: jpeg.length, sourceHash: hash(url) };
};

const readAnswerImages = async ({ refs, bucket, prefix, label }) => {
  const output = [];
  for (const image of refs) {
    if (!isStoredUnder(image.url, bucket.name, prefix)) throw new Error(`${label} image path failed ownership validation.`);
    const parsed = parseStorageUrl(image.url);
    const result = await resizeAnswerImage({ file: bucket.file(parsed.path), url: image.url });
    output.push({ ...result, pageNumber: image.pageNumber });
  }
  return output;
};

const getTutorContext = async ({ db, studentId, subjectInstanceId }) => {
  const { episode, tutorId } = await episodeAndTutorFor({ db, studentId, subjectInstanceId });
  if (!episode || !tutorId) throw new Error('No assigned tutor is available to apply AI-assisted marks.');
  const tutorSnapshot = await db.doc(`users/${tutorId}`).get();
  return { episode, tutorId, enabled: tutorAiMarkingEnabled(tutorSnapshot.exists ? tutorSnapshot.data() : {}) };
};

const buildSubmissionContext = async ({ db, sourceRecord, bucket }) => {
  const questions = getRequestedMarkingQuestions(sourceRecord);
  const paperIds = [...new Set(questions.map((question) => question.paperId))];
  const paperSnapshots = await Promise.all(paperIds.map((paperId) => db.doc(`questionPapers/${paperId}`).get()));
  const analysesByPaper = {};
  const paperDocuments = new Map();
  paperSnapshots.forEach((snapshot, index) => {
    if (!snapshot.exists) throw new Error(`Question paper ${paperIds[index]} is unavailable.`);
    const paper = snapshot.data();
    if (!Array.isArray(paper.questions)) throw new Error(`Analysis data for question paper ${paperIds[index]} is unavailable.`);
    analysesByPaper[paperIds[index]] = paper.questions;
    paperDocuments.set(paperIds[index], { id: snapshot.id, ...paper });
  });
  const pageContext = resolvePaperPageContext({ requestedQuestions: questions, analysesByPaper });
  const pagesByPaper = new Map();
  for (const page of pageContext.pages) {
    const pages = pagesByPaper.get(page.paperId) ?? [];
    pages.push(page.pageNumber);
    pagesByPaper.set(page.paperId, pages);
  }
  const contextPages = (await Promise.all([...pagesByPaper].map(([paperId, pageNumbers]) =>
    loadPageImages({ paper: paperDocuments.get(paperId), pageNumbers, bucket })))).flat();
  return { questions, contextPages, requestedPageCount: contextPages.length };
};

const getTaskData = async ({ db, task, exerciseRef, assignmentRef }) => {
  if (task.submissionType === 'student_exercise') {
    const exerciseSnapshot = await exerciseRef.get();
    if (!exerciseSnapshot.exists) return null;
    return { sourceRecord: exerciseSnapshot.data(), sourceRef: exerciseRef, exercise: exerciseSnapshot.data(), assignment: null };
  }
  if (task.submissionType !== 'peer_marking') return null;
  const assignmentSnapshot = await assignmentRef.get();
  if (!assignmentSnapshot.exists) return null;
  const assignment = assignmentSnapshot.data();
  const revieweeExercisePath = String(assignment.exercisePath || assignmentRef.parent.parent.path);
  if (revieweeExercisePath !== assignmentRef.parent.parent.path) throw new Error('Peer assignment source path failed ownership validation.');
  const reviewerExercisePath = String(assignment.reviewerExercisePath || '');
  const expectedReviewerExercisePath = `users/${task.studentId}/subjects/${task.subjectInstanceId}/exercises/${assignment.reviewerExerciseId}`;
  if (reviewerExercisePath !== expectedReviewerExercisePath) throw new Error('Peer marking exercise path failed ownership validation.');
  const [revieweeSnapshot, reviewerSnapshot] = await Promise.all([
    db.doc(revieweeExercisePath).get(),
    db.doc(reviewerExercisePath).get(),
  ]);
  if (!revieweeSnapshot.exists || !reviewerSnapshot.exists) throw new Error('The original submission or peer marking exercise is unavailable.');
  const sourceRecord = {
    ...assignment,
    questionLinks: Array.isArray(assignment.questionLinks) && assignment.questionLinks.length
      ? assignment.questionLinks : revieweeSnapshot.data().questionLinks ?? [],
    topicBreakdown: assignment.topicBreakdown ?? revieweeSnapshot.data().topicBreakdown ?? [],
  };
  return {
    sourceRecord,
    sourceRef: assignmentRef,
    exercise: revieweeSnapshot.data(),
    assignment,
    reviewerExercise: reviewerSnapshot.data(),
    reviewerExerciseRef: db.doc(reviewerExercisePath),
  };
};

const clearPeerSubmission = async ({ db, bucket, assignmentRef, assignment, studentId, subjectInstanceId, version, status, message }) => {
  const reviewerExercisePath = `users/${studentId}/subjects/${subjectInstanceId}/exercises/${assignment.reviewerExerciseId}`;
  const reviewerExerciseRef = db.doc(reviewerExercisePath);
  const allowedPrefix = `${reviewerExercisePath}/peer-reviews/`;
  const reviewRef = assignment.reviewId ? assignmentRef.parent.parent.collection('peerReviews').doc(String(assignment.reviewId)) : null;
  const exactUrls = normalizeImageRefs(assignment, { preferReview: true }).map((image) => image.url);
  const files = exactUrls.map((url) => {
    const parsed = parseStorageUrl(url);
    if (!parsed || parsed.bucketName !== bucket.name || !parsed.path.startsWith(allowedPrefix)) {
      throw new Error('Peer marking cleanup path failed ownership validation.');
    }
    return bucket.file(parsed.path);
  });
  await Promise.all(files.map((file) => file.delete({ ignoreNotFound: true })));
  await db.runTransaction(async (transaction) => {
    const [currentAssignment, reviewerExercise] = await Promise.all([
      transaction.get(assignmentRef), transaction.get(reviewerExerciseRef),
    ]);
    if (!currentAssignment.exists || currentAssignment.data().status !== 'completed'
      || currentVersionFor(currentAssignment.data(), normalizeImageRefs(currentAssignment.data(), { preferReview: true })) !== version
      || currentAssignment.data().aiMarking?.version !== version) return;
    if (reviewRef) transaction.delete(reviewRef);
    transaction.set(assignmentRef, {
      status: 'assigned', reviewImages: FieldValue.delete(), reviewImageUrl: FieldValue.delete(), reviewFileName: FieldValue.delete(),
      reviewId: FieldValue.delete(), completedAt: FieldValue.delete(),
      aiMarking: { status, version, message, validatedResult: FieldValue.delete(), completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (reviewerExercise.exists && reviewerExercise.data().peerMarkingAssignmentId === assignmentRef.id) {
      transaction.set(reviewerExerciseRef, {
        peerMarkingImages: FieldValue.delete(), peerMarkingAssignmentId: FieldValue.delete(), peerMarkingStatus: 'pending',
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  });
};

const clearExerciseSubmission = async ({ db, bucket, exerciseRef, exerciseId, version, status, message }) => {
  const exercisePath = exerciseRef.path;
  const prefix = `${exercisePath}/submissions/`;
  const nestedSubmissionRef = exerciseRef.collection('submissions').doc(exerciseId);
  const currentSnapshot = await exerciseRef.get();
  if (!currentSnapshot.exists || currentVersionFor(currentSnapshot.data(), normalizeImageRefs(currentSnapshot.data())) !== version) return false;
  const files = normalizeImageRefs(currentSnapshot.data()).map((image) => {
    const parsed = parseStorageUrl(image.url);
    if (!parsed || parsed.bucketName !== bucket.name || !parsed.path.startsWith(prefix)) {
      throw new Error('Exercise submission cleanup path failed ownership validation.');
    }
    return bucket.file(parsed.path);
  });
  await Promise.all(files.map((file) => file.delete({ ignoreNotFound: true })));
  const patch = {
    submittedImageUrl: FieldValue.delete(), imageUrl: FieldValue.delete(), submittedImages: FieldValue.delete(),
    submittedFileName: FieldValue.delete(), submittedFileNames: FieldValue.delete(), submissionPageCount: FieldValue.delete(),
    submittedAt: FieldValue.delete(), submitted: 'No', submissionStatus: 'not-submitted', status: 'not-submitted',
    submittedImageAnalysis: FieldValue.delete(), submittedImageAnalysisModel: FieldValue.delete(), submittedImageAnalyzedAt: FieldValue.delete(),
    peerReviewed: 'No', peerReviewStatus: 'pending', peerReviewDate: FieldValue.delete(), peerMarkedImages: FieldValue.delete(),
    peerReviewerId: FieldValue.delete(), peerReviewSubmittedBy: FieldValue.delete(),
    aiMarking: { status, version, message, validatedResult: FieldValue.delete(), completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
    updatedAt: FieldValue.serverTimestamp(),
  };
  await db.runTransaction(async (transaction) => {
    const latest = await transaction.get(exerciseRef);
    if (!latest.exists || currentVersionFor(latest.data(), normalizeImageRefs(latest.data())) !== version
      || latest.data().aiMarking?.version !== version) return;
    const assignments = await transaction.get(exerciseRef.collection('peerMarkingAssignments').where('status', '==', 'assigned'));
    transaction.set(exerciseRef, patch, { merge: true });
    transaction.set(nestedSubmissionRef, { ...patch, exerciseId }, { merge: true });
    assignments.docs.forEach((item) => transaction.delete(item.ref));
  });
  return true;
};

const applyMarks = async ({ task, sourceRecord, questions, results, tutorId, assignmentRef }) => {
  const questionsByTopic = new Map();
  for (const mark of results) {
    const list = questionsByTopic.get(mark.topic) ?? [];
    list.push({ questionReference: mark.questionNumber, paperId: mark.paperId, pageNumber: mark.pageNumber, earnedMarks: mark.earnedMarks, totalMarks: mark.totalMarks });
    questionsByTopic.set(mark.topic, list);
  }
  const scoreEventId = `ai-${hash(`${task.submissionType}:${task.documentPath}:${task.version}`)}`;
  if (task.submissionType === 'student_exercise') {
    const outputs = [];
    for (const [topic, questionMarks] of questionsByTopic) {
      const topicQuestion = questions.find((question) => question.topic === topic);
      outputs.push(await applyAiTutorExerciseScores({
        tutorId,
        studentId: task.studentId,
        subjectInstanceId: task.subjectInstanceId,
        exerciseId: task.exerciseId,
        subject: sourceRecord.subject,
        topic,
        topicId: topicQuestion?.topicId || '',
        questionMarks,
        scoreEventId,
        aiMarkingVersion: task.version,
      }));
    }
    return outputs;
  }
  const topicMarks = [...questionsByTopic].map(([topic, questionMarks]) => ({
    topic,
    topicId: questions.find((question) => question.topic === topic)?.topicId || '',
    questionMarks,
  }));
  return applyAiTutorPeerMarkingScores({
    tutorId,
    peerAssignmentPath: assignmentRef.path,
    peerAssignmentId: assignmentRef.id,
    reviewerExerciseId: sourceRecord.reviewerExerciseId,
    studentId: task.studentId,
    topicMarks,
    scoreEventId,
    aiMarkingVersion: task.version,
  });
};

const claimTask = async ({ ref, version }) => {
  const db = getDb();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return { run: false, reason: 'missing' };
    const record = snapshot.data();
    const ai = record.aiMarking ?? {};
    const images = normalizeImageRefs(record, { preferReview: record.aiMarking?.submissionType === 'peer_marking' });
    if (currentVersionFor(record, images) !== version || ai.version !== version) return { run: false, reason: 'stale' };
    if (['completed', 'incorrect_submission', 'unclear_images', 'skipped'].includes(ai.status)) return { run: false, reason: 'terminal' };
    if (ai.status === 'processing' && timestampMillis(ai.leaseExpiresAt) > Date.now()) return { run: false, reason: 'already_processing' };
    const attemptCount = Number(ai.attemptCount || 0) + 1;
    if (attemptCount > MAX_ATTEMPTS) return { run: false, reason: 'attempt_limit' };
    transaction.set(ref, { aiMarking: {
      ...ai,
      status: 'processing', version, submissionType: ai.submissionType || '', attemptCount,
      startedAt: ai.startedAt || FieldValue.serverTimestamp(),
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      updatedAt: FieldValue.serverTimestamp(),
    }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { run: true, attemptCount, cachedResult: ai.validatedResult ?? null };
  });
};

const persistValidatedResult = async ({ ref, version, validated, metadata }) => {
  const db = getDb();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return false;
    const record = snapshot.data();
    if (record.aiMarking?.version !== version || record.aiMarking?.status !== 'processing' || currentVersionFor(record,
      normalizeImageRefs(record, { preferReview: record.aiMarking?.submissionType === 'peer_marking' })) !== version) return false;
    transaction.set(ref, { aiMarking: {
      ...record.aiMarking,
      validatedResult: { ...validated, metadata },
      model: metadata.model,
      usage: metadata.usage,
      requestDurationMs: metadata.requestDurationMs,
      responseIdHash: metadata.responseId ? hash(metadata.responseId) : '',
      provider: metadata.provider,
      fallbackUsed: metadata.fallbackUsed,
      fallbackReasonCode: metadata.fallbackReasonCode,
      contextCacheStatus: metadata.contextCacheStatus,
      contextCacheUsed: metadata.contextCacheUsed,
      pdfPageCount: metadata.pdfPageCount,
      answerImageCount: metadata.answerImageCount,
      updatedAt: FieldValue.serverTimestamp(),
    }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
};

const logMarkingStats = ({ operation, task, model, provider, fallbackUsed, fallbackReasonCode, contextCacheStatus, contextCacheUsed, usage, requestDurationMs, pdfPageCount, answerImageCount, status, attemptCount }) => {
  logger.info('AI marking request finished', {
    operation,
    requestId: hash(`${task.documentPath}:${task.version}`),
    model: String(model || ''),
    provider: String(provider || ''),
    fallbackUsed: fallbackUsed === true,
    fallbackReasonCode: String(fallbackReasonCode || ''),
    inputTokens: Number(usage?.inputTokens) || 0,
    outputTokens: Number(usage?.outputTokens) || 0,
    totalTokens: Number(usage?.totalTokens) || 0,
    cachedInputTokens: Number(usage?.cachedInputTokens) || 0,
    cacheWriteTokens: Number(usage?.cacheWriteTokens) || 0,
    contextCacheStatus: String(contextCacheStatus || 'none'),
    contextCacheUsed: contextCacheUsed === true,
    requestDurationMs: Number(requestDurationMs) || 0,
    pdfPageCount: Number(pdfPageCount) || 0,
    answerImageCount: Number(answerImageCount) || 0,
    status,
    attemptCount,
  });
};

export const processAiMarkingTask = onTaskDispatched(TASK_OPTIONS, async (request) => {
  const task = request.data ?? {};
  if (!['student_exercise', 'peer_marking'].includes(task.submissionType)
    || !String(task.documentPath || '').startsWith('users/') || !task.studentId || !task.subjectInstanceId || !task.version) {
    throw new Error('The AI marking task payload is invalid.');
  }
  const db = getDb();
  const bucket = storage.bucket();
  const sourceRef = db.doc(task.documentPath);
  const exerciseRef = task.submissionType === 'student_exercise' ? sourceRef : sourceRef.parent.parent;
  const assignmentRef = task.submissionType === 'peer_marking' ? sourceRef : null;
  const claimed = await claimTask({ ref: sourceRef, version: task.version });
  if (!claimed.run) {
    logger.info('AI marking task skipped', { operation: task.submissionType, requestId: hash(`${task.documentPath}:${task.version}`), reason: claimed.reason });
    return;
  }

  let attemptCount = claimed.attemptCount;
  let contextPages = [];
  let answerImages = [];
  let originalAnswerImages = [];
  let modelMeta = {};
  let aiRequestAttempted = false;
  try {
    const taskData = await getTaskData({ db, task, exerciseRef, assignmentRef });
    if (!taskData) return;
    const { sourceRecord, exercise, assignment } = taskData;
    const currentSourceSnapshot = await sourceRef.get();
    if (!currentSourceSnapshot.exists) return;
    const currentSourceRecord = currentSourceSnapshot.data();
    const currentImages = normalizeImageRefs(currentSourceRecord, { preferReview: task.submissionType === 'peer_marking' });
    if (currentVersionFor(currentSourceRecord, currentImages) !== task.version) return;
    const tutorContext = await getTutorContext({ db, studentId: task.studentId, subjectInstanceId: task.subjectInstanceId });
    if (!tutorContext.enabled) {
      await setAiStatus({ ref: sourceRef, status: 'skipped', version: task.version, submissionType: task.submissionType, attemptCount, extra: { skipReason: 'disabled_by_tutor' } });
      return;
    }
    const { tutorId } = tutorContext;
    const { questions, contextPages: resolvedPages, requestedPageCount } = await buildSubmissionContext({ db, sourceRecord, bucket });
    contextPages = resolvedPages;

    if (task.submissionType === 'student_exercise') {
      const allowedPrefix = `${exerciseRef.path}/submissions/`;
      answerImages = await readAnswerImages({ refs: currentImages, bucket, prefix: allowedPrefix, label: 'Exercise answer' });
    } else {
      const reviewRefs = normalizeImageRefs(assignment, { preferReview: true });
      const peerReviewPrefix = `users/${task.studentId}/subjects/${task.subjectInstanceId}/exercises/${assignment.reviewerExerciseId}/peer-reviews/`;
      answerImages = await readAnswerImages({ refs: reviewRefs, bucket, prefix: peerReviewPrefix, label: 'Peer marking' });
      const originalRefs = normalizeImageRefs({ submittedImages: assignment.submittedImages, submittedImageUrl: assignment.submittedImageUrl });
      const originalPrefix = `${exerciseRef.path}/submissions/`;
      originalAnswerImages = await readAnswerImages({ refs: originalRefs, bucket, prefix: originalPrefix, label: 'Original learner answer' });
    }

    if (!claimed.cachedResult) aiRequestAttempted = true;
    const modelRequest = {
      submissionType: task.submissionType,
      questions: buildCompactQuestionContext(questions),
      contextPages,
      originalAnswerImages: task.submissionType === 'peer_marking' ? originalAnswerImages : [],
      answerImages,
      requestId: hash(`${task.documentPath}:${task.version}`),
    };
    const rawResponse = claimed.cachedResult ? null : await callMarkingWithFallback({
      request: modelRequest,
      callPrimary: callOpenAiMarkingOnce,
      callFallback: callGeminiMarkingOnce,
      validateResponse: (response) => validateAiMarkingResponse({ response, requestedQuestions: questions }),
      onPrimaryFailure: (error) => logger.warn('OpenAI marking failed; trying Gemini fallback', {
        operation: task.submissionType,
        requestId: hash(`${task.documentPath}:${task.version}`),
        code: safeErrorCode(error),
        status: Number(error?.status) || null,
      }),
    });
    const rawResult = claimed.cachedResult?.result ?? rawResponse;
    const validated = claimed.cachedResult?.status ? claimed.cachedResult
      : validateAiMarkingResponse({ response: rawResult, requestedQuestions: questions });
    modelMeta = claimed.cachedResult?.metadata ?? rawResponse ?? {};
    const meta = {
      model: String(modelMeta.model || ''),
      provider: String(modelMeta.provider || ''),
      fallbackUsed: modelMeta.fallbackUsed === true,
      fallbackReasonCode: String(modelMeta.fallbackReasonCode || ''),
      contextCacheStatus: String(modelMeta.contextCacheStatus || 'none'),
      contextCacheUsed: modelMeta.contextCacheUsed === true,
      usage: modelMeta.usage ?? null,
      requestDurationMs: Number(modelMeta.requestDurationMs) || 0,
      responseId: String(modelMeta.responseId ?? ''),
      pdfPageCount: requestedPageCount,
      answerImageCount: answerImages.length + originalAnswerImages.length,
    };
    const saved = await persistValidatedResult({ ref: sourceRef, version: task.version, validated, metadata: meta });
    if (!saved) return;

    if (validated.status === 'completed') {
      await applyMarks({ task, sourceRecord: { ...sourceRecord, ...exercise }, questions, results: validated.results, tutorId, assignmentRef });
      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(sourceRef);
        if (!current.exists || current.data().aiMarking?.version !== task.version
          || current.data().aiMarking?.status !== 'processing'
          || currentVersionFor(current.data(), normalizeImageRefs(current.data(), { preferReview: task.submissionType === 'peer_marking' })) !== task.version) return;
        transaction.set(sourceRef, { aiMarking: {
          status: 'completed', version: task.version, attemptCount,
          completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
          model: meta.model, usage: meta.usage, requestDurationMs: meta.requestDurationMs,
          provider: meta.provider, fallbackUsed: meta.fallbackUsed, fallbackReasonCode: meta.fallbackReasonCode,
          contextCacheStatus: meta.contextCacheStatus, contextCacheUsed: meta.contextCacheUsed,
          pdfPageCount: meta.pdfPageCount, answerImageCount: meta.answerImageCount,
          validatedResult: FieldValue.delete(), leaseExpiresAt: FieldValue.delete(), message: '',
        }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      });
      logMarkingStats({ operation: task.submissionType, task, ...meta, status: 'completed', attemptCount });
      return;
    }

    const status = validated.status;
    const message = status === 'incorrect_submission'
      ? 'The submitted images did not match the assigned exercise. Please upload the correct work.'
      : 'We could not read your uploaded work clearly. Please upload clear images and submit again.';
    if (task.submissionType === 'student_exercise') {
      await clearExerciseSubmission({ db, bucket, exerciseRef, exerciseId: task.exerciseId, version: task.version, status, message });
    } else {
      await clearPeerSubmission({ db, bucket, assignmentRef, assignment, studentId: task.studentId, subjectInstanceId: task.subjectInstanceId, version: task.version, status, message });
    }
    logMarkingStats({ operation: task.submissionType, task, ...meta, status, attemptCount });
  } catch (error) {
    const current = await sourceRef.get().catch(() => null);
    if (current?.exists && current.data()?.aiMarking?.version === task.version
      && currentVersionFor(current.data(), normalizeImageRefs(current.data(), { preferReview: task.submissionType === 'peer_marking' })) === task.version) {
      const hasCachedValidatedResult = Boolean(current.data()?.aiMarking?.validatedResult?.status);
      if ((aiRequestAttempted && !hasCachedValidatedResult) || attemptCount >= MAX_ATTEMPTS) {
        await setAiStatus({ ref: sourceRef, status: 'failed', version: task.version, submissionType: task.submissionType, attemptCount, extra: {
          completedAt: FieldValue.serverTimestamp(), errorCode: safeErrorCode(error), errorMessage: safeErrorMessage(error),
          leaseExpiresAt: FieldValue.delete(),
        } });
      } else {
        await setAiStatus({ ref: sourceRef, status: 'pending', version: task.version, submissionType: task.submissionType, attemptCount, extra: {
          leaseExpiresAt: FieldValue.delete(), errorCode: safeErrorCode(error), errorMessage: safeErrorMessage(error),
        } });
        throw error;
      }
    }
    logMarkingStats({ operation: task.submissionType, task, model: modelMeta.model, provider: modelMeta.provider, fallbackUsed: modelMeta.fallbackUsed, fallbackReasonCode: modelMeta.fallbackReasonCode, usage: modelMeta.usage, requestDurationMs: modelMeta.requestDurationMs, pdfPageCount: contextPages.length, answerImageCount: answerImages.length, status: 'failed', attemptCount });
  }
});
