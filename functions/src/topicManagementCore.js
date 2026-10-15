export const normalizeTopicKey = (value = '') => String(value)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/['’]s\b/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

export const topicNamesIn = (lesson = {}) => [...new Set([
  ...(Array.isArray(lesson.topics) ? lesson.topics : []),
  lesson.topic,
  ...(Array.isArray(lesson.topicUnderstandingScores) ? lesson.topicUnderstandingScores.map((item) => item?.topic) : []),
].map((item) => String(item ?? '').trim()).filter(Boolean))];

export const getLessonTopicRemoval = (lesson = {}, targetKeys = new Set()) => {
  const allTopics = topicNamesIn(lesson);
  const remainingTopics = allTopics.filter((topic) => !targetKeys.has(normalizeTopicKey(topic)));
  if (remainingTopics.length === allTopics.length) return { changed: false, remainingTopics };
  return {
    changed: true,
    remainingTopics,
    hasTopicsArray: Array.isArray(lesson.topics),
    clearPrimaryTopic: Boolean(lesson.topic && targetKeys.has(normalizeTopicKey(lesson.topic))),
    remainingScores: Array.isArray(lesson.topicUnderstandingScores)
      ? lesson.topicUnderstandingScores.filter((item) => !targetKeys.has(normalizeTopicKey(item?.topic)))
      : null,
    resetCompletion: remainingTopics.length === 0
      && (lesson.status === 'completed' || lesson.manualTopicCompletion === true),
  };
};
