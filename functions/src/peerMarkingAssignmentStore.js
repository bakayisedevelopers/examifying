import { peerMarkingAllocationLockId } from './peerMarkingFallbackCore.js';

export const claimPeerMarkingAssignmentSlot = async ({ db, assignmentRef, reviewerId, cohort, assignment }) => {
  const lockId = peerMarkingAllocationLockId({ ...cohort, reviewerId });
  const lockRef = db.collection('peerMarkingAssignmentLocks').doc(lockId);
  return db.runTransaction(async (transaction) => {
    const [lockSnapshot, assignmentSnapshot] = await Promise.all([
      transaction.get(lockRef), transaction.get(assignmentRef),
    ]);
    if (lockSnapshot.exists) return false;
    if (assignmentSnapshot.exists) {
      transaction.create(lockRef, {
        reviewerId,
        assignmentDate: cohort.assignmentDate,
        subject: cohort.subject,
        grade: cohort.grade,
        assignmentPath: assignmentRef.path,
        createdAt: new Date(),
      });
      return false;
    }
    transaction.create(lockRef, {
      reviewerId,
      assignmentDate: cohort.assignmentDate,
      subject: cohort.subject,
      grade: cohort.grade,
      assignmentPath: assignmentRef.path,
      createdAt: new Date(),
    });
    transaction.create(assignmentRef, assignment);
    return true;
  });
};
