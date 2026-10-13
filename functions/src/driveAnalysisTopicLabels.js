import { normalizeStoredTopicLabel } from './globalTopicCatalog.js';

const normalizeTopicKey = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9|]+/g, ' ')
  .replace(/\s*\|\s*/g, ' | ')
  .replace(/\s+/g, ' ')
  .trim();

const topicLabelFromOption = (option) => typeof option === 'string'
  ? option
  : option?.topic ?? option?.label ?? '';

export const normalizeDriveAnalysisTopicLabels = ({ values, allowedTopics = [], questionReference = '' }) => {
  const requested = Array.isArray(values) ? values : [values];
  const supplied = requested.map((value) => String(value ?? '').trim()).filter(Boolean);
  const labels = supplied.map(normalizeStoredTopicLabel);
  const reference = questionReference ? `Question ${questionReference}` : 'A question';

  if (labels.some((label) => !label)) {
    throw new Error(`${reference} contains a topic that is not in Child | Parent format.`);
  }

  const keys = labels.map(normalizeTopicKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${reference} contains duplicate topic labels.`);
  }

  const allowedByKey = new Map((Array.isArray(allowedTopics) ? allowedTopics : [])
    .map((option) => {
      const label = normalizeStoredTopicLabel(topicLabelFromOption(option));
      return [normalizeTopicKey(label), label];
    })
    .filter(([key, label]) => key && label));

  return labels.map((label) => allowedByKey.get(normalizeTopicKey(label)) ?? label);
};

export const extendTopicOptionsWithDriveLabels = (topicOptions = [], questionTopics = []) => {
  const options = Array.isArray(topicOptions) ? [...topicOptions] : [];
  const seen = new Set(options.map((option) => normalizeTopicKey(topicLabelFromOption(option))).filter(Boolean));
  (Array.isArray(questionTopics) ? questionTopics : []).flat().forEach((label) => {
    const normalized = normalizeStoredTopicLabel(label);
    const key = normalizeTopicKey(normalized);
    if (normalized && key && !seen.has(key)) {
      options.push(normalized);
      seen.add(key);
    }
  });
  return options;
};
