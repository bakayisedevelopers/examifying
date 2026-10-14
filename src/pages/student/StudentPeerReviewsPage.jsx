import { useEffect, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { OperationStatusOverlay } from '../../components/common/OperationStatusOverlay';
import { PeerReviewForm } from '../../components/dashboard/PeerReviewForm';
import { useStudentWorkspaceProfile } from '../../hooks/useStudentWorkspaceProfile';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import {
  completePeerMarkingAssignment,
  getActiveSubjectEpisodesForStudent,
  subscribePeerMarkingAssignmentsForStudent,
  getStudentEntitlementState,
} from '../../services/firestoreService';
import { uploadPeerReviewImage } from '../../services/storageService';
import { DEFAULT_SUBJECT } from '../../lib/constants';

export const StudentPeerReviewsPage = () => {
  const { profile, logout } = useStudentWorkspaceProfile();
  const { operationStatus, runOperation, closeOperationStatus } = useOperationStatus();
  const [availableSubjects, setAvailableSubjects] = useState([]);
  const [availableSubjectEpisodes, setAvailableSubjectEpisodes] = useState([]);
  const [selectedSubject, setSelectedSubject] = useState(DEFAULT_SUBJECT);
  const [assignment, setAssignment] = useState(null);
  const [paymentCompleted, setPaymentCompleted] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!profile?.uid) return undefined;
    let active = true;
    getActiveSubjectEpisodesForStudent(profile.uid).then((episodes) => {
      if (!active) return;
      const subjects = [...new Set(episodes.map((episode) => episode.subjectKey).filter(Boolean))].sort();
      setAvailableSubjectEpisodes(episodes);
      setAvailableSubjects(subjects);
      if (subjects.length && !subjects.includes(selectedSubject)) setSelectedSubject(subjects[0]);
    }).catch((error) => setStatus(error.message || 'Could not load your active subjects.'));
    return () => { active = false; };
  }, [profile?.uid, selectedSubject]);

  useEffect(() => {
    if (!profile?.uid || !selectedSubject) return undefined;
    let active = true;
    let unsubscribe = () => {};
    setIsLoading(true);
    setStatus('');
    const episode = availableSubjectEpisodes.find((item) => item.studentId === profile.uid && item.subjectKey === selectedSubject) ?? null;
    getStudentEntitlementState(profile, selectedSubject, episode).then((access) => {
      if (!active) return;
      setPaymentCompleted(Boolean(access.paidSubscriptionActive));
      unsubscribe = subscribePeerMarkingAssignmentsForStudent(profile.uid, (assignments) => {
        if (!active) return;
        const matching = assignments.filter((item) => item.subject === selectedSubject)
          .sort((left, right) => String(right.assignmentDate ?? '').localeCompare(String(left.assignmentDate ?? '')));
        setAssignment(matching[0] ?? null);
        setIsLoading(false);
      }, (error) => {
        if (!active) return;
        setStatus(error?.message || 'Could not load peer marking assignments.');
        setIsLoading(false);
      });
    }).catch((error) => {
      if (active) setStatus(error.message || 'Could not load peer marking.');
      if (active) setIsLoading(false);
    });
    return () => { active = false; unsubscribe(); };
  }, [profile, selectedSubject, availableSubjectEpisodes]);

  const submitMarkedPages = async (files) => runOperation({
    operationName: 'Submitting peer marking',
    successMessage: 'Your marked pages were uploaded and the marking submission was saved.',
    failureMessage: 'Could not submit peer marking.',
  }, async () => {
    if (!assignment || !profile?.uid) throw new Error('No peer marking assignment is available.');
    setIsSubmitting(true);
    setStatus('Uploading marked pages...');
    try {
      const reviewImages = await Promise.all(files.map(async (file, index) => {
        const upload = await uploadPeerReviewImage({
          file,
          studentId: profile.uid,
          exerciseId: assignment.reviewerExerciseId,
          subjectInstanceId: assignment.reviewerSubjectInstanceId,
        });
        return { ...upload, pageNumber: index + 1 };
      }));
      await completePeerMarkingAssignment({
        assignmentId: assignment.id,
        assignmentPath: assignment.assignmentPath,
        reviewerId: profile.uid,
        reviewImages,
      });
      setAssignment(null);
      setStatus('Peer marking submitted successfully.');
    } finally {
      setIsSubmitting(false);
    }
  });

  const images = assignment?.submittedImages?.length
    ? assignment.submittedImages
    : assignment?.submittedImageUrl ? [{ url: assignment.submittedImageUrl }] : [];

  return (
    <AppShell title="Peer marking" subtitle="Review your assigned answers and upload the marked pages." role="student" user={profile} onLogout={logout}>
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-semibold text-slate-950">Subject</p>
          <p className="text-xs text-slate-500">Assignments are tied to an active subject episode.</p>
        </div>
        <select className="input max-w-xs" value={selectedSubject} onChange={(event) => setSelectedSubject(event.target.value)} disabled={!availableSubjects.length}>
          {availableSubjects.map((subject) => <option key={subject}>{subject}</option>)}
        </select>
      </div>
      {status ? <div role="status" className="panel p-4 text-sm text-slate-600">{status}</div> : null}
      {isLoading ? <LoadingState label="Loading peer-marking assignment…" /> : null}
      {!isLoading && paymentCompleted === false ? <div className="panel p-5 text-sm text-amber-700">An active paid subject is required before peer marking unlocks.</div> : null}
      {!isLoading && paymentCompleted && !assignment ? <div className="panel p-5 text-sm text-slate-500">No student submission was available to assign today. We’ll prepare matching system-generated practice work when an analyzed past-paper question is available.</div> : null}
      {!isLoading && paymentCompleted && assignment?.status === 'preparing' ? <div className="panel p-5 text-sm text-slate-300" role="status">Preparing a subject- and grade-matched practice marking task…</div> : null}
      {!isLoading && paymentCompleted && assignment?.status === 'fallback_failed' ? <div className="panel p-5 text-sm text-amber-200" role="status">A practice marking task could not be prepared yet. Your exercise submission is safe; please check again later.</div> : null}
      {!isLoading && assignment?.status === 'assigned' ? <PeerReviewForm
        key={assignment.id}
        submission={{ images, imageUrl: images[0]?.url, exerciseTitle: assignment.title || 'Exercise', sourceType: assignment.sourceType }}
        canReview={Boolean(paymentCompleted && assignment.status === 'assigned' && !isSubmitting)}
        onSubmit={submitMarkedPages}
      /> : null}
      <OperationStatusOverlay
        state={operationStatus?.state}
        operationName={operationStatus?.operationName}
        message={operationStatus?.message}
        onDone={closeOperationStatus}
      />
    </AppShell>
  );
};
