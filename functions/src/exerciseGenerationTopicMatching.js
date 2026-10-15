const normalizeTopic = (value = '') => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const topicParts = (value = '') => {
  const parts = String(value ?? '').split('|').map(normalizeTopic).filter(Boolean);
  return parts.length === 2 ? parts : [normalizeTopic(value)].filter(Boolean);
};

export const exerciseGenerationTopicLabelsMatch = (left, right) => {
  const leftParts = topicParts(left);
  const rightParts = topicParts(right);
  if (!leftParts.length || !rightParts.length) return false;
  if (leftParts.length === 2 && rightParts.length === 2) {
    return leftParts[0] === rightParts[0] && leftParts[1] === rightParts[1];
  }
  if (leftParts.length === 2) return rightParts[0] === leftParts[0];
  if (rightParts.length === 2) return leftParts[0] === rightParts[0];
  return leftParts[0] === rightParts[0];
};

export const normalizeExerciseGenerationTopic = normalizeTopic;
