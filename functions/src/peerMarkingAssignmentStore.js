import { peerMarkingAllocationLockId } from './peerMarkingFallbackCore.js';
import { FieldValue } from 'firebase-admin/firestore';

export const claimPeerMarkingAssignmentSlot = async ({ db, assignmentRef, reviewerId, cohort, assignment }) => {
  const lockId = peerMarkingAllocationLockId({ ...cohort, reviewerId });
  const lockRef = db.collection('peerMarkingAssignmentLocks').doc(lockId);
  const reviewerExerciseRef = assignment.reviewerExercisePath ? db.doc(assignment.reviewerExercisePath) : null;
  return db.runTransaction(async (transaction) => {
    const [lockSnapshot, assignmentSnapshot, reviewerExerciseSnapshot] = await Promise.all([
      transaction.get(lockRef), transaction.get(assignmentRef),
      reviewerExerciseRef ? transaction.get(reviewerExerciseRef) : Promise.resolve(null),
    ]);
    if (reviewerExerciseRef && !reviewerExerciseSnapshot?.exists) return false;
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
    if (assignment.reviewerExercisePath) {
      transaction.set(db.doc(assignment.reviewerExercisePath), {
        peerMarkingWorkStatus: assignment.status || 'preparing',
        peerMarkingWorkAssignmentId: assignmentRef.id,
        peerMarkingWorkAssignmentPath: assignmentRef.path,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return true;
  });
};
