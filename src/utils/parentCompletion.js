const dayOf = (value) => String(value ?? '').slice(0, 10);
const submitted = (exercise = {}) => Boolean(exercise.submittedImageUrl
  || exercise.submitted === 'Yes'
  || exercise.submissionStatus === 'submitted');

export const getStudentDailyCompletion = ({ dateKey, episodes = [], exercises = [], assignments = [] }) => {
  const activeEpisodes = episodes.filter((episode) => episode?.id && episode.status !== 'cancelled');
  if (!activeEpisodes.length) return { hasWork: false, complete: false, exerciseComplete: false, markingComplete: false };
  const dayExercises = exercises.filter((exercise) => dayOf(exercise.assignmentDate) === dateKey);
  const dayAssignments = assignments.filter((assignment) => dayOf(assignment.assignmentDate) === dateKey);
  const exercisesComplete = activeEpisodes.every((episode) => {
    const episodeExercises = dayExercises.filter((exercise) => exercise.subjectInstanceId === episode.id);
    return episodeExercises.length > 0 && episodeExercises.every(submitted);
  });
  const markingComplete = dayAssignments.every((assignment) => assignment.status === 'completed');
  const hasWork = dayExercises.length > 0 || dayAssignments.length > 0 || activeEpisodes.length > 0;
  return { hasWork, complete: exercisesComplete && markingComplete, exerciseComplete: exercisesComplete, markingComplete };
};

export const getParentCalendarDateStatus = ({ dateKey, today, students = [] }) => {
  const isFuture = dateKey > today;
  let hasWork = false;
  let allComplete = true;
  for (const student of students) {
    const episodes = student.episodes ?? [];
    const expectedEpisodes = episodes.filter((episode) => {
      const bounds = student.bounds?.subjectBounds?.[episode.id];
      return bounds?.earliestDate && bounds?.latestDate
        && dateKey >= bounds.earliestDate && dateKey <= bounds.latestDate;
    });
    const dayExercises = (student.exercises ?? []).filter((exercise) => dayOf(exercise.assignmentDate) === dateKey);
    const dayAssignments = (student.assignments ?? []).filter((assignment) => dayOf(assignment.assignmentDate) === dateKey);
    const relevantEpisodes = expectedEpisodes.length ? expectedEpisodes : episodes.filter((episode) => (
      dayExercises.some((exercise) => exercise.subjectInstanceId === episode.id)
      || dayAssignments.some((assignment) => assignment.reviewerSubjectInstanceId === episode.id)
    ));
    const studentHasWork = relevantEpisodes.length > 0 || dayExercises.length > 0 || dayAssignments.length > 0;
    if (!studentHasWork) continue;
    hasWork = true;
    const exercisesComplete = relevantEpisodes.length > 0 && relevantEpisodes.every((episode) => {
      const episodeExercises = dayExercises.filter((exercise) => exercise.subjectInstanceId === episode.id);
      return episodeExercises.length > 0 && episodeExercises.every(submitted);
    });
    const markingComplete = dayAssignments.every((assignment) => assignment.status === 'completed');
    if (!exercisesComplete || !markingComplete) allComplete = false;
  }
  if (hasWork && allComplete && !isFuture) return 'completed';
  if (isFuture) return hasWork ? 'inProgress' : 'locked';
  if (dateKey === today) return 'inProgress';
  return hasWork ? 'missed' : 'none';
};
