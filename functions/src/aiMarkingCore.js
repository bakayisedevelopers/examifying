import { createHash } from 'node:crypto';

export const AI_MARKING_STATUSES = Object.freeze([
  'pending', 'processing', 'completed', 'partially_completed', 'incorrect_submission', 'unclear_images', 'failed', 'skipped',
]);

export const normalizeQuestionReference = (value) => String(value ?? '')
  .trim()
  .toLocaleLowerCase()
  .replace(/\s+/g, '');

export const questionIdentity = (paperId, questionNumber) => `${String(paperId ?? '').trim()}::${normalizeQuestionReference(questionNumber)}`;

export const submissionVersion = (items = []) => createHash('sha256')
  .update(JSON.stringify(items.map((item) => ({ url: String(item?.url ?? ''), pageNumber: Number(item?.pageNumber) || 0 }))))
  .digest('hex')
  .slice(0, 40);

export const submissionVersionForRecord = (record = {}, images = []) => submissionVersion([
  ...images.map((image) => ({ url: image.url, pageNumber: image.pageNumber })),
  { url: String(record?.submittedAt?.toMillis?.() ?? record?.completedAt?.toMillis?.() ?? ''), pageNumber: 0 },
  ...(record?.submissionVersion == null ? [] : [{ url: String(record.submissionVersion), pageNumber: -1 }]),
  ...(Number(record?.aiMarking?.retrySequence) > 0
    ? [{ url: `manual-retry:${Number(record.aiMarking.retrySequence)}`, pageNumber: -2 }]
    : []),
]);

export const aiMarkingTaskId = ({ submissionType, submissionId, version }) => `ai-mark-${createHash('sha256')
  .update(`${submissionType}:${submissionId}:${version}`)
  .digest('hex')
  .slice(0, 40)}`;

const questionCandidates = (source = {}) => {
  const links = Array.isArray(source.questionLinks) ? source.questionLinks : [];
  if (links.length) return links;
  const questions = Array.isArray(source.questions) ? source.questions : [];
  if (questions.length) return questions;
  const breakdown = Array.isArray(source.topicBreakdown) ? source.topicBreakdown : [];
  if (breakdown.length) return breakdown;
  return [];
};

export const getRequestedMarkingQuestions = (source = {}) => {
  const singlePaperId = Array.isArray(source.paperIds) && source.paperIds.length === 1
    ? String(source.paperIds[0] ?? '').trim() : '';
  const unique = new Map();
  for (const question of questionCandidates(source)) {
    const paperId = String(question?.paperId ?? singlePaperId).trim();
    const questionNumber = String(question?.questionReference ?? question?.reference ?? question?.questionNumber ?? '').trim();
    const maximumMark = Number(question?.marks ?? question?.maximumMark ?? question?.totalMarks);
    const topic = String(question?.topic ?? '').trim();
    const key = questionIdentity(paperId, questionNumber);
    if (!paperId || !normalizeQuestionReference(questionNumber) || !topic || !Number.isFinite(maximumMark) || maximumMark <= 0) {
      throw new Error('Exercise question metadata is incomplete for AI marking. Manual marking remains available.');
    }
    if (unique.has(key)) {
      const prior = unique.get(key);
      if (prior.topic !== topic || prior.maximumMark !== maximumMark) {
        throw new Error(`Question ${questionNumber} has conflicting exercise metadata.`);
      }
      continue;
    }
    unique.set(key, {
      questionId: key,
      paperId,
      questionNumber,
      topic,
      topicId: String(question?.topicId ?? question?.canonicalTopicKey ?? '').trim(),
      maximumMark,
      pageNumber: Number(question?.pageNumber ?? question?.page) || 0,
    });
  }
  if (!unique.size) throw new Error('This submission has no indexed exercise questions for AI marking.');
  return [...unique.values()];
};

const storedQuestionKey = (question) => questionIdentity(
  question?.paperId,
  question?.questionReference ?? question?.questionNumber ?? question?.number,
);

export const resolvePaperPageContext = ({ requestedQuestions = [], analysesByPaper = {} }) => {
  const parentGroups = new Map();
  const questionContexts = new Map();
  const fallbackQuestionIds = new Set();
  for (const requested of requestedQuestions) {
    const paperQuestions = analysesByPaper[requested.paperId];
    if (!Array.isArray(paperQuestions)) {
      questionContexts.set(requested.questionId, { questionId: requested.questionId, paperId: requested.paperId, parentQuestion: '', pageNumbers: [] });
      fallbackQuestionIds.add(requested.questionId);
      continue;
    }
    const question = paperQuestions.find((item) => storedQuestionKey({ ...item, paperId: requested.paperId }) === requested.questionId);
    if (!question) {
      questionContexts.set(requested.questionId, { questionId: requested.questionId, paperId: requested.paperId, parentQuestion: '', pageNumbers: [] });
      fallbackQuestionIds.add(requested.questionId);
      continue;
    }
    const parentQuestion = String(question.parentQuestion ?? '').trim();
    if (!parentQuestion) {
      questionContexts.set(requested.questionId, { questionId: requested.questionId, paperId: requested.paperId, parentQuestion: '', pageNumbers: [] });
      fallbackQuestionIds.add(requested.questionId);
      continue;
    }
    const groupKey = `${requested.paperId}::${normalizeQuestionReference(parentQuestion)}`;
    const group = parentGroups.get(groupKey) ?? { paperId: requested.paperId, parentQuestion, pageNumbers: new Set(), questionIds: new Set() };
    group.questionIds.add(requested.questionId);
    for (const sibling of paperQuestions) {
      if (normalizeQuestionReference(sibling?.parentQuestion) !== normalizeQuestionReference(parentQuestion)) continue;
      const pageNumber = Number(sibling?.pageNumber ?? sibling?.page);
      if (Number.isInteger(pageNumber) && pageNumber > 0) group.pageNumbers.add(pageNumber);
    }
    if (!group.pageNumbers.size) fallbackQuestionIds.add(requested.questionId);
    parentGroups.set(groupKey, group);
  }

  const pagesByPaper = new Map();
  for (const group of parentGroups.values()) {
    const pageNumbers = [...group.pageNumbers].sort((left, right) => left - right);
    group.questionIds.forEach((questionId) => questionContexts.set(questionId, {
      questionId, paperId: group.paperId, parentQuestion: group.parentQuestion, pageNumbers,
    }));
    const pages = pagesByPaper.get(group.paperId) ?? new Set();
    group.pageNumbers.forEach((pageNumber) => pages.add(pageNumber));
    pagesByPaper.set(group.paperId, pages);
  }
  return {
    parentGroups: [...parentGroups.values()].map((group) => ({
      paperId: group.paperId,
      parentQuestion: group.parentQuestion,
      questionIds: [...group.questionIds],
      pageNumbers: [...group.pageNumbers].sort((left, right) => left - right),
    })),
    questionContexts: [...questionContexts.values()],
    fallbackQuestionIds: [...fallbackQuestionIds],
    pages: [...pagesByPaper.entries()].flatMap(([paperId, pageNumbers]) => [...pageNumbers]
      .sort((left, right) => left - right).map((pageNumber) => ({ paperId, pageNumber })))
      .sort((left, right) => left.paperId.localeCompare(right.paperId) || left.pageNumber - right.pageNumber),
  };
};

export const buildCompactQuestionContext = (questions = []) => questions.map(({ questionId, paperId, questionNumber, topic, maximumMark }) => ({
  questionId, paperId, questionNumber, topic, maximumMark,
}));

export const validateAiMarkingResponse = ({ response, requestedQuestions = [], suppliedMaterialsByQuestion = {} }) => {
  const supportedStatuses = ['completed', 'partially_completed', 'incorrect_submission', 'unclear_images', 'full_paper_search', 'memo_search'];
  if (!response || typeof response !== 'object' || !supportedStatuses.includes(response.status)) {
    throw new Error('The AI marking response used an unsupported status.');
  }
  const results = response.results;
  if (!Array.isArray(results)) throw new Error('The AI marking response did not include a results list.');
  const contextRequests = Array.isArray(response.contextRequests) ? response.contextRequests : [];
  const unansweredQuestionIds = Array.isArray(response.unansweredQuestionIds) ? response.unansweredQuestionIds : [];
  if (response.status !== 'completed') {
    if (['incorrect_submission', 'unclear_images'].includes(response.status)) {
      if (results.length || contextRequests.length || unansweredQuestionIds.length) throw new Error('A non-completed AI response contained question results.');
      return {
        status: response.status,
        results: [],
        contextRequests: [],
        unansweredQuestionIds: [],
        message: response.status === 'incorrect_submission'
          ? 'The uploaded images do not appear to match this exercise.'
          : 'We could not read the uploaded work clearly. Please upload clear images and submit again.',
      };
    }
  }

  const allowed = new Map(requestedQuestions.map((question) => [question.questionId, question]));
  if (!allowed.size) throw new Error('The AI marking request did not include any exercise questions.');
  const seen = new Set();
  const normalizedResults = results.map((result) => {
    const questionId = String(result?.questionId ?? '').trim();
    const requested = allowed.get(questionId);
    if (!requested) throw new Error('The AI marking response included an unknown exercise question.');
    if (seen.has(questionId)) throw new Error('The AI marking response duplicated an exercise question.');
    seen.add(questionId);
    const paperId = result?.paperId == null ? requested.paperId : String(result.paperId).trim();
    const questionNumber = result?.questionNumber == null ? requested.questionNumber : String(result.questionNumber).trim();
    if (paperId !== requested.paperId || normalizeQuestionReference(questionNumber) !== normalizeQuestionReference(requested.questionNumber)) {
      throw new Error(`The AI marking response identified question ${requested.questionNumber} incorrectly.`);
    }
    const awardedMark = Number(result?.awardedMark);
    if (!Number.isFinite(awardedMark) || awardedMark < 0 || awardedMark > requested.maximumMark) {
      throw new Error(`The AI marking response gave question ${requested.questionNumber} an invalid mark.`);
    }
    return {
      ...requested,
      earnedMarks: awardedMark,
      totalMarks: requested.maximumMark,
    };
  });

  const normalizedRequests = [];
  const requestKeys = new Set();
  const requestedQuestionIds = new Set();
  const unanswered = new Set();
  for (const questionIdValue of unansweredQuestionIds) {
    const questionId = String(questionIdValue ?? '').trim();
    if (!allowed.has(questionId)) throw new Error('The AI marking response identified an unknown unanswered exercise question.');
    if (seen.has(questionId) || unanswered.has(questionId)) {
      throw new Error('The AI marking response identified an exercise question more than once.');
    }
    unanswered.add(questionId);
  }
  for (const request of contextRequests) {
    const questionId = String(request?.questionId ?? '').trim();
    if (!allowed.has(questionId)) throw new Error('The AI marking response requested context for an unknown exercise question.');
    if (!['full_paper', 'memo'].includes(request?.material)) throw new Error('The AI marking response requested unsupported source material.');
    if (request.material === 'memo' && !(suppliedMaterialsByQuestion[questionId] ?? []).includes('full_paper')) {
      throw new Error('The AI marking response requested a memo before the full question paper was supplied.');
    }
    if (seen.has(questionId) || unanswered.has(questionId)) throw new Error('The AI marking response both resolved and requested context for the same question.');
    if (requestedQuestionIds.has(questionId)) throw new Error('The AI marking response requested multiple source types for the same question.');
    if ((suppliedMaterialsByQuestion[questionId] ?? []).includes(request.material)) {
      throw new Error('The AI marking response requested source material that was already supplied.');
    }
    const key = `${questionId}::${request.material}`;
    if (requestKeys.has(key)) throw new Error('The AI marking response duplicated a source-context request.');
    requestKeys.add(key);
    requestedQuestionIds.add(questionId);
    normalizedRequests.push({ questionId, paperId: allowed.get(questionId).paperId, material: request.material });
  }

  if (response.status === 'completed') {
    if (normalizedResults.length !== allowed.size || normalizedRequests.length || unanswered.size) {
      throw new Error('The AI marking response did not score every requested question.');
    }
    return { status: 'completed', results: normalizedResults, contextRequests: [], unansweredQuestionIds: [], message: '' };
  }

  if (response.status === 'partially_completed') {
    if (!unanswered.size || normalizedRequests.length) {
      throw new Error('A partially completed response must identify unanswered questions and no context requests.');
    }
    const resolvedIds = new Set([...seen, ...unanswered]);
    if (resolvedIds.size !== allowed.size) throw new Error('The AI marking response did not account for every requested question.');
    return { status: 'partially_completed', results: normalizedResults, contextRequests: [], unansweredQuestionIds: [...unanswered], message: '' };
  }

  if (!normalizedRequests.length) throw new Error('The AI marking response requested more context without identifying any questions.');
  const resolvedIds = new Set([...seen, ...normalizedRequests.map((request) => request.questionId), ...unanswered]);
  if (resolvedIds.size !== allowed.size) throw new Error('The AI marking response neither scored nor requested context for every question.');
  if (response.status === 'full_paper_search' && !normalizedRequests.some((request) => request.material === 'full_paper')) {
    throw new Error('The full-paper search response did not request any full papers.');
  }
  if (response.status === 'memo_search' && !normalizedRequests.some((request) => request.material === 'memo')) {
    throw new Error('The memo search response did not request any memos.');
  }
  return {
    status: response.status,
    results: normalizedResults,
    contextRequests: normalizedRequests,
    unansweredQuestionIds: [...unanswered],
    message: '',
  };
};

export const mergeAiMarkingResults = (priorResults = [], newResults = []) => {
  const byQuestionId = new Map();
  for (const result of [...priorResults, ...newResults]) {
    const previous = byQuestionId.get(result.questionId);
    if (previous && (previous.earnedMarks !== result.earnedMarks || previous.totalMarks !== result.totalMarks)) {
      throw new Error('The AI marking passes returned conflicting marks for an exercise question.');
    }
    if (!previous) byQuestionId.set(result.questionId, result);
  }
  return [...byQuestionId.values()];
};

export const getPendingMarkingQuestions = (requestedQuestions = [], results = []) => {
  const completedIds = new Set(results.map((result) => result.questionId));
  return requestedQuestions.filter((question) => !completedIds.has(question.questionId));
};

export const excludeScoredMarkingQuestions = (requestedQuestions = [], scoreRecords = []) => {
  const alreadyScored = new Set(scoreRecords
    .filter((record) => record?.sourceType === 'Exercise'
      && String(record?.paperId ?? '').trim()
      && String(record?.questionReference ?? '').trim())
    .map((record) => questionIdentity(record.paperId, record.questionReference)));
  return requestedQuestions.filter((question) => !alreadyScored.has(question.questionId));
};

export const groupAiContextRequestsByPaper = (contextRequests = []) => {
  const grouped = new Map();
  for (const request of contextRequests) {
    const entry = grouped.get(request.paperId) ?? { paperId: request.paperId, materialsByQuestion: new Map() };
    const materials = entry.materialsByQuestion.get(request.questionId) ?? new Set();
    materials.add(request.material);
    entry.materialsByQuestion.set(request.questionId, materials);
    grouped.set(request.paperId, entry);
  }
  return [...grouped.values()].map((entry) => ({
    paperId: entry.paperId,
    materialsByQuestion: Object.fromEntries([...entry.materialsByQuestion].map(([questionId, materials]) => [questionId, [...materials]])),
    materials: [...new Set([...entry.materialsByQuestion.values()].flatMap((materials) => [...materials]))],
  }));
};

export const tutorAiMarkingEnabled = (profile = {}) => profile?.settings?.aiMarkingEnabled !== false;

export const runAiMarkingOnce = async ({ enabled = true, request, callModel, applyCompleted }) => {
  if (!enabled) return { status: 'skipped', results: [] };
  const rawResponse = await callModel(request);
  const validated = validateAiMarkingResponse({ response: rawResponse, requestedQuestions: request.questions });
  if (validated.status === 'completed') await applyCompleted(validated.results);
  return validated;
};

export const submissionIsCurrent = ({ currentVersion, requestedVersion }) => Boolean(currentVersion)
  && currentVersion === requestedVersion;

export const shouldPreserveAuthoritativeMark = (incomingMarkSource, existingMarkSource) =>
  incomingMarkSource === 'ai' && existingMarkSource !== 'ai';
