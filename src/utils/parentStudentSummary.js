export const mergeParentStudentSubscriptionSummary = (subjectAccess, subscriptionState, extra = {}) => ({
  ...subjectAccess,
  ...subscriptionState,
  // Subject access is scoped to an enrollment episode; a subscription belongs
  // to the student and must not disappear when the default subject is absent.
  subjectEpisode: subjectAccess.subjectEpisode ?? null,
  subjectInstanceId: subjectAccess.subjectInstanceId ?? null,
  subjectNotIncluded: !subjectAccess.subjectEpisode,
  paymentCompleted: subscriptionState.paymentCompleted === true,
  paidSubscriptionActive: subscriptionState.paidSubscriptionActive === true,
  paymentRequired: subscriptionState.paymentCompleted !== true,
  ...extra,
});

const fulfilledValues = (results = []) => results
  .filter((result) => result?.status === 'fulfilled')
  .flatMap((result) => Array.isArray(result.value) ? result.value : []);

export const summarizeParentStudentProgress = ({ todayExerciseResults = [], completedLessonResults = [] } = {}) => {
  const todayExercises = fulfilledValues(todayExerciseResults);
  const completedLessons = fulfilledValues(completedLessonResults);

  return {
    todayExercise: todayExercises
      .sort((left, right) => String(left.subject ?? '').localeCompare(String(right.subject ?? '')))[0] ?? null,
    completedLessonsCount: completedLessons.length,
    todayExerciseUnavailable: todayExerciseResults.some((result) => result?.status === 'rejected'),
    completedLessonsUnavailable: completedLessonResults.some((result) => result?.status === 'rejected'),
  };
};
