export const requireSubmissionActor = ({ currentUser, studentId }) => {
  if (!currentUser?.uid) throw new Error('Sign in to your account before uploading answers.');
  if (!studentId) throw new Error('The student for this exercise could not be identified.');
};
