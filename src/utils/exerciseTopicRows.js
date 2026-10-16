const normalizeTopic = (value) => String(value ?? '').trim().toLocaleLowerCase();
const topicName = (value) => String(value?.topic ?? value ?? '').trim();
const questionReference = (question) => normalizeTopic(question?.questionReference || question?.reference);

export const uniqueTopicNames = (values = []) => [...new Map(values
  .map(topicName)
  .filter(Boolean)
  .map((topic) => [normalizeTopic(topic), topic])).values()];

const matchingBreakdownEntry = (link, topicBreakdown) => {
  const reference = questionReference(link);
  if (!reference) return null;
  const paperId = String(link?.paperId ?? '').trim();
  return topicBreakdown.find((item) => questionReference(item) === reference
    && (!paperId || !item?.paperId || paperId === String(item.paperId).trim()));
};

/** Resolve a question's topic from its link, using the breakdown only when missing. */
export const getTopicQuestionLinks = (questionLinks = [], topicBreakdown = []) => {
  const links = Array.isArray(questionLinks) && questionLinks.length
    ? questionLinks
    : Array.isArray(topicBreakdown) ? topicBreakdown : [];
  const breakdown = Array.isArray(topicBreakdown) ? topicBreakdown : [];

  return links.map((link) => {
    const linkedTopic = topicName(link);
    const matchedBreakdown = matchingBreakdownEntry(link, breakdown);
    return {
      ...link,
      topic: linkedTopic || topicName(matchedBreakdown),
      topicId: link?.topicId || link?.canonicalTopicKey || matchedBreakdown?.topicId || matchedBreakdown?.canonicalTopicKey || '',
    };
  });
};

const questionMarks = (question) => Number(question?.marks ?? question?.totalMarks) || 0;

export const getExerciseQuestionRows = (source = {}) => {
  const linkedQuestions = getTopicQuestionLinks(source.questionLinks, source.topicBreakdown);
  const storedQuestions = Array.isArray(source.questions) ? source.questions : [];
  const questionReferences = Array.isArray(source.questionReferences) ? source.questionReferences : [];
  const questions = storedQuestions.length
    ? storedQuestions.map((question, index) => {
      const normalizedQuestion = typeof question === 'object' && question !== null
        ? question
        : { questionReference: question };
      const reference = String(normalizedQuestion.questionReference || normalizedQuestion.reference || questionReferences[index] || '').trim().toLocaleLowerCase();
      const paperId = String(normalizedQuestion.paperId || '').trim();
      const matchingLink = linkedQuestions.find((link) =>
        String(link.questionReference || link.reference || '').trim().toLocaleLowerCase() === reference
        && (!paperId || !link.paperId || paperId === String(link.paperId).trim()));
      return {
        ...matchingLink,
        ...normalizedQuestion,
        questionReference: normalizedQuestion.questionReference || normalizedQuestion.reference || questionReferences[index],
        paperId: normalizedQuestion.paperId || matchingLink?.paperId || '',
        pageNumber: normalizedQuestion.pageNumber ?? normalizedQuestion.page ?? matchingLink?.pageNumber ?? 0,
        marks: normalizedQuestion.marks ?? normalizedQuestion.totalMarks ?? matchingLink?.marks ?? 0,
        topic: normalizedQuestion.topic || matchingLink?.topic || '',
        topicId: normalizedQuestion.topicId || normalizedQuestion.canonicalTopicKey || matchingLink?.topicId || '',
      };
    })
    : linkedQuestions.length
      ? linkedQuestions
      : questionReferences.map((questionReference) => ({ questionReference }));
  const fallbackTopic = (Array.isArray(source.topics) ? source.topics[0] : '') || source.topic || '';

  return questions.map((question, index) => {
    const paperIds = Array.isArray(source.paperIds) ? source.paperIds : [];
    const paperId = String(question.paperId || (paperIds.length === 1 ? paperIds[0] : '') || '');
    return {
      ...question,
      paperId,
      questionReference: String(question.questionReference || question.reference || `Question ${index + 1}`),
      topic: String(question.topic || fallbackTopic || '').trim(),
      topicId: String(question.topicId || question.canonicalTopicKey || ''),
      totalMarks: questionMarks(question),
      questionIndex: index,
    };
  });
};

export const getLatestQuestionScore = (entries = [], row, question) => entries
  .filter((entry) => {
    const matchesSource = row.activity === 'Exercise'
      ? entry.sourceType === 'Exercise' && (entry.sourceId === row.sourceId || entry.exerciseId === row.sourceId)
      : entry.sourceType === 'Marking'
        && String(entry.reviewerExerciseId || '') === String(row.assignment?.reviewerExerciseId || '')
        && String(entry.exerciseId || '') === String(row.assignment?.exerciseId || '')
        && (entry.peerAssignmentPath === row.sourceId
          || entry.sourceId === row.sourceId
          || entry.peerAssignmentId === row.assignment?.id);
    const sameQuestion = normalizeTopic(entry.questionReference) === normalizeTopic(question.questionReference);
    const samePaper = !entry.paperId || !question.paperId || entry.paperId === question.paperId;
    return matchesSource && sameQuestion && samePaper
      && Number.isFinite(Number(entry.earnedMarks)) && Number.isFinite(Number(entry.totalMarks));
  })
  .sort((left, right) => {
    const timestamp = (value) => value?.toDate ? value.toDate().getTime() : new Date(value ?? 0).getTime();
    return timestamp(right.createdAt) - timestamp(left.createdAt);
  })[0] ?? null;

export const getQuestionPaperPath = (question, role = 'student', resolvePath = (path) => path) => {
  if (!question?.paperId) return '';
  const page = Math.max(1, Number(question.pageNumber ?? 1) || 1);
  const params = new URLSearchParams({ page: String(page) });
  const reference = String(question.questionReference || question.reference || '').trim();
  if (reference) params.set('question', reference);
  return resolvePath(`/${role}/papers/${question.paperId}?${params.toString()}`);
};

const structuredTopicNames = (questionLinks, topicBreakdown, questions = []) => {
  const links = getTopicQuestionLinks(questionLinks, topicBreakdown);
  const linkedNames = uniqueTopicNames([
    ...links.map((item) => item.topic),
    ...(Array.isArray(questions) ? questions.map((item) => item?.topic) : []),
  ]);
  if (linkedNames.length) return linkedNames;
  return uniqueTopicNames((Array.isArray(topicBreakdown) ? topicBreakdown : []).map((item) => item.topic));
};

export const getExerciseTopicNames = (exercise = {}) => {
  const structuredNames = structuredTopicNames(exercise.questionLinks, exercise.topicBreakdown, exercise.questions);
  if (structuredNames.length) return structuredNames;

  const declaredTopics = uniqueTopicNames(exercise.topics);
  if (declaredTopics.length) return declaredTopics;

  // `topic` may contain canonical labels using `|` internally, so keep it whole.
  return uniqueTopicNames([exercise.topic]);
};

export const getPeerMarkingTopicNames = (assignment = {}) => {
  const structuredNames = structuredTopicNames(assignment.questionLinks, assignment.topicBreakdown, assignment.questions);
  if (structuredNames.length) return structuredNames;

  const declaredTopics = uniqueTopicNames(assignment.topics);
  if (declaredTopics.length) return declaredTopics;

  // As with exercises, don't split a legacy value whose separator is ambiguous.
  return uniqueTopicNames([assignment.topic]);
};

export const getQuestionTopicIds = (source = {}) => [
  ...getTopicQuestionLinks(source.questionLinks, source.topicBreakdown),
  ...(Array.isArray(source.questions) ? source.questions : []),
]
  .map((question) => String(question?.topicId || question?.canonicalTopicKey || '').trim())
  .filter(Boolean);
