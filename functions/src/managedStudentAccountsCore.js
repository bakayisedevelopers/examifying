export const isManagedStudentInviteProfileEligible = (student, parentId) => (
  student?.role === 'student' && student.parentId === parentId
);
