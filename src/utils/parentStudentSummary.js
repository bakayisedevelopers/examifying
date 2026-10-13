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
