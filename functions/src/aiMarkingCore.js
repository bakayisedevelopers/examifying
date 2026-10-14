import { createHash } from 'node:crypto';

export const AI_MARKING_STATUSES = Object.freeze([
  'pending', 'processing', 'completed', 'incorrect_submission', 'unclear_images', 'failed', 'skipped',
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
  for (const requested of requestedQuestions) {
    const paperQuestions = analysesByPaper[requested.paperId];
    if (!Array.isArray(paperQuestions)) throw new Error(`Analysis data for paper ${requested.paperId} is unavailable.`);
    const question = paperQuestions.find((item) => storedQuestionKey({ ...item, paperId: requested.paperId }) === requested.questionId);
    if (!question) throw new Error(`Question ${requested.questionNumber} was not found in the analysis for paper ${requested.paperId}.`);
    const parentQuestion = String(question.parentQuestion ?? '').trim();
    if (!parentQuestion) throw new Error(`Parent question for ${requested.questionNumber} is missing from its analysis record.`);
    const groupKey = `${requested.paperId}::${normalizeQuestionReference(parentQuestion)}`;
    const group = parentGroups.get(groupKey) ?? { paperId: requested.paperId, parentQuestion, pageNumbers: new Set() };
    for (const sibling of paperQuestions) {
      if (String(sibling?.parentQuestion ?? '').trim() !== parentQuestion) continue;
      const pageNumber = Number(sibling?.pageNumber ?? sibling?.page);
      if (Number.isInteger(pageNumber) && pageNumber > 0) group.pageNumbers.add(pageNumber);
    }
    if (!group.pageNumbers.size) {
      const pageNumber = Number(question.pageNumber ?? question.page ?? requested.pageNumber);
      if (Number.isInteger(pageNumber) && pageNumber > 0) group.pageNumbers.add(pageNumber);
    }
    if (!group.pageNumbers.size) throw new Error(`Source pages for ${requested.questionNumber} are missing from its analysis record.`);
    parentGroups.set(groupKey, group);
  }

  const pagesByPaper = new Map();
  for (const group of parentGroups.values()) {
    const pages = pagesByPaper.get(group.paperId) ?? new Set();
    group.pageNumbers.forEach((pageNumber) => pages.add(pageNumber));
    pagesByPaper.set(group.paperId, pages);
  }
  return {
    parentGroups: [...parentGroups.values()].map((group) => ({
      paperId: group.paperId,
      parentQuestion: group.parentQuestion,
      pageNumbers: [...group.pageNumbers].sort((left, right) => left - right),
    })),
    pages: [...pagesByPaper.entries()].flatMap(([paperId, pageNumbers]) => [...pageNumbers]
      .sort((left, right) => left - right).map((pageNumber) => ({ paperId, pageNumber })))
      .sort((left, right) => left.paperId.localeCompare(right.paperId) || left.pageNumber - right.pageNumber),
  };
};

export const buildCompactQuestionContext = (questions = []) => questions.map(({ questionId, paperId, questionNumber, topic, maximumMark }) => ({
  questionId, paperId, questionNumber, topic, maximumMark,
}));

export const validateAiMarkingResponse = ({ response, requestedQuestions = [] }) => {
  if (!response || typeof response !== 'object' || !AI_MARKING_STATUSES.slice(2, 5).includes(response.status)) {
    throw new Error('The AI marking response used an unsupported status.');
  }
  const results = response.results;
  if (!Array.isArray(results)) throw new Error('The AI marking response did not include a results list.');
  if (response.status !== 'completed') {
    if (results.length) throw new Error('A non-completed AI response contained marks.');
    return {
      status: response.status,
      results: [],
      message: response.status === 'incorrect_submission'
        ? 'The uploaded images do not appear to match this exercise.'
        : 'We could not read the uploaded work clearly. Please upload clear images and submit again.',
    };
  }

  const allowed = new Map(requestedQuestions.map((question) => [question.questionId, question]));
  if (results.length !== allowed.size) throw new Error('The AI marking response did not score every requested question.');
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
  return { status: 'completed', results: normalizedResults, message: '' };
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
