import test from 'node:test';
import assert from 'node:assert/strict';
import { getParentCalendarDateStatus, getStudentDailyCompletion } from './parentCompletion.js';

const student = {
  episodes: [{ id: 'math' }, { id: 'science' }],
  bounds: { subjectBounds: {
    math: { earliestDate: '2026-10-12', latestDate: '2026-10-13' },
    science: { earliestDate: '2026-10-12', latestDate: '2026-10-13' },
  } },
  exercises: [
    { id: 'm1', subjectInstanceId: 'math', assignmentDate: '2026-10-12', submittedImageUrl: 'image' },
    { id: 's1', subjectInstanceId: 'science', assignmentDate: '2026-10-12', submissionStatus: 'submitted' },
  ],
  assignments: [{ id: 'a1', reviewerSubjectInstanceId: 'math', assignmentDate: '2026-10-12', status: 'completed' }],
};

test('a student day requires submitted work in every active subject and completed assigned marking', () => {
  const complete = getStudentDailyCompletion({
    dateKey: '2026-10-12', episodes: student.episodes, exercises: student.exercises, assignments: student.assignments,
  });
  assert.equal(complete.complete, true);
  assert.equal(complete.exerciseComplete, true);
  assert.equal(complete.markingComplete, true);

  const pending = getStudentDailyCompletion({
    dateKey: '2026-10-12', episodes: student.episodes,
    exercises: student.exercises.map((exercise) => exercise.id === 's1' ? { ...exercise, submissionStatus: 'pending' } : exercise),
    assignments: student.assignments,
  });
  assert.equal(pending.complete, false);
});

test('the parent calendar waits for every child and marks previous incomplete work', () => {
  assert.equal(getParentCalendarDateStatus({ dateKey: '2026-10-12', today: '2026-10-13', students: [student] }), 'completed');
  const secondChild = { ...student, exercises: student.exercises.filter((exercise) => exercise.id !== 's1') };
  assert.equal(getParentCalendarDateStatus({ dateKey: '2026-10-12', today: '2026-10-13', students: [student, secondChild] }), 'missed');
  assert.equal(getParentCalendarDateStatus({ dateKey: '2026-10-13', today: '2026-10-13', students: [secondChild] }), 'inProgress');
  assert.equal(getParentCalendarDateStatus({ dateKey: '2026-10-14', today: '2026-10-13', students: [student] }), 'locked');
});
