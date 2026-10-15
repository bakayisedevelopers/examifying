import { randomUUID } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { getDb, storage } from './admin.js';
import { enqueueTaskOnce, stableTaskId } from './taskQueueUtils.js';
import { questionIdentity } from './aiMarkingCore.js';
import { loadSystemPeerWorkSourcePdf } from './peerMarkingFallbackPdf.js';
import { getExerciseTopicNames, normalizeExerciseTopicKey } from './peerMarkingAllocation.js';
import { sendNotificationToUsers } from './notifications.js';
import {
  getExerciseGenerationSubjectQueryValues,
  isAnalyzedExerciseSourcePaper,
  matchesExerciseGenerationPaper,
  normalizeExerciseGenerationGrade,
  normalizeExerciseGenerationSubject,
} from './exerciseGenerationPaperMatching.js';
import {
  SYSTEM_PEER_WORK_PROMPT_VERSION,
  selectReusableSystemPeerWork,
  selectReusableSystemPeerWorkWithFallback,
  selectSystemPeerWorkQuestionsWithFallback,
  systemPeerWorkCohortKey,
  systemPeerWorkPackId,
  systemPeerWorkTopicSignature,
} from './peerMarkingFallbackCore.js';
import { claimPeerMarkingAssignmentSlot } from './peerMarkingAssignmentStore.js';
import { solveSystemPeerWork } from './peerMarkingFallbackAi.js';
import { wrapPeerWorkText } from './peerWorkImageFormatting.js';
import { publishPeerWorkWithRetry } from './peerWorkPublishCore.js';
import { safePeerWorkErrorMessage } from './peerWorkErrorDetails.js';

const GENERATION_TASK = 'generateSystemPeerWorkTask';
const GENERATION_OPTIONS = {
  retryConfig: { maxAttempts: 1 },
  rateLimits: { maxConcurrentDispatches: 2, maxDispatchesPerSecond: 1 },
  timeoutSeconds: 540,
  memory: '2GiB',
  maxInstances: 3,
};
const SAFE_IMAGE_DIMENSION = 3000;
const safeErrorCode = (error) => String(error?.code || error?.name || 'peer_work_generation_failed')
  .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
const safeErrorMessage = safePeerWorkErrorMessage;

const workCollection = (db, cohortKey) => db.collection('systemGeneratedPeerWork').doc(cohortKey).collection('packs');
const packPath = (cohortKey, packId) => `systemGeneratedPeerWork/${cohortKey}/packs/${packId}`;
const assignmentRefFor = (reviewer) => reviewer.ref.collection('peerMarkingAssignments').doc(reviewer.studentId);
const assignmentTitle = ({ subject, grade }) => `Practice marking · ${subject} · ${grade}`;
const topicBreakdownFor = (links) => links.map((item) => ({
  paperId: item.paperId,
  questionReference: item.questionReference,
  pageNumber: item.pageNumber,
  topic: item.topic,
  marks: item.marks,
}));

const buildAssignment = ({ reviewer, cohort, work, links, status = 'preparing' }) => ({
  assignmentId: reviewer.studentId,
  reviewerId: reviewer.studentId,
  reviewerSubjectInstanceId: reviewer.subjectInstanceId,
  reviewerExerciseId: reviewer.id,
  reviewerExercisePath: reviewer.ref.path,
  revieweeId: null,
  revieweeSubjectInstanceId: null,
  exerciseId: reviewer.id,
  exercisePath: reviewer.ref.path,
  assignmentPath: assignmentRefFor(reviewer).path,
  assignmentDate: cohort.assignmentDate,
  subject: cohort.subject,
  grade: cohort.grade,
  topic: links[0]?.topic ?? '',
  topics: [...new Set(links.map((item) => item.topic))],
  matchedTopics: [...new Set(links.map((item) => item.topic))],
  topicMatchType: 'system-generated',
  topicBreakdown: topicBreakdownFor(links),
  questionLinks: links,
  paperIds: [...new Set(links.map((item) => item.paperId))],
  title: assignmentTitle(cohort),
  submittedImageUrl: '',
  submittedImages: [],
  sourceType: 'system_generated',
  systemGenerated: true,
  systemGeneratedWorkId: work.id,
  systemGeneratedWorkPath: work.ref.path,
  status,
  createdAt: FieldValue.serverTimestamp(),
  updatedAt: FieldValue.serverTimestamp(),
});

const urlForStoredImage = (bucket, path, token) => `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}/o/${encodeURIComponent(path)}?alt=media&token=${encodeURIComponent(token)}`;

const copyPackImagesToReviewer = async ({ bucket, pack, links, reviewer }) => {
  const cohortKey = systemPeerWorkCohortKey({ subject: pack.subject, grade: pack.grade });
  const prefix = `${packPath(cohortKey, pack.id)}/`;
  const selectedQuestionIds = new Set(links.map((item) => item.questionId));
  const sourceImages = (pack.images ?? []).filter((image) => selectedQuestionIds.has(image.questionId));
  if (sourceImages.length !== selectedQuestionIds.size) throw new Error('The saved practice work is missing a question image.');
  const basePath = `users/${reviewer.studentId}/subjects/${reviewer.subjectInstanceId}/exercises/${reviewer.id}/system-generated-peer-work`;
  const images = [];
  for (const [index, image] of sourceImages.entries()) {
    if (!String(image.storagePath ?? '').startsWith(prefix)) throw new Error('A saved practice image path failed ownership validation.');
    const fileName = `${pack.id}-q${index + 1}.png`;
    const destinationPath = `${basePath}/${fileName}`;
    const source = bucket.file(image.storagePath);
    const destination = bucket.file(destinationPath);
    const [exists] = await destination.exists();
    if (!exists) await source.copy(destination);
    let [metadata] = await destination.getMetadata();
    let token = metadata.metadata?.firebaseStorageDownloadTokens?.split(',')[0];
    if (!token) {
      token = randomUUID();
      await destination.setMetadata({ metadata: {
        ...(metadata.metadata ?? {}),
        firebaseStorageDownloadTokens: token,
        systemGeneratedPeerWorkId: pack.id,
      }, contentType: 'image/png', cacheControl: 'private,max-age=3600' });
      [metadata] = await destination.getMetadata();
      token = metadata.metadata?.firebaseStorageDownloadTokens?.split(',')[0] || token;
    }
    images.push({
      url: urlForStoredImage(bucket, destinationPath, token),
      storagePath: destinationPath,
      fileName,
      pageNumber: index + 1,
      questionId: image.questionId,
      questionReference: image.questionReference,
      topic: image.topic,
    });
  }
  return images;
};

const markAssignmentFailed = async (assignmentRef, reasonCode) => assignmentRef.firestore.runTransaction(async (transaction) => {
  const snapshot = await transaction.get(assignmentRef);
  if (!snapshot.exists || snapshot.data()?.status !== 'preparing') return false;
  const assignment = snapshot.data();
  transaction.update(assignmentRef, {
    status: 'fallback_failed',
    fallbackErrorCode: String(reasonCode || 'peer_work_unavailable').slice(0, 80),
    updatedAt: FieldValue.serverTimestamp(),
  });
  if (assignment.reviewerExercisePath) {
    transaction.set(assignmentRef.firestore.doc(assignment.reviewerExercisePath), {
      peerMarkingWorkStatus: 'fallback_failed',
      peerMarkingWorkAssignmentId: assignmentRef.id,
      peerMarkingWorkAssignmentPath: assignmentRef.path,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  return true;
});

const publishAssignment = async ({ db, bucket, assignmentRef, assignment, pack }) => {
  const current = await assignmentRef.get();
  if (!current.exists || current.data()?.status !== 'preparing') return false;
  const reviewer = {
    studentId: assignment.reviewerId,
    subjectInstanceId: assignment.reviewerSubjectInstanceId,
    id: assignment.reviewerExerciseId,
  };
  const images = await copyPackImagesToReviewer({
    bucket, pack, links: assignment.questionLinks ?? [], reviewer,
  });
  const firstImage = images[0];
  const updated = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(assignmentRef);
    if (!snapshot.exists || snapshot.data()?.status !== 'preparing') return false;
    transaction.update(assignmentRef, {
      status: 'assigned',
      submittedImages: images,
      submittedImageUrl: firstImage?.url ?? '',
      submittedFileName: firstImage?.fileName ?? '',
      systemGeneratedWorkReadyAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (assignment.reviewerExercisePath) {
      transaction.set(db.doc(assignment.reviewerExercisePath), {
        peerMarkingWorkStatus: 'assigned',
        peerMarkingWorkAssignmentId: assignmentRef.id,
        peerMarkingWorkAssignmentPath: assignmentRef.path,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    transaction.update(pack.ref, { assignmentCount: FieldValue.increment(1), lastAssignedAt: FieldValue.serverTimestamp() });
    return true;
  });
  if (updated) {
    await sendNotificationToUsers({
      userIds: [assignment.reviewerId],
      title: 'Practice work to mark is ready',
      body: `${assignment.subject} practice work is ready for peer marking.`,
      type: 'peer-marking.assigned',
      url: '/student?tab=mark',
      data: { assignmentId: assignmentRef.id, assignmentPath: assignmentRef.path, exerciseId: assignment.reviewerExerciseId },
      tag: `peer-marking-${assignmentRef.id}`,
    });
  }
  return updated;
};

const publishAssignmentWithRetry = (options) => publishPeerWorkWithRetry({
  publish: () => publishAssignment(options),
  maxAttempts: 3,
  retryDelayMs: 250,
  onRetry: (error, attempt) => logger.warn('Retrying generated peer-work publication', {
    workId: options.pack.id,
    assignmentId: options.assignmentRef.id,
    attempt,
    code: safeErrorCode(error),
    errorMessage: safeErrorMessage(error),
  }),
});

const queueSystemPeerWorkForReviewers = async ({ db, cohort, reviewers, excludedPaperIds, excludedQuestionIds, retryNonce = '', forceRegenerate = false }) => {
  const cohortKey = systemPeerWorkCohortKey(cohort);
  const packsRef = workCollection(db, cohortKey);
  const packSnapshot = await packsRef.where('status', 'in', ['ready', 'generating']).get();
  const packs = packSnapshot.docs.map((document) => ({ id: document.id, ref: document.ref, ...document.data() }))
    .filter((pack) => pack.promptVersion === SYSTEM_PEER_WORK_PROMPT_VERSION);
  const topicGroups = new Map();
  reviewers.forEach((reviewer) => {
    const topics = getExerciseTopicNames(reviewer);
    const signature = systemPeerWorkTopicSignature(topics);
    if (!signature || !topics.length) return;
    const group = topicGroups.get(signature) ?? { signature, topics, reviewers: [] };
    group.reviewers.push(reviewer);
    topicGroups.set(signature, group);
  });

  for (const group of topicGroups.values()) {
    const reusable = forceRegenerate ? null : selectReusableSystemPeerWorkWithFallback(packs, {
      subject: cohort.subject, grade: cohort.grade, topics: group.topics, excludedPaperIds,
      excludedQuestionIds,
    });
    if (reusable) {
      const pack = { ...reusable.pack, ref: reusable.pack.ref };
      if (reusable.sourceSelectionMode !== 'unused-paper') {
        logger.info('Reusing saved peer work as a fallback', {
          cohortKey, workId: pack.id, subject: cohort.subject, grade: cohort.grade,
          questionCount: reusable.questionLinks.length,
          sourceSelectionMode: reusable.sourceSelectionMode,
        });
      }
      for (const reviewer of group.reviewers) {
        const assignmentRef = assignmentRefFor(reviewer);
        const assignment = buildAssignment({ reviewer, cohort, work: pack, links: reusable.questionLinks });
        const claimed = await claimPeerMarkingAssignmentSlot({ db, assignmentRef, reviewerId: reviewer.studentId, cohort, assignment });
        if (!claimed) continue;
        try { await publishAssignment({ db, bucket: storage.bucket(), assignmentRef, assignment, pack }); }
        catch (error) {
          await markAssignmentFailed(assignmentRef, safeErrorCode(error));
          logger.warn('Could not publish a reusable system-generated peer task', {
            cohortKey, workId: pack.id, code: safeErrorCode(error),
          });
        }
      }
      continue;
    }

    const exactPending = forceRegenerate ? null : packs.find((pack) => pack.topicSignature === group.signature
      && ['generating', 'ready'].includes(pack.status)
      && !(pack.paperIds ?? [pack.paperId]).some((paperId) => excludedPaperIds.has(String(paperId))));
    if (exactPending?.status === 'ready') {
      for (const reviewer of group.reviewers) {
        const matching = selectReusableSystemPeerWork([exactPending], {
          subject: cohort.subject, grade: cohort.grade, topics: group.topics, excludedPaperIds,
        });
        if (!matching) continue;
        const assignmentRef = assignmentRefFor(reviewer);
        const assignment = buildAssignment({ reviewer, cohort, work: exactPending, links: matching.questionLinks });
        const claimed = await claimPeerMarkingAssignmentSlot({ db, assignmentRef, reviewerId: reviewer.studentId, cohort, assignment });
        if (!claimed) continue;
        try { await publishAssignment({ db, bucket: storage.bucket(), assignmentRef, assignment, pack: exactPending }); }
        catch (error) { await markAssignmentFailed(assignmentRef, safeErrorCode(error)); }
      }
      continue;
    }

    let pending = exactPending;
    if (!pending) {
      const subjectValues = getExerciseGenerationSubjectQueryValues(cohort.subject);
      const subjectQueries = [];
      for (let index = 0; index < subjectValues.length; index += 30) {
        subjectQueries.push(db.collection('questionPapers').where('subject', 'in', subjectValues.slice(index, index + 30)).get());
      }
      const snapshots = await Promise.all(subjectQueries);
      const papersById = new Map();
      snapshots.flatMap((snapshot) => snapshot.docs).forEach((document) => {
        if (!papersById.has(document.id)) papersById.set(document.id, { id: document.id, ...document.data() });
      });
      const matchingPapers = [...papersById.values()].filter((paper) => isAnalyzedExerciseSourcePaper(paper)
          && matchesExerciseGenerationPaper(paper, { subject: cohort.subject, grade: cohort.grade })
          && normalizeExerciseGenerationSubject(paper.subject) === normalizeExerciseGenerationSubject(cohort.subject)
          && normalizeExerciseGenerationGrade(paper.grade) === normalizeExerciseGenerationGrade(cohort.grade));
      const source = selectSystemPeerWorkQuestionsWithFallback({
        papers: matchingPapers,
        subject: cohort.subject,
        grade: cohort.grade,
        topics: group.topics,
        excludedPaperIds,
        excludedQuestionIds,
      });
      if (!source) {
        logger.info('No unused analyzed questions matched an unassigned peer-marking task', {
          cohortKey,
          subject: cohort.subject,
          grade: cohort.grade,
          requestedTopicCount: group.topics.length,
          matchingAnalyzedPaperCount: matchingPapers.length,
          sameDayPaperCount: excludedPaperIds.size,
          sameDayQuestionCount: excludedQuestionIds.size,
        });
        continue;
      }
      if (source.sourceSelectionMode !== 'unused-paper') {
        logger.info('Using a previously assigned question or paper as a peer-work last resort', {
          cohortKey,
          subject: cohort.subject,
          grade: cohort.grade,
          paperId: source.paper.id,
          questionCount: source.questionLinks.length,
          sourceSelectionMode: source.sourceSelectionMode,
        });
      }
      const packId = systemPeerWorkPackId({
        subject: cohort.subject, grade: cohort.grade, topicSignature: group.signature,
        paperId: source.paper.id, questionLinks: source.questionLinks, retryNonce,
      });
      const packRef = packsRef.doc(packId);
      const packData = {
        subject: cohort.subject,
        grade: cohort.grade,
        topicSignature: group.signature,
        requestedTopics: group.topics,
        topics: source.topics,
        paperId: source.paper.id,
        paperIds: [source.paper.id],
        questionLinks: source.questionLinks,
        sourceSelectionMode: source.sourceSelectionMode,
        status: 'generating',
        promptVersion: SYSTEM_PEER_WORK_PROMPT_VERSION,
        assignmentCount: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      const created = await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(packRef);
        if (existing.exists) return { created: false, data: existing.data() };
        transaction.create(packRef, packData);
        return { created: true, data: packData };
      });
      pending = { id: packId, ref: packRef, ...created.data };
    }

    const links = pending.questionLinks ?? [];
    for (const reviewer of group.reviewers) {
      const reviewerTopics = new Set(group.topics.map(normalizeExerciseTopicKey));
      const assignedLinks = links.filter((link) => reviewerTopics.has(normalizeExerciseTopicKey(link.topic)));
      if (!assignedLinks.length) continue;
      const assignmentRef = assignmentRefFor(reviewer);
      const assignment = buildAssignment({ reviewer, cohort, work: pending, links: assignedLinks });
      await claimPeerMarkingAssignmentSlot({ db, assignmentRef, reviewerId: reviewer.studentId, cohort, assignment });
    }
    if (pending.status === 'generating') {
      try {
        await enqueueTaskOnce(GENERATION_TASK, { packPath: pending.ref.path }, {
          id: stableTaskId('system-peer-work', pending.ref.path),
        });
      } catch (error) {
        await pending.ref.set({ status: 'failed', errorCode: safeErrorCode(error), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        await markPendingAssignmentsFailed({ db, packId: pending.id, reasonCode: safeErrorCode(error) });
        throw error;
      }
    }
    if (pending.status === 'failed') {
      await markPendingAssignmentsFailed({ db, packId: pending.id, reasonCode: 'peer_work_generation_failed' });
    }
  }
};

const renderSolutionPng = ({ subject, grade, question, solutionText }) => {
  const width = 1200;
  const canvas = createCanvas(width, 800);
  const context = canvas.getContext('2d');
  context.font = '28px Arial';
  const lines = wrapPeerWorkText(context, solutionText, width - 112);
  const height = Math.min(SAFE_IMAGE_DIMENSION, Math.max(820, 420 + lines.length * 42));
  const output = createCanvas(width, height);
  const ctx = output.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#10213a';
  ctx.fillRect(0, 0, width, 180);
  ctx.fillStyle = '#a3e635';
  ctx.font = 'bold 24px Arial';
  ctx.fillText('PRACTICE MARKING · SYSTEM-GENERATED', 56, 58);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px Arial';
  ctx.fillText(`${subject} · ${grade}`, 56, 112, width - 112);
  ctx.font = 'bold 30px Arial';
  ctx.fillStyle = '#10213a';
  ctx.fillText(`Question ${question.questionReference}`, 56, 238);
  ctx.font = '25px Arial';
  ctx.fillStyle = '#334155';
  ctx.fillText(`Topic: ${question.topic}    Maximum: ${question.marks} marks`, 56, 286, width - 112);
  ctx.strokeStyle = '#dbe3ed';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(56, 320); ctx.lineTo(width - 56, 320); ctx.stroke();
  ctx.font = 'bold 24px Arial';
  ctx.fillStyle = '#64748b';
  ctx.fillText('WORKED ANSWER', 56, 356);
  ctx.font = '28px Arial';
  ctx.fillStyle = '#111827';
  lines.forEach((line, index) => ctx.fillText(line, 56, 398 + index * 42));
  ctx.fillStyle = '#64748b';
  ctx.font = '20px Arial';
  ctx.fillText('Generated practice answer · Review the working and award marks for the assigned question.', 56, height - 44);
  return output.toBuffer('image/png');
};

const savePrivateGeneratedImage = async ({ file, buffer }) => {
  await file.save(buffer, { resumable: false, contentType: 'image/png', metadata: { cacheControl: 'private,max-age=3600' } });
};

const markPendingAssignmentsFailed = async ({ db, packId, reasonCode }) => {
  const waiting = await db.collectionGroup('peerMarkingAssignments').where('systemGeneratedWorkId', '==', packId).get();
  await Promise.all(waiting.docs.filter((document) => document.data().status === 'preparing')
    .map((document) => markAssignmentFailed(document.ref, reasonCode)));
};

const requestedQuestionsForPack = (links) => links.map((question) => ({
  questionId: question.questionId || questionIdentity(question.paperId, question.questionReference),
  paperId: question.paperId,
  questionNumber: question.questionReference,
}));

export const generateSystemPeerWorkTask = onTaskDispatched(GENERATION_OPTIONS, async (request) => {
  const documentPath = String(request.data?.packPath ?? '');
  if (!/^systemGeneratedPeerWork\/[a-f0-9]{40}\/packs\/[a-f0-9]{40}$/.test(documentPath)) {
    throw new Error('The system-generated peer-work task path is invalid.');
  }
  const db = getDb();
  const bucket = storage.bucket();
  const packRef = db.doc(documentPath);
  const packSnapshot = await packRef.get();
  if (!packSnapshot.exists) return;
  const pack = { id: packSnapshot.id, ref: packRef, ...packSnapshot.data() };
  if (pack.status === 'ready') {
    const waiting = await db.collectionGroup('peerMarkingAssignments').where('systemGeneratedWorkId', '==', pack.id).get();
    for (const document of waiting.docs.filter((item) => item.data().status === 'preparing')) {
      try { await publishAssignmentWithRetry({ db, bucket, assignmentRef: document.ref, assignment: document.data(), pack }); }
      catch (error) {
        await markAssignmentFailed(document.ref, safeErrorCode(error));
        logger.warn('Could not publish generated peer-marking work', {
          workId: pack.id,
          assignmentId: document.id,
          code: safeErrorCode(error),
          errorMessage: safeErrorMessage(error),
        });
      }
    }
    return;
  }
  if (pack.status !== 'generating') return;

  let failureStage = 'load_source_paper_record';
  try {
    const paperSnapshot = await db.doc(`questionPapers/${pack.paperId}`).get();
    if (!paperSnapshot.exists) throw new Error('The selected source paper is unavailable.');
    const paper = { id: paperSnapshot.id, ...paperSnapshot.data() };
    failureStage = 'validate_requested_questions';
    const requestedQuestions = requestedQuestionsForPack(pack.questionLinks ?? []);
    if (!requestedQuestions.length || requestedQuestions.length > 12) throw new Error('The generated practice task contains an invalid question count.');
    failureStage = 'download_source_pdf';
    const sourcePdf = await loadSystemPeerWorkSourcePdf({ paper, bucket });
    failureStage = 'ai_solution_request';
    const generated = await solveSystemPeerWork({
      questions: requestedQuestions,
      sourcePdf,
    });
    failureStage = 'render_and_upload_solution_images';
    const imageRows = [];
    for (const question of requestedQuestions) {
      const solution = generated.solutions.find((item) => item.questionId === question.questionId);
      if (!solution) throw new Error('A selected question solution was missing.');
      const imageBuffer = renderSolutionPng({ subject: pack.subject, grade: pack.grade,
        question: pack.questionLinks.find((item) => item.questionId === question.questionId), solutionText: solution.solutionText });
      const storagePath = `${documentPath}/question-${imageRows.length + 1}.png`;
      await savePrivateGeneratedImage({ file: bucket.file(storagePath), buffer: imageBuffer });
      imageRows.push({ storagePath, pageNumber: imageRows.length + 1,
        questionId: question.questionId, questionReference: question.questionNumber,
        topic: question.topic, sizeBytes: imageBuffer.length });
    }
    failureStage = 'save_generated_work_record';
    await packRef.set({
      status: 'ready',
      images: imageRows,
      sourceMaterialType: 'pdf',
      sourcePdfFileName: sourcePdf.fileName,
      sourcePdfSizeBytes: sourcePdf.sizeBytes,
      model: String(generated.model || ''),
      provider: String(generated.provider || ''),
      fallbackUsed: generated.fallbackUsed === true,
      fallbackReasonCode: String(generated.fallbackReasonCode || ''),
      usage: generated.usage ?? {},
      requestDurationMs: Number(generated.requestDurationMs) || 0,
      generatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    logger.info('System-generated peer work created', {
      workId: pack.id,
      subject: pack.subject,
      grade: pack.grade,
      questionCount: requestedQuestions.length,
      sourceMaterialType: 'pdf',
      sourcePdfSizeBytes: sourcePdf.sizeBytes,
      model: String(generated.model || ''),
      provider: String(generated.provider || ''),
      fallbackUsed: generated.fallbackUsed === true,
      inputTokens: Number(generated.usage?.inputTokens) || 0,
      outputTokens: Number(generated.usage?.outputTokens) || 0,
      requestDurationMs: Number(generated.requestDurationMs) || 0,
    });
    failureStage = 'load_assignments_for_publication';
    const waiting = await db.collectionGroup('peerMarkingAssignments').where('systemGeneratedWorkId', '==', pack.id).get();
    failureStage = 'publish_generated_work';
    for (const document of waiting.docs.filter((item) => item.data().status === 'preparing')) {
      try { await publishAssignmentWithRetry({ db, bucket, assignmentRef: document.ref, assignment: document.data(), pack }); }
      catch (error) {
        await markAssignmentFailed(document.ref, safeErrorCode(error));
        logger.warn('Could not publish generated peer-marking work', {
          workId: pack.id,
          assignmentId: document.id,
          code: safeErrorCode(error),
          errorMessage: safeErrorMessage(error),
        });
      }
    }
  } catch (error) {
    logger.error('System-generated peer-work task failed', {
      workId: pack.id,
      subject: pack.subject,
      grade: pack.grade,
      failureStage,
      code: safeErrorCode(error),
      errorMessage: safeErrorMessage(error),
    });
    await packRef.set({ status: 'failed', errorCode: safeErrorCode(error), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await markPendingAssignmentsFailed({ db, packId: pack.id, reasonCode: safeErrorCode(error) });
  }
});

export const assignFallbackPeerWork = async ({
  db, cohort, reviewers, excludedPaperIds = new Set(), excludedQuestionIds = new Set(), retryNonce = '', forceRegenerate = false,
}) => {
  try {
    await queueSystemPeerWorkForReviewers({ db, cohort, reviewers, excludedPaperIds, excludedQuestionIds, retryNonce, forceRegenerate });
  } catch (error) {
    logger.error('Could not queue system-generated peer-marking fallback', {
      cohortKey: systemPeerWorkCohortKey(cohort),
      subject: cohort.subject,
      grade: cohort.grade,
      code: safeErrorCode(error),
    });
  }
};
