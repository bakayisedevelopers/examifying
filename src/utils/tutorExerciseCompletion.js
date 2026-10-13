import { getExerciseQuestionRows, getLatestQuestionScore } from './exerciseTopicRows.js';

const isApplicableQuestion = (question) => Boolean(question.topic && question.topic !== '—' && question.totalMarks > 0);

const hasScoresFor = ({ source, activity, sourceId, assignment, scoreEntries }) => {
  const questions = getExerciseQuestionRows(source).filter(isApplicableQuestion);
  const row = { activity, sourceId, assignment };
  return questions.every((question) => Boolean(getLatestQuestionScore(scoreEntries, row, question)));
};

export const getTutorExerciseCompletionStatus = ({ exercise, peerMarkingAssignments = [], scoreEntries = [], workRecordsError = false }) => {
  const studentSubmitted = Boolean(exercise?.submittedImageUrl
    || exercise?.submitted === 'Yes'
    || exercise?.submissionStatus === 'submitted'
    || (Array.isArray(exercise?.submittedImages) && exercise.submittedImages.length));
  const tutorMarked = Boolean(exercise?.tutorMarkedImageUrl
    || exercise?.tutorMarkedAt
    || exercise?.tutorMarkingStatus === 'awaiting-score'
    || exercise?.tutorMarkingStatus === 'completed'
    || (Array.isArray(exercise?.tutorMarkedImages) && exercise.tutorMarkedImages.length));
  const exerciseScoresComplete = hasScoresFor({
    source: exercise,
    activity: 'Exercise',
    sourceId: exercise?.id,
    scoreEntries,
  });
  const assignments = peerMarkingAssignments.filter((assignment) =>
    String(assignment.reviewerExerciseId || '') === String(exercise?.id || '')
    && (!assignment.reviewerSubjectInstanceId || !exercise?.subjectInstanceId
      || String(assignment.reviewerSubjectInstanceId) === String(exercise.subjectInstanceId)));
  const studentPeerMarkingComplete = assignments.length
    ? assignments.every((assignment) => assignment.status === 'completed')
    : exercise?.peerMarkingStatus === 'completed';
  const peerReviewsComplete = !workRecordsError && assignments.every((assignment) => {
    if (assignment.status !== 'completed') return false;
    const hasReviewRecord = assignment.tutorReviewStatus === 'reviewed' || assignment.tutorReviewed === true;
    const hasScoresForReview = hasScoresFor({
      source: assignment,
      activity: 'Marking',
      sourceId: assignment.assignmentPath || assignment.id,
      assignment,
      scoreEntries,
    });
    return hasReviewRecord && hasScoresForReview;
  });

  return {
    studentSubmitted,
    studentPeerMarkingState: workRecordsError ? 'pending' : assignments.length
      ? studentPeerMarkingComplete ? 'completed' : 'pending'
      : exercise?.peerMarkingStatus === 'completed' ? 'completed' : 'none',
    tutorMarked,
    exerciseScoresComplete,
    peerReviewsComplete,
    tutorCompleted: studentSubmitted && tutorMarked && exerciseScoresComplete && peerReviewsComplete,
  };
};

export const getTutorExerciseCompletionKey = (exercise = {}) =>
  `${exercise.studentId || ''}:${exercise.subjectInstanceId || ''}:${exercise.id || ''}`;

export const getTutorCalendarDateStatus = ({ dateKey, today, exercises, completionByExerciseId }) => {
  const dayExercises = exercises.filter((exercise) => String(exercise.assignmentDate ?? '').slice(0, 10) === dateKey);
  if (!dayExercises.length) return 'none';
  if (dayExercises.every((exercise) => completionByExerciseId[getTutorExerciseCompletionKey(exercise)]?.tutorCompleted)) return 'completed';
  if (dateKey < today) return 'missed';
  return 'inProgress';
};
