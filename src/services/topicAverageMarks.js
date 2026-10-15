import { questionMatchesTopics } from './exerciseTopicMatching.js';

const MAX_TOPIC_AVERAGE_PAPERS = 20;

export const calculateTopicAverageMarks = (topic, papers = []) => {
  if (!String(topic ?? '').trim() || !Array.isArray(papers)) return null;

  const paperTotals = [];
  for (const paper of papers) {
    if (paper?.analysisStatus !== 'Analyzed' || !Array.isArray(paper.questions)) continue;
    const matchingQuestions = paper.questions.filter((question) => questionMatchesTopics(question, [topic]));
    if (!matchingQuestions.length) continue;

    const marks = matchingQuestions
      .map((question) => Number(question?.marks ?? question?.totalMarks ?? question?.allocatedMarks))
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (!marks.length) continue;

    paperTotals.push(marks.reduce((total, value) => total + value, 0));
    if (paperTotals.length === MAX_TOPIC_AVERAGE_PAPERS) break;
  }

  if (!paperTotals.length) return null;
  return paperTotals.reduce((total, value) => total + value, 0) / paperTotals.length;
};
