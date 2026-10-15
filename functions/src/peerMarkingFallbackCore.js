import { createHash } from 'node:crypto';
import {
  isAnalyzedExerciseSourcePaper,
  matchesExerciseGenerationPaper,
  normalizeExerciseGenerationGrade,
  normalizeExerciseGenerationSubject,
} from './exerciseGenerationPaperMatching.js';
import { normalizeExerciseTopicKey } from './peerMarkingAllocation.js';
import { questionIdentity } from './aiMarkingCore.js';
import { exerciseGenerationTopicLabelsMatch } from './exerciseGenerationTopicMatching.js';

export const SYSTEM_PEER_WORK_PROMPT_VERSION = 'v2';

const hash = (value) => createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 40);
const uniqueTopics = (topics = []) => [...new Map(topics.map((topic) => String(topic ?? '').trim())
  .filter(Boolean).map((topic) => [normalizeExerciseTopicKey(topic), topic])).values()];
const questionTopics = (question = {}) => uniqueTopics([
  ...(Array.isArray(question.topics) ? question.topics : []),
  question.topic,
]);
const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

export const systemPeerWorkCohortKey = ({ subject, grade }) => hash(
  `${normalizeExerciseGenerationSubject(subject)}::${normalizeExerciseGenerationGrade(grade)}`,
);

export const peerMarkingAllocationLockId = ({ assignmentDate, subject, grade, reviewerId }) => hash([
  String(assignmentDate ?? ''),
  normalizeExerciseGenerationSubject(subject),
  normalizeExerciseGenerationGrade(grade),
  String(reviewerId ?? ''),
].join('::'));

export const systemPeerWorkTopicSignature = (topics = []) => hash(
  uniqueTopics(topics).map(normalizeExerciseTopicKey).sort().join('|'),
);

export const systemPeerWorkPackId = ({ subject, grade, topicSignature, paperId, questionLinks = [], retryNonce = '' }) => hash([
  SYSTEM_PEER_WORK_PROMPT_VERSION,
  normalizeExerciseGenerationSubject(subject),
  normalizeExerciseGenerationGrade(grade),
  topicSignature,
  String(paperId ?? ''),
  ...(retryNonce ? [String(retryNonce)] : []),
  ...questionLinks.map((item) => `${item.paperId}::${item.questionReference}`).sort(),
].join('::'));

export const selectReusableSystemPeerWork = (packs = [], {
  subject,
  grade,
  topics = [],
  excludedPaperIds = new Set(),
  excludedQuestionIds = new Set(),
} = {}) => {
  const requestedTopics = uniqueTopics(topics);
  const requestedKeys = new Set(requestedTopics.map(normalizeExerciseTopicKey));
  if (!requestedKeys.size) return null;
  const expectedSubject = normalizeExerciseGenerationSubject(subject);
  const expectedGrade = normalizeExerciseGenerationGrade(grade);
  const eligible = packs.filter((pack) => pack?.status === 'ready'
    && normalizeExerciseGenerationSubject(pack.subject) === expectedSubject
    && normalizeExerciseGenerationGrade(pack.grade) === expectedGrade
    && Array.isArray(pack.questionLinks) && pack.questionLinks.length
    && Array.isArray(pack.images) && pack.images.length
    && !(pack.paperIds ?? [pack.paperId]).some((paperId) => excludedPaperIds.has(String(paperId))));
  const ranked = eligible.map((pack) => {
    const questionLinks = pack.questionLinks.filter((item) => {
      const matchingTopic = requestedTopics.find((topic) => exerciseGenerationTopicLabelsMatch(item.topic, topic));
      const identity = questionIdentity(item.paperId ?? pack.paperId, item.questionReference ?? item.questionNumber);
      return Boolean(matchingTopic) && !excludedQuestionIds.has(identity);
    });
    const matchingTopicKeys = new Set(questionLinks.flatMap((item) => {
      const matchingTopic = requestedTopics.find((topic) => exerciseGenerationTopicLabelsMatch(item.topic, topic));
      return matchingTopic ? [normalizeExerciseTopicKey(matchingTopic)] : [];
    }));
    return { pack, questionLinks, matchingTopicKeys };
  }).filter((entry) => entry.matchingTopicKeys.size)
    .sort((left, right) => right.matchingTopicKeys.size - left.matchingTopicKeys.size
      || (Number(left.pack.assignmentCount) || 0) - (Number(right.pack.assignmentCount) || 0)
      || String(left.pack.id ?? '').localeCompare(String(right.pack.id ?? '')));
  if (!ranked.length) return null;
  const { pack, questionLinks, matchingTopicKeys } = ranked[0];
  return {
    pack,
    questionLinks,
    topics: uniqueTopics(questionLinks.map((item) => item.topic)),
    matchedTopicCount: matchingTopicKeys.size,
  };
};

export const selectReusableSystemPeerWorkWithFallback = (packs = [], options = {}) => {
  const preferred = selectReusableSystemPeerWork(packs, options);
  if (preferred) return { ...preferred, sourceSelectionMode: 'unused-paper' };

  const sameDayPaperFallback = selectReusableSystemPeerWork(packs, {
    ...options,
    excludedPaperIds: new Set(),
  });
  if (sameDayPaperFallback) return { ...sameDayPaperFallback, sourceSelectionMode: 'same-day-paper-last-resort' };

  const usedQuestionFallback = selectReusableSystemPeerWork(packs, {
    ...options,
    excludedPaperIds: new Set(),
    excludedQuestionIds: new Set(),
  });
  return usedQuestionFallback
    ? { ...usedQuestionFallback, sourceSelectionMode: 'used-question-last-resort' }
    : null;
};

export const selectSystemPeerWorkQuestions = ({
  papers = [],
  subject,
  grade,
  topics = [],
  excludedPaperIds = new Set(),
  excludedQuestionIds = new Set(),
} = {}) => {
  const requestedTopics = uniqueTopics(topics);
  const requestedByKey = new Map(requestedTopics.map((topic) => [normalizeExerciseTopicKey(topic), topic]));
  if (!requestedByKey.size) return null;
  const expectedGrade = normalizeExerciseGenerationGrade(grade);
  const candidates = papers.filter((paper) => isAnalyzedExerciseSourcePaper(paper)
    && matchesExerciseGenerationPaper(paper, { subject, grade })
    && normalizeExerciseGenerationGrade(paper.grade) === expectedGrade
    && !excludedPaperIds.has(String(paper.id)));
  const ranked = candidates.map((paper) => {
    const questions = (paper.questions ?? []).map((question) => ({ ...question,
      questionReference: String(question.questionReference ?? question.questionNumber ?? question.number ?? '').trim(),
      pageNumber: Number(question.pageNumber ?? question.page) || 0,
      marks: Number(question.marks ?? question.totalMarks ?? question.maximumMark) || 0,
    })).filter((question) => question.questionReference && question.pageNumber > 0 && question.marks > 0)
      .sort((left, right) => left.pageNumber - right.pageNumber
        || naturalCompare(left.questionReference, right.questionReference));
    const selectedByTopic = new Map();
    const selectedQuestionIds = new Set();
    questions.forEach((question) => {
      for (const label of questionTopics(question)) {
        const requestedTopic = requestedTopics.find((topic) => exerciseGenerationTopicLabelsMatch(label, topic));
        if (!requestedTopic) continue;
        const key = normalizeExerciseTopicKey(requestedTopic);
        const questionId = questionIdentity(paper.id, question.questionReference);
        if (!requestedByKey.has(key) || excludedQuestionIds.has(questionId)
          || selectedByTopic.has(key) || selectedQuestionIds.has(questionId)) continue;
        selectedByTopic.set(key, { question, topic: requestedByKey.get(key) });
        selectedQuestionIds.add(questionId);
        break;
      }
    });
    const questionLinks = [...selectedByTopic.values()].map(({ question, topic }) => ({
      questionId: questionIdentity(paper.id, question.questionReference),
      paperId: String(paper.id),
      questionReference: question.questionReference,
      pageNumber: question.pageNumber,
      parentQuestion: String(question.parentQuestion ?? question.questionReference.split('.')[0] ?? '').trim(),
      topic,
      marks: question.marks,
    }));
    return { paper, questionLinks, matchedTopicCount: selectedByTopic.size };
  }).filter((entry) => entry.questionLinks.length)
    .sort((left, right) => right.matchedTopicCount - left.matchedTopicCount
      || new Set(left.questionLinks.map((item) => item.pageNumber)).size - new Set(right.questionLinks.map((item) => item.pageNumber)).size
      || String(left.paper.id).localeCompare(String(right.paper.id)));
  if (!ranked.length) return null;
  const selected = ranked[0];
  return {
    paper: selected.paper,
    questionLinks: selected.questionLinks,
    topics: uniqueTopics(selected.questionLinks.map((item) => item.topic)),
    matchedTopicCount: selected.matchedTopicCount,
    requestedTopicCount: requestedByKey.size,
  };
};

export const selectSystemPeerWorkQuestionsWithFallback = (options = {}) => {
  const preferred = selectSystemPeerWorkQuestions(options);
  if (preferred) return { ...preferred, sourceSelectionMode: 'unused-paper' };

  const sameDayPaperFallback = selectSystemPeerWorkQuestions({
    ...options,
    excludedPaperIds: new Set(),
  });
  if (sameDayPaperFallback) return { ...sameDayPaperFallback, sourceSelectionMode: 'same-day-paper-last-resort' };

  const usedQuestionFallback = selectSystemPeerWorkQuestions({
    ...options,
    excludedPaperIds: new Set(),
    excludedQuestionIds: new Set(),
  });
  if (!usedQuestionFallback) return null;
  const repeatsSameDayQuestion = usedQuestionFallback.questionLinks.some((link) =>
    options.excludedQuestionIds?.has(questionIdentity(link.paperId, link.questionReference)));
  return {
    ...usedQuestionFallback,
    sourceSelectionMode: repeatsSameDayQuestion ? 'same-day-question-last-resort' : 'used-question-last-resort',
  };
};

export const validateSystemPeerWorkSolutions = ({ response, questionLinks = [] }) => {
  if (!response || response.status !== 'completed' || !Array.isArray(response.solutions)) {
    throw new Error('The AI solution response was incomplete.');
  }
  const requested = new Map(questionLinks.map((question) => [question.questionId, question]));
  if (!requested.size || response.solutions.length !== requested.size) {
    throw new Error('The AI solution response did not include every selected question.');
  }
  const seen = new Set();
  return response.solutions.map((solution) => {
    const questionId = String(solution?.questionId ?? '').trim();
    if (!requested.has(questionId) || seen.has(questionId)) throw new Error('The AI solution response included an unknown or repeated question.');
    seen.add(questionId);
    const solutionText = String(solution?.solutionText ?? '').trim();
    if (!solutionText || solutionText.length > 1800) throw new Error('The AI solution text was empty or too long to use safely.');
    return { questionId, solutionText };
  });
};
