import { questionMatchesTopics } from './exerciseTopicMatching.js';

const MAX_TOPIC_AVERAGE_PAPERS = 20;

const getQuestionMarks = (question = {}) => {
  const value = Number(question?.marks ?? question?.totalMarks ?? question?.allocatedMarks);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const normalizePaperNumber = (paper = {}) => {
  const value = String(paper?.paperNumber ?? paper?.paperMetadata?.paperNumber ?? '').trim();
  if (!value) return '';
  if (/^paper\b/i.test(value) || /examplar|exemplar/i.test(value)) return value;
  return /^\d+$/.test(value) ? `Paper ${value}` : value;
};

const sortPaperNumbers = (values) => [...values].sort((left, right) => {
  const leftNumber = Number(left.match(/\d+/)?.[0]);
  const rightNumber = Number(right.match(/\d+/)?.[0]);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) return leftNumber - rightNumber;
  if (Number.isFinite(leftNumber) !== Number.isFinite(rightNumber)) return Number.isFinite(leftNumber) ? -1 : 1;
  return left.localeCompare(right);
});

const samplePapers = (papers, random) => {
  const eligible = papers.filter((paper) => paper?.analysisStatus === 'Analyzed'
    && Array.isArray(paper.questions) && paper.questions.length > 0
    && paper.questions.some((question) => getQuestionMarks(question) !== null));
  // Fisher-Yates gives the planning view a genuinely random sample, while the
  // injected random source keeps this calculation deterministic in tests.
  for (let index = eligible.length - 1; index > 0; index -= 1) {
    const value = Number(random());
    const safeValue = Number.isFinite(value) ? Math.min(1 - Number.EPSILON, Math.max(0, value)) : 0;
    const randomIndex = Math.floor(safeValue * (index + 1));
    [eligible[index], eligible[randomIndex]] = [eligible[randomIndex], eligible[index]];
  }
  return eligible.slice(0, MAX_TOPIC_AVERAGE_PAPERS);
};

export const calculateTopicAverageDetails = (topic, papers = []) => {
  if (!String(topic ?? '').trim() || !Array.isArray(papers)) return { averageMarks: null, paperNumbers: [] };

  const paperTotals = [];
  const paperNumbers = new Set();
  for (const paper of papers) {
    if (paper?.analysisStatus !== 'Analyzed' || !Array.isArray(paper.questions)) continue;
    const matchingQuestions = paper.questions.filter((question) => questionMatchesTopics(question, [topic]));
    if (!matchingQuestions.length) continue;

    const marks = matchingQuestions
      .map((question) => Number(question?.marks ?? question?.totalMarks ?? question?.allocatedMarks))
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (!marks.length) continue;

    paperTotals.push(marks.reduce((total, value) => total + value, 0));
    const paperNumber = normalizePaperNumber(paper);
    if (paperNumber) paperNumbers.add(paperNumber);
    if (paperTotals.length === MAX_TOPIC_AVERAGE_PAPERS) break;
  }

  return {
    averageMarks: paperTotals.length
      ? paperTotals.reduce((total, value) => total + value, 0) / paperTotals.length
      : null,
    paperNumbers: sortPaperNumbers(paperNumbers),
  };
};

export const calculateTopicAverageMarks = (topic, papers = []) => calculateTopicAverageDetails(topic, papers).averageMarks;

/**
 * Calculates global topic averages and the average total paper marks from the
 * same random sample. Marks for questions tagged to multiple global topics are
 * split evenly so selected-topic totals cannot count the same mark twice.
 */
export const calculateGlobalTopicPlanningSummary = (topics = [], papers = [], { random = Math.random } = {}) => {
  if (!Array.isArray(topics) || !Array.isArray(papers)) {
    return { samplePaperCount: 0, averagePaperMarks: null, topics: [] };
  }

  const topicNames = [...new Set(topics.map((topic) => String(topic ?? '').trim()).filter(Boolean))];
  const sampled = samplePapers(papers, random);
  if (!sampled.length) {
    return {
      samplePaperCount: 0,
      averagePaperMarks: null,
      topics: topicNames.map((topic) => ({ topic, averageMarks: null, paperNumbers: [] })),
    };
  }

  const topicTotals = new Map(topicNames.map((topic) => [topic, 0]));
  const topicPaperNumbers = new Map(topicNames.map((topic) => [topic, new Set()]));
  let totalPaperMarks = 0;

  sampled.forEach((paper) => {
    let paperTotal = 0;
    paper.questions.forEach((question) => {
      const marks = getQuestionMarks(question);
      if (marks === null) return;
      paperTotal += marks;
      const matchedTopics = topicNames.filter((topic) => questionMatchesTopics(question, [topic]));
      if (!matchedTopics.length) return;
      const allocatedMarks = marks / matchedTopics.length;
      matchedTopics.forEach((topic) => {
        topicTotals.set(topic, topicTotals.get(topic) + allocatedMarks);
        const paperNumber = normalizePaperNumber(paper);
        if (paperNumber) topicPaperNumbers.get(topic).add(paperNumber);
      });
    });
    totalPaperMarks += paperTotal;
  });

  return {
    samplePaperCount: sampled.length,
    averagePaperMarks: totalPaperMarks / sampled.length,
    topics: topicNames.map((topic) => ({
      topic,
      averageMarks: topicTotals.get(topic) / sampled.length,
      paperNumbers: sortPaperNumbers(topicPaperNumbers.get(topic)),
    })),
  };
};
