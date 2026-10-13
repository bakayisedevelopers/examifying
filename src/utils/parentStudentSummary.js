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
  .flatMap((result) => Array.isArray(result.value)
    ? result.value
    : result.value == null ? [] : [result.value]);

export const summarizeParentStudentProgress = ({ todayExerciseResults = [], completedTopicResults = [] } = {}) => {
  const todayExercises = fulfilledValues(todayExerciseResults);
  const completedTopicSummaries = fulfilledValues(completedTopicResults);

  return {
    todayExercise: todayExercises
      .sort((left, right) => String(left.subject ?? '').localeCompare(String(right.subject ?? '')))[0] ?? null,
    completedTopicsCount: completedTopicSummaries.filter((summary) => summary.topicStatus === 'done').length,
    todayExerciseUnavailable: todayExerciseResults.some((result) => result?.status === 'rejected'),
    completedTopicsUnavailable: completedTopicResults.some((result) => result?.status === 'rejected'),
  };
};
