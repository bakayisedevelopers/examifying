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
  getPendingMarkingQuestions,
  getRequestedMarkingQuestions,
  groupAiContextRequestsByPaper,
  mergeAiMarkingResults,
  resolvePaperPageContext,
  submissionVersion,
  tutorAiMarkingEnabled,
  validateAiMarkingResponse,
} from './aiMarkingCore.js';
import { applyAiTutorExerciseScores, applyAiTutorPeerMarkingScores } from './tutorMarking.js';

const MAX_ATTEMPTS = 3;
const MAX_CONTEXT_FALLBACK_PASSES = 2;
const LEASE_MS = 12 * 60 * 1000;
const MAX_IMAGE_SIDE = 2200;
const PAGE_RENDER_SCALE = 1.55;
const MAX_FALLBACK_SOURCE_PAGES = 80;
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

export const loadPageImages = async ({ paper, pageNumbers = [], bucket, documentType = 'paper', allPages = false }) => {
  const sourceUrl = documentType === 'memo' ? paper.memoUrl : paper.paperUrl;
  const parsed = parseStorageUrl(sourceUrl);
  if (!parsed || parsed.bucketName !== bucket.name || !parsed.path.startsWith('questionPapers/')) {
    throw new Error(`Source ${documentType} ${paper.id} is not stored in the configured Firebase Storage bucket.`);
  }
  const pathType = String(parsed.path.split('/')[2] || '').toLocaleLowerCase();
  const isMemoPath = /^(memo|memorandum|marking[-_ ]?(?:memo|scheme|guide))$/.test(pathType);
  const isQuestionPath = /^(question|paper|question[-_ ]paper)$/.test(pathType);
  if ((documentType === 'memo' && isQuestionPath) || (documentType === 'paper' && isMemoPath)) {
    throw new Error(`Source ${documentType} ${paper.id} points to a different document type in Storage.`);
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
    if (pdf.numPages > MAX_FALLBACK_SOURCE_PAGES) throw new Error(`Source ${documentType} ${paper.id} exceeds the safe page limit.`);
    const requestedPageNumbers = allPages
      ? Array.from({ length: pdf.numPages }, (_, index) => index + 1)
      : [...new Set(pageNumbers)].sort((left, right) => left - right);
    const invalidPageNumbers = requestedPageNumbers.filter((pageNumber) =>
      !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages);
    for (const pageNumber of requestedPageNumbers.filter((page) => !invalidPageNumbers.includes(page))) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: PAGE_RENDER_SCALE });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      output.push({
        paperId: paper.id,
        pageNumber,
        documentType,
        dataUrl: `data:image/jpeg;base64,${canvas.toBuffer('image/jpeg', 0.82).toString('base64')}`,
      });
      page.cleanup?.();
    }
    return { pages: output, pageCount: pdf.numPages, invalidPageNumbers };
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
    analysesByPaper[paperIds[index]] = Array.isArray(paper.questions) ? paper.questions : [];
    paperDocuments.set(paperIds[index], { id: snapshot.id, ...paper });
  });
  const pageContext = resolvePaperPageContext({ requestedQuestions: questions, analysesByPaper });
  const questionContexts = new Map(pageContext.questionContexts.map((item) => [item.questionId, item]));
  const pagesByPaper = new Map();
  for (const page of pageContext.pages) {
    const pages = pagesByPaper.get(page.paperId) ?? [];
    pages.push(page.pageNumber);
    pagesByPaper.set(page.paperId, pages);
  }
  const renderedPagesByPaper = new Map();
  const invalidPagesByPaper = new Map();
  const unreadablePaperIds = new Set();
  await Promise.all([...pagesByPaper].map(async ([paperId, pageNumbers]) => {
    try {
      const loaded = await loadPageImages({ paper: paperDocuments.get(paperId), pageNumbers, bucket });
      renderedPagesByPaper.set(paperId, loaded.pages);
      invalidPagesByPaper.set(paperId, new Set(loaded.invalidPageNumbers));
    } catch (error) {
      unreadablePaperIds.add(paperId);
      logger.warn('AI marking will request a full paper after source-page retrieval failed', {
        paperIdHash: hash(paperId), code: safeErrorCode(error),
      });
    }
  }));

  const fallbackQuestionIds = new Set(pageContext.fallbackQuestionIds);
  for (const context of questionContexts.values()) {
    const invalidPages = invalidPagesByPaper.get(context.paperId) ?? new Set();
    if (unreadablePaperIds.has(context.paperId)
      || !context.pageNumbers.length
      || context.pageNumbers.some((pageNumber) => invalidPages.has(pageNumber))) {
      fallbackQuestionIds.add(context.questionId);
    }
  }
  const initialQuestions = questions.filter((question) => !fallbackQuestionIds.has(question.questionId));
  const initialIds = new Set(initialQuestions.map((question) => question.questionId));
  const requiredPageKeys = new Set(initialQuestions.flatMap((question) => {
    const context = questionContexts.get(question.questionId);
    return (context?.pageNumbers ?? []).map((pageNumber) => `${question.paperId}::${pageNumber}`);
  }));
  const contextPages = [...renderedPagesByPaper.values()].flat()
    .filter((page) => requiredPageKeys.has(`${page.paperId}::${page.pageNumber}`));
  const questionContextPages = new Map();
  for (const question of questions) {
    if (!initialIds.has(question.questionId)) continue;
    const context = questionContexts.get(question.questionId);
    const pages = (context?.pageNumbers ?? []).map((pageNumber) =>
      renderedPagesByPaper.get(question.paperId)?.find((page) => page.pageNumber === pageNumber)).filter(Boolean);
    questionContextPages.set(question.questionId, pages);
  }
  return {
    questions,
    initialQuestions,
    contextPages,
    questionContextPages,
    contextRequests: [...fallbackQuestionIds].map((questionId) => ({ questionId, material: 'full_paper' })),
    paperDocuments,
    requestedPageCount: contextPages.length,
  };
};

const buildRequestedSourceContext = async ({
  contextRequests,
  pendingQuestions,
  suppliedMaterialsByQuestion = {},
  questionContextPages = new Map(),
  paperDocuments = new Map(),
  bucket,
}) => {
  const pendingById = new Map(pendingQuestions.map((question) => [question.questionId, question]));
  const requestedByQuestion = new Map();
  for (const paperGroup of groupAiContextRequestsByPaper(contextRequests)) {
    for (const [questionId, requestedMaterials] of Object.entries(paperGroup.materialsByQuestion)) {
      if (!pendingById.has(questionId)) continue;
      const materials = requestedByQuestion.get(questionId) ?? new Set();
      requestedMaterials.forEach((material) => materials.add(material));
      requestedByQuestion.set(questionId, materials);
    }
  }

  const materialsByQuestion = new Map();
  const plansByPaper = new Map();
  for (const question of pendingQuestions) {
    const materials = new Set(requestedByQuestion.get(question.questionId) ?? []);
    for (const priorMaterial of suppliedMaterialsByQuestion[question.questionId] ?? []) {
      if (['full_paper', 'memo'].includes(priorMaterial)) materials.add(priorMaterial);
    }
    materialsByQuestion.set(question.questionId, materials);
    for (const material of materials) {
      const questions = plansByPaper.get(`${question.paperId}::${material}`) ?? { paperId: question.paperId, material, questionIds: new Set() };
      questions.questionIds.add(question.questionId);
      plansByPaper.set(`${question.paperId}::${material}`, questions);
    }
  }

  const loadedMaterialsByQuestion = new Map();
  const unavailableQuestionIds = new Set();
  const contextPages = [];
  await Promise.all([...plansByPaper.values()].map(async (plan) => {
    const paper = paperDocuments.get(plan.paperId);
    const sourceUrl = plan.material === 'memo' ? paper?.memoUrl : paper?.paperUrl;
    if (!paper || !sourceUrl) {
      plan.questionIds.forEach((questionId) => unavailableQuestionIds.add(questionId));
      return;
    }
    try {
      const loaded = await loadPageImages({ paper, bucket, documentType: plan.material === 'memo' ? 'memo' : 'paper', allPages: true });
      contextPages.push(...loaded.pages);
      plan.questionIds.forEach((questionId) => {
        const materials = loadedMaterialsByQuestion.get(questionId) ?? new Set();
        materials.add(plan.material);
        loadedMaterialsByQuestion.set(questionId, materials);
      });
    } catch (error) {
      logger.warn('AI marking could not load requested source context', {
        paperIdHash: hash(plan.paperId), material: plan.material, code: safeErrorCode(error),
      });
      plan.questionIds.forEach((questionId) => unavailableQuestionIds.add(questionId));
    }
  }));

  for (const question of pendingQuestions) {
    const materials = materialsByQuestion.get(question.questionId) ?? new Set();
    if (materials.has('memo') && !materials.has('full_paper')) {
      contextPages.push(...(questionContextPages.get(question.questionId) ?? []));
    }
    const requestedMaterials = requestedByQuestion.get(question.questionId) ?? new Set();
    const loadedMaterials = loadedMaterialsByQuestion.get(question.questionId) ?? new Set();
    if ([...materials].some((material) => !loadedMaterials.has(material))
      || [...requestedMaterials].some((material) => !loadedMaterials.has(material))) {
      unavailableQuestionIds.add(question.questionId);
    }
  }

  const uniquePages = new Map();
  for (const page of contextPages) {
    const key = `${page.paperId}::${page.documentType || 'paper'}::${page.pageNumber}`;
    if (!uniquePages.has(key)) uniquePages.set(key, page);
  }
  const availableQuestions = pendingQuestions.filter((question) => !unavailableQuestionIds.has(question.questionId)
    && requestedByQuestion.has(question.questionId));
  return {
    contextPages: [...uniquePages.values()].sort((left, right) => String(left.paperId).localeCompare(String(right.paperId))
      || String(left.documentType).localeCompare(String(right.documentType)) || left.pageNumber - right.pageNumber),
    availableQuestions,
    unavailableQuestionIds: [...unavailableQuestionIds],
  };
};

const mergeContextRequests = (...requestLists) => {
  const unique = new Map();
  for (const request of requestLists.flat()) {
    const key = `${request.questionId}::${request.material}`;
    if (!unique.has(key)) unique.set(key, request);
  }
  return [...unique.values()];
};

const mergeModelMetadata = (prior = {}, next = {}, { pageCount = 0, answerImageCount = 0 } = {}) => {
  const providers = new Set([prior.provider, next.provider].filter(Boolean));
  const models = new Set([prior.model, next.model].filter(Boolean));
  const priorUsage = prior.usage ?? {};
  const nextUsage = next.usage ?? {};
  const usageKeys = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteTokens'];
  const usage = Object.fromEntries(usageKeys.map((key) => [key, (Number(priorUsage[key]) || 0) + (Number(nextUsage[key]) || 0)]));
  return {
    model: [...models].join('+'),
    provider: [...providers].join('+'),
    fallbackUsed: prior.fallbackUsed === true || next.fallbackUsed === true,
    fallbackReasonCode: String(next.fallbackReasonCode || prior.fallbackReasonCode || ''),
    contextCacheStatus: prior.contextCacheStatus && next.contextCacheStatus && prior.contextCacheStatus !== next.contextCacheStatus
      ? 'multiple' : String(next.contextCacheStatus || prior.contextCacheStatus || 'none'),
    contextCacheUsed: prior.contextCacheUsed === true || next.contextCacheUsed === true,
    usage,
    requestDurationMs: (Number(prior.requestDurationMs) || 0) + (Number(next.requestDurationMs) || 0),
    responseId: String(next.responseId || prior.responseId || ''),
    pdfPageCount: (Number(prior.pdfPageCount) || 0) + pageCount,
    answerImageCount: (Number(prior.answerImageCount) || 0) + answerImageCount,
  };
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
    if (['completed', 'incorrect_submission', 'unclear_images', 'failed', 'skipped'].includes(ai.status)) return { run: false, reason: 'terminal' };
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

const logMarkingStats = ({ operation, task, model, provider, fallbackUsed, fallbackReasonCode, contextCacheStatus, contextCacheUsed, usage, requestDurationMs, pdfPageCount, answerImageCount, status, attemptCount, contextFallbackPasses, contextRequestCount }) => {
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
    contextFallbackPasses: Number(contextFallbackPasses) || 0,
    contextRequestCount: Number(contextRequestCount) || 0,
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
    const sourceContext = await buildSubmissionContext({ db, sourceRecord, bucket });
    const { questions, initialQuestions } = sourceContext;
    contextPages = sourceContext.contextPages;

    if (task.submissionType === 'student_exercise') {
      const allowedPrefix = `${exerciseRef.path}/submissions/`;
      answerImages = await readAnswerImages({ refs: currentImages, bucket, prefix: allowedPrefix, label: 'Exercise answer' });
    } else {
      const reviewRefs = normalizeImageRefs(assignment, { preferReview: true });
      const peerReviewPrefix = `users/${task.studentId}/subjects/${task.subjectInstanceId}/exercises/${assignment.reviewerExerciseId}/peer-reviews/`;
      answerImages = await readAnswerImages({ refs: reviewRefs, bucket, prefix: peerReviewPrefix, label: 'Peer marking' });
      const originalRefs = normalizeImageRefs({ submittedImages: assignment.submittedImages, submittedImageUrl: assignment.submittedImageUrl });
      const originalPrefix = assignment.systemGenerated === true
        ? `${taskData.reviewerExerciseRef.path}/system-generated-peer-work/`
        : `${exerciseRef.path}/submissions/`;
      originalAnswerImages = await readAnswerImages({ refs: originalRefs, bucket, prefix: originalPrefix, label: 'Original learner answer' });
    }

    const emptyMetadata = {
      model: '', provider: '', fallbackUsed: false, fallbackReasonCode: '', contextCacheStatus: 'none',
      contextCacheUsed: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
      requestDurationMs: 0, responseId: '', pdfPageCount: 0, answerImageCount: 0,
    };
    let progress = claimed.cachedResult?.pipelineVersion === 1 ? claimed.cachedResult : null;
    const legacyCachedResult = claimed.cachedResult && !progress ? claimed.cachedResult : null;
    let metadata = progress?.metadata ?? legacyCachedResult?.metadata ?? emptyMetadata;
    modelMeta = metadata;

    const saveProgress = async (nextProgress) => {
      progress = { pipelineVersion: 1, ...nextProgress, metadata };
      const saved = await persistValidatedResult({ ref: sourceRef, version: task.version, validated: progress, metadata });
      if (!saved) throw new Error('The AI marking submission changed before its validated results could be saved.');
    };
    const applyAcceptedResults = async (results) => {
      if (!results.length) return;
      await applyMarks({ task, sourceRecord: { ...sourceRecord, ...exercise }, questions, results, tutorId, assignmentRef });
    };
    const finalize = async ({ status, message = '', errorCode = '' }) => {
      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(sourceRef);
        if (!current.exists || current.data().aiMarking?.version !== task.version
          || current.data().aiMarking?.status !== 'processing'
          || currentVersionFor(current.data(), normalizeImageRefs(current.data(), { preferReview: task.submissionType === 'peer_marking' })) !== task.version) return;
        transaction.set(sourceRef, { aiMarking: {
          status, version: task.version, attemptCount,
          completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
          model: metadata.model, usage: metadata.usage, requestDurationMs: metadata.requestDurationMs,
          provider: metadata.provider, fallbackUsed: metadata.fallbackUsed, fallbackReasonCode: metadata.fallbackReasonCode,
          contextCacheStatus: metadata.contextCacheStatus, contextCacheUsed: metadata.contextCacheUsed,
          pdfPageCount: metadata.pdfPageCount, answerImageCount: metadata.answerImageCount,
          contextFallbackPasses: progress?.fallbackPasses ?? 0,
          contextRequestCount: progress?.contextRequestCount ?? 0,
          ...(status === 'failed' ? { errorCode, errorMessage: message } : { errorCode: FieldValue.delete(), errorMessage: FieldValue.delete() }),
          validatedResult: FieldValue.delete(), leaseExpiresAt: FieldValue.delete(), message,
        }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      });
      logMarkingStats({
        operation: task.submissionType, task, ...metadata, status, attemptCount,
        contextFallbackPasses: progress?.fallbackPasses ?? 0,
        contextRequestCount: progress?.contextRequestCount ?? 0,
      });
    };
    const handleRejectedSubmission = async (validated) => {
      const message = validated.status === 'incorrect_submission'
        ? 'The submitted images did not match the assigned exercise. Please upload the correct work.'
        : 'We could not read your uploaded work clearly. Please upload clear images and submit again.';
      await persistValidatedResult({ ref: sourceRef, version: task.version, validated, metadata });
      if (task.submissionType === 'student_exercise') {
        await clearExerciseSubmission({ db, bucket, exerciseRef, exerciseId: task.exerciseId, version: task.version, status: validated.status, message });
      } else {
        await clearPeerSubmission({ db, bucket, assignmentRef, assignment, studentId: task.studentId, subjectInstanceId: task.subjectInstanceId, version: task.version, status: validated.status, message });
      }
      logMarkingStats({ operation: task.submissionType, task, ...metadata, status: validated.status, attemptCount });
    };
    const callModelForQuestions = async ({ requestedQuestions, pages, contextPass, suppliedMaterialsByQuestion }) => {
      if (!requestedQuestions.length) throw new Error('No questions were available for the requested AI marking pass.');
      aiRequestAttempted = true;
      const requestMetadata = {
        submissionType: task.submissionType,
        sourceType: assignment?.sourceType || 'student_submission',
        questions: buildCompactQuestionContext(requestedQuestions),
        contextPages: pages,
        originalAnswerImages: task.submissionType === 'peer_marking' ? originalAnswerImages : [],
        answerImages,
        contextPass,
        suppliedMaterialsByQuestion,
        requestId: hash(`${task.documentPath}:${task.version}:${contextPass}:${progress?.fallbackPasses ?? 0}`),
      };
      const response = await callMarkingWithFallback({
        request: requestMetadata,
        callPrimary: callOpenAiMarkingOnce,
        callFallback: callGeminiMarkingOnce,
        validateResponse: (result) => validateAiMarkingResponse({
          response: result, requestedQuestions, suppliedMaterialsByQuestion,
        }),
        onPrimaryFailure: (error) => logger.warn('OpenAI marking failed; trying Gemini fallback', {
          operation: task.submissionType,
          requestId: hash(`${task.documentPath}:${task.version}:${contextPass}`),
          code: safeErrorCode(error),
          status: Number(error?.status) || null,
        }),
      });
      const validated = validateAiMarkingResponse({ response, requestedQuestions, suppliedMaterialsByQuestion });
      metadata = mergeModelMetadata(metadata, response, {
        pageCount: pages.length,
        answerImageCount: answerImages.length + originalAnswerImages.length,
      });
      modelMeta = response;
      return validated;
    };

    if (legacyCachedResult?.status === 'incorrect_submission' || legacyCachedResult?.status === 'unclear_images') {
      await handleRejectedSubmission(legacyCachedResult);
      return;
    }
    if (legacyCachedResult?.status === 'completed') {
      await applyAcceptedResults(legacyCachedResult.results ?? []);
      progress = { fallbackPasses: 0, contextRequestCount: 0 };
      await finalize({ status: 'completed' });
      return;
    }

    if (progress) await applyAcceptedResults(progress.results ?? []);
    if (progress?.status === 'completed') {
      await finalize({ status: 'completed' });
      return;
    }
    if (progress?.status === 'manual_review') {
      await finalize({ status: 'failed', errorCode: 'source_context_unavailable', message: 'Some questions need tutor review because their source paper or memo could not be retrieved.' });
      return;
    }

    if (!progress) {
      let initialValidated = { status: 'full_paper_search', results: [], contextRequests: [] };
      if (initialQuestions.length) {
        initialValidated = await callModelForQuestions({
          requestedQuestions: initialQuestions,
          pages: sourceContext.contextPages,
          contextPass: 'analysis_pages',
          suppliedMaterialsByQuestion: Object.fromEntries(initialQuestions.map((question) => [question.questionId, ['analysis_pages']])),
        });
        if (['incorrect_submission', 'unclear_images'].includes(initialValidated.status)) {
          await handleRejectedSubmission(initialValidated);
          return;
        }
      }
      const completedIds = new Set(initialValidated.results.map((result) => result.questionId));
      const forcedFallbackRequests = sourceContext.contextRequests
        .filter((item) => !completedIds.has(item.questionId));
      const contextRequests = mergeContextRequests(initialValidated.contextRequests, forcedFallbackRequests);
      const initialSuppliedMaterials = Object.fromEntries(initialQuestions.map((question) => [question.questionId, ['analysis_pages']]));
      progress = {
        pipelineVersion: 1,
        status: contextRequests.length ? 'full_paper_search' : 'completed',
        results: initialValidated.results,
        contextRequests,
        suppliedMaterialsByQuestion: initialSuppliedMaterials,
        fallbackPasses: 0,
        contextRequestCount: contextRequests.length,
      };
      await saveProgress(progress);
      await applyAcceptedResults(progress.results);
      if (progress.status === 'completed') {
        await finalize({ status: 'completed' });
        return;
      }
    }

    while (progress.contextRequests?.length && progress.fallbackPasses < MAX_CONTEXT_FALLBACK_PASSES) {
      const pendingQuestions = getPendingMarkingQuestions(questions, progress.results ?? []);
      const pendingIds = new Set(pendingQuestions.map((question) => question.questionId));
      const requests = (progress.contextRequests ?? []).filter((item) => pendingIds.has(item.questionId));
      if (!requests.length) break;
      const fallbackContext = await buildRequestedSourceContext({
        contextRequests: requests,
        pendingQuestions,
        suppliedMaterialsByQuestion: progress.suppliedMaterialsByQuestion ?? {},
        questionContextPages: sourceContext.questionContextPages,
        paperDocuments: sourceContext.paperDocuments,
        bucket,
      });
      const availableIds = new Set(fallbackContext.availableQuestions.map((question) => question.questionId));
      const availableRequests = requests.filter((item) => availableIds.has(item.questionId));
      if (!fallbackContext.availableQuestions.length) {
        progress = {
          ...progress,
          status: 'manual_review',
          contextRequests: [],
          unavailableQuestionIds: [...new Set([...(progress.unavailableQuestionIds ?? []), ...fallbackContext.unavailableQuestionIds])],
        };
        await saveProgress(progress);
        break;
      }

      const suppliedForPass = { ...(progress.suppliedMaterialsByQuestion ?? {}) };
      for (const requestItem of availableRequests) {
        const materials = new Set(suppliedForPass[requestItem.questionId] ?? []);
        materials.add(requestItem.material);
        suppliedForPass[requestItem.questionId] = [...materials];
      }
      const contextPass = availableRequests.some((item) => item.material === 'full_paper') ? 'full_paper_search' : 'memo_search';
      const validated = await callModelForQuestions({
        requestedQuestions: fallbackContext.availableQuestions,
        pages: fallbackContext.contextPages,
        contextPass,
        suppliedMaterialsByQuestion: suppliedForPass,
      });
      if (['incorrect_submission', 'unclear_images'].includes(validated.status)) {
        progress = {
          ...progress,
          status: 'manual_review',
          contextRequests: [],
          suppliedMaterialsByQuestion: suppliedForPass,
          fallbackPasses: progress.fallbackPasses + 1,
          contextRequestCount: (progress.contextRequestCount ?? 0) + requests.length,
        };
        await saveProgress(progress);
        break;
      }

      const results = mergeAiMarkingResults(progress.results ?? [], validated.results);
      const remainingIds = new Set(getPendingMarkingQuestions(questions, results).map((question) => question.questionId));
      const nextRequests = validated.contextRequests.filter((item) => remainingIds.has(item.questionId));
      progress = {
        ...progress,
        status: nextRequests.length ? validated.status : 'completed',
        results,
        contextRequests: nextRequests,
        suppliedMaterialsByQuestion: suppliedForPass,
        fallbackPasses: progress.fallbackPasses + 1,
        contextRequestCount: (progress.contextRequestCount ?? 0) + requests.length,
        unavailableQuestionIds: [...new Set([...(progress.unavailableQuestionIds ?? []), ...fallbackContext.unavailableQuestionIds])],
      };
      await saveProgress(progress);
      await applyAcceptedResults(validated.results);
    }

    const unmarkedQuestions = getPendingMarkingQuestions(questions, progress.results ?? []);
    if (unmarkedQuestions.length) {
      const message = 'Some questions need tutor review because their source paper or memo was unavailable or insufficient.';
      progress = { ...progress, status: 'manual_review', contextRequests: [] };
      await saveProgress(progress);
      await finalize({ status: 'failed', errorCode: 'source_context_incomplete', message });
      return;
    }
    await finalize({ status: 'completed' });
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
