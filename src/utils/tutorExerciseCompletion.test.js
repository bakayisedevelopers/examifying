import test from 'node:test';
import assert from 'node:assert/strict';
import { getTutorCalendarDateStatus, getTutorExerciseCompletionKey, getTutorExerciseCompletionStatus } from './tutorExerciseCompletion.js';

const exercise = {
  id: 'exercise-1',
  studentId: 'student-1',
  subjectInstanceId: 'subject-1',
  assignmentDate: '2026-10-12',
  submittedImageUrl: 'https://example.test/submission.png',
  tutorMarkedImageUrl: 'https://example.test/marked.png',
  questionLinks: [{ paperId: 'paper-1', questionReference: 'Q1', topic: 'Fractions', marks: 4 }],
};

const exerciseScore = {
  sourceType: 'Exercise',
  sourceId: exercise.id,
  exerciseId: exercise.id,
  paperId: 'paper-1',
  questionReference: 'Q1',
  earnedMarks: 3,
  totalMarks: 4,
};

const peerAssignment = {
  id: 'review-1',
  assignmentPath: 'users/reviewee/subjects/reviewee-subject/exercises/reviewee-exercise/peerMarkingAssignments/student-1',
  reviewerId: exercise.studentId,
  reviewerSubjectInstanceId: exercise.subjectInstanceId,
  reviewerExerciseId: exercise.id,
  exerciseId: 'reviewee-exercise',
  status: 'completed',
  tutorReviewStatus: 'reviewed',
  questionLinks: [{ paperId: 'paper-2', questionReference: 'Q3', topic: 'Fractions', marks: 5 }],
};

const peerScore = {
  sourceType: 'Marking',
  sourceId: peerAssignment.assignmentPath,
  peerAssignmentPath: peerAssignment.assignmentPath,
  peerAssignmentId: peerAssignment.id,
  reviewerExerciseId: exercise.id,
  exerciseId: peerAssignment.exerciseId,
  paperId: 'paper-2',
  questionReference: 'Q3',
  earnedMarks: 4,
  totalMarks: 5,
};

test('tutor completion requires submission, saved marking, and every own-exercise question score', () => {
  assert.equal(getTutorExerciseCompletionStatus({ exercise }).tutorCompleted, false);
  assert.equal(getTutorExerciseCompletionStatus({ exercise: { ...exercise, tutorMarkedImageUrl: '' } }).tutorCompleted, false);
  assert.equal(getTutorExerciseCompletionStatus({ exercise, scoreEntries: [exerciseScore] }).tutorCompleted, true);
});

test('tutor completion also requires reviewed peer marking and its per-question score', () => {
  assert.equal(getTutorExerciseCompletionStatus({ exercise, peerMarkingAssignments: [peerAssignment], scoreEntries: [exerciseScore] }).tutorCompleted, false);
  assert.equal(getTutorExerciseCompletionStatus({ exercise, peerMarkingAssignments: [{ ...peerAssignment, tutorReviewStatus: '' }], scoreEntries: [exerciseScore, peerScore] }).tutorCompleted, false);
  const result = getTutorExerciseCompletionStatus({
    exercise,
    peerMarkingAssignments: [peerAssignment],
    scoreEntries: [exerciseScore, peerScore],
  });
  assert.equal(result.studentPeerMarkingState, 'completed');
  assert.equal(result.peerReviewsComplete, true);
  assert.equal(result.tutorCompleted, true);
});

test('assigned but unfinished peer marking remains pending tutor work', () => {
  const result = getTutorExerciseCompletionStatus({
    exercise,
    peerMarkingAssignments: [{ ...peerAssignment, status: 'assigned', tutorReviewStatus: '' }],
    scoreEntries: [exerciseScore],
  });
  assert.equal(result.studentPeerMarkingState, 'pending');
  assert.equal(result.tutorCompleted, false);
});

test('tutor calendar aggregates all exercises for the date and uses pending versus missed indicators', () => {
  const one = { id: 'one', studentId: 'student-1', subjectInstanceId: 'subject-1', assignmentDate: '2026-10-12' };
  const two = { id: 'two', studentId: 'student-2', subjectInstanceId: 'subject-2', assignmentDate: '2026-10-12' };
  const exercises = [one, two];
  assert.equal(getTutorCalendarDateStatus({
    dateKey: '2026-10-12', today: '2026-10-13', exercises,
    completionByExerciseId: {
      [getTutorExerciseCompletionKey(one)]: { tutorCompleted: true },
      [getTutorExerciseCompletionKey(two)]: { tutorCompleted: false },
    },
  }), 'missed');
  const todayExercise = { id: 'today', studentId: 'student-1', subjectInstanceId: 'subject-1', assignmentDate: '2026-10-13' };
  assert.equal(getTutorCalendarDateStatus({
    dateKey: '2026-10-13', today: '2026-10-13', exercises: [todayExercise],
    completionByExerciseId: { [getTutorExerciseCompletionKey(todayExercise)]: { tutorCompleted: false } },
  }), 'inProgress');
  const futureExercise = { id: 'future', studentId: 'student-1', subjectInstanceId: 'subject-1', assignmentDate: '2026-10-14' };
  assert.equal(getTutorCalendarDateStatus({
    dateKey: '2026-10-14', today: '2026-10-13', exercises: [futureExercise],
    completionByExerciseId: { [getTutorExerciseCompletionKey(futureExercise)]: { tutorCompleted: false } },
  }), 'inProgress');
  assert.equal(getTutorCalendarDateStatus({
    dateKey: '2026-10-12', today: '2026-10-13', exercises,
    completionByExerciseId: {
      [getTutorExerciseCompletionKey(one)]: { tutorCompleted: true },
      [getTutorExerciseCompletionKey(two)]: { tutorCompleted: true },
    },
  }), 'completed');
  assert.equal(getTutorCalendarDateStatus({ dateKey: '2026-10-11', today: '2026-10-13', exercises, completionByExerciseId: {} }), 'none');
});
