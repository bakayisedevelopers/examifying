import { useEffect, useState } from 'react';
import { Eye, LoaderCircle, RotateCw, Trash2 } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { ImagePageViewer } from '../../components/common/ImagePageViewer';
import { LoadingState } from '../../components/common/LoadingState';
import { ExerciseCard } from '../../components/dashboard/ExerciseCard';
import { useAuth } from '../../hooks/useAuth';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import { deleteExerciseAssignmentForTutor, getCompletedPeerMarkingWorkForTutor, getExerciseAssignmentById, getStudentTopicScoresForTutor, getTopicUnderstandingQuestionScores, getTutorAssignedStudentContexts, getTutorAssignmentHistoryContexts, getTutorAssignmentHistoryData, getTutorPeerMarkingAssignments, retryPeerMarkingFallbackForTutor, subscribeToExerciseAssignment, subscribeToPeerMarkingAssignmentsAtPaths, subscribeToTopicUnderstandingQuestionScores } from '../../services/firestoreService';
import { deleteExerciseSubmissionFiles } from '../../services/storageService';
import { getExerciseAvailability, getExerciseStatusLabels } from '../../utils/exerciseRules';
import { useEffectiveRole } from '../../utils/effectiveRole';
import { getExerciseTopicNames, getPeerMarkingTopicNames, getQuestionTopicIds, uniqueTopicNames } from '../../utils/exerciseTopicRows';

const markingBelongsToExercise = (assignment, exercise) => {
  if (!assignment || !exercise) return false;
  if (exercise.documentPath && assignment.reviewerExercisePath === exercise.documentPath) return true;
  return assignment.reviewerExerciseId === exercise.id
    && assignment.reviewerSubjectInstanceId === exercise.subjectInstanceId;
};

export const TutorExerciseDetailsPage = () => {
  const { exerciseId } = useParams();
  const { profile, logout } = useAuth();
  const { runOperation } = useOperationStatus();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const periodId = searchParams.get('period');
  const studentId = searchParams.get('studentId');
  const subjectInstanceId = searchParams.get('subjectInstanceId');
  const { role, basePath } = useEffectiveRole();
  const [exercise, setExercise] = useState(null);
  const [status, setStatus] = useState('Loading exercise...');
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRetryingPeerWork, setIsRetryingPeerWork] = useState(false);
  const [peerWorkAssignment, setPeerWorkAssignment] = useState(null);
  const [showPeerWork, setShowPeerWork] = useState(false);
  const [topicScores, setTopicScores] = useState({});
  const [accessRole, setAccessRole] = useState('viewer');
  const [isHistorical, setIsHistorical] = useState(false);
  const [completedMarkingAssignments, setCompletedMarkingAssignments] = useState([]);
  const [scoreEntries, setScoreEntries] = useState([]);

  useEffect(() => {
    setIsLoading(true);
    getExerciseAssignmentById(exerciseId, { tutorId: profile?.uid, studentId, subjectInstanceId, periodId })
      .then(async (result) => {
        if (!result) {
          setStatus('Exercise not found.');
          return;
        }
        if (profile?.uid && periodId) {
          const history = await getTutorAssignmentHistoryContexts(profile.uid, result.studentId);
          if (!history.some((period) => period.assignmentPeriodId === periodId)) throw new Error('This assignment history is not available to your account.');
          const archivedData = await getTutorAssignmentHistoryData({ tutorId: profile.uid, studentId: result.studentId, periodId, historyContexts: history });
          const archivedExercise = archivedData.exercises.find((item) => item.id === exerciseId);
          if (!archivedExercise) throw new Error('This exercise is not part of the selected assignment period.');
          const historicalContext = history.find((period) => period.assignmentPeriodId === periodId);
          setExercise({
            ...archivedExercise,
            studentName: historicalContext?.displayName || historicalContext?.name || historicalContext?.email || 'Student',
          });
          setTopicScores(Object.fromEntries((archivedExercise.topicUnderstandingScores ?? []).map((entry) => [entry.topic, entry.understandingLevel])));
          setCompletedMarkingAssignments([]);
          setPeerWorkAssignment(null);
          setShowPeerWork(false);
          const archivedTopics = getExerciseTopicNames(archivedExercise);
          setScoreEntries(await getTopicUnderstandingQuestionScores({
            studentId: archivedExercise.studentId || result.studentId,
            subjectInstanceId: archivedExercise.subjectInstanceId || result.subjectInstanceId,
            topics: archivedTopics,
            topicIds: getQuestionTopicIds(archivedExercise),
            sourceIds: [archivedExercise.id],
          }).catch(() => []));
          setAccessRole('viewer');
          setIsHistorical(true);
          setStatus('');
          return;
        }
        setIsHistorical(false);
        setStatus('');
        if (profile?.uid) {
          const [contexts, allMarkingAssignments, reviewerAssignments] = await Promise.all([
            getTutorAssignedStudentContexts(profile.uid, result.studentId),
            getCompletedPeerMarkingWorkForTutor({ tutorId: profile.uid, studentId: result.studentId, subject: result.subject }).catch(() => []),
            getTutorPeerMarkingAssignments({
              studentId: result.studentId,
              subject: result.subject,
              subjectInstanceId: result.subjectInstanceId,
            }).catch(() => []),
          ]);
          const selectedContext = contexts.find((context) => context.subject === result.subject) ?? null;
          const reviewerAssignment = reviewerAssignments.find((item) => item.reviewerExerciseId === result.id
            && item.reviewerSubjectInstanceId === result.subjectInstanceId
            && item.assignmentDate === result.assignmentDate);
          setPeerWorkAssignment(reviewerAssignment || null);
          setShowPeerWork(false);
          const exerciseWithStudent = {
            ...result,
            studentName: selectedContext?.displayName || selectedContext?.name || selectedContext?.email || 'Student',
            peerMarkingWorkStatus: reviewerAssignment?.status || result.peerMarkingWorkStatus || '',
          };
          setExercise(exerciseWithStudent);
          const markingAssignments = allMarkingAssignments.filter((item) => markingBelongsToExercise(item, exerciseWithStudent));
          const scores = await getStudentTopicScoresForTutor({
            tutorId: profile.uid,
            studentId: result.studentId,
            subject: result.subject,
            contexts: selectedContext ? [selectedContext] : [],
          });
          setTopicScores(scores);
          setAccessRole(selectedContext?.accessRole || 'viewer');
          const topicNames = uniqueTopicNames([
            ...getExerciseTopicNames(exerciseWithStudent),
            ...markingAssignments.flatMap(getPeerMarkingTopicNames),
          ]);
          setCompletedMarkingAssignments(markingAssignments);
          setScoreEntries(await getTopicUnderstandingQuestionScores({
            studentId: exerciseWithStudent.studentId,
            subjectInstanceId: exerciseWithStudent.subjectInstanceId,
            topics: topicNames,
            topicIds: [...new Set([
              ...getQuestionTopicIds(exerciseWithStudent),
              ...markingAssignments.flatMap(getQuestionTopicIds),
            ])],
            sourceIds: [exerciseWithStudent.id, ...markingAssignments.flatMap((item) => [item.id, item.assignmentPath])],
          }).catch(() => []));
        } else {
          setExercise(result);
        }
      })
      .catch((error) => setStatus(error.message || 'Could not load exercise.'))
      .finally(() => setIsLoading(false));
  }, [exerciseId, profile?.uid, periodId, studentId, subjectInstanceId]);

  useEffect(() => {
    if (!exercise?.documentPath || isHistorical) return undefined;
    return subscribeToExerciseAssignment(exercise.documentPath, (latest) => {
      if (latest) setExercise((current) => current ? { ...current, ...latest } : latest);
    }, (error) => setStatus(error.message || 'Could not refresh exercise status.'));
  }, [exercise?.documentPath, isHistorical]);

  const peerWorkAssignmentPath = exercise?.peerMarkingWorkAssignmentPath || peerWorkAssignment?.assignmentPath;
  useEffect(() => {
    if (!peerWorkAssignmentPath || isHistorical) return undefined;
    return subscribeToPeerMarkingAssignmentsAtPaths([peerWorkAssignmentPath], (records) => {
      setPeerWorkAssignment(records[0] || null);
    }, (error) => setStatus(error.message || 'Could not refresh assigned practice work.'));
  }, [peerWorkAssignmentPath, isHistorical]);

  const peerAssignmentPathsKey = JSON.stringify(completedMarkingAssignments.map((item) => item.assignmentPath).filter(Boolean));
  useEffect(() => {
    const paths = JSON.parse(peerAssignmentPathsKey || '[]');
    if (!paths.length || isHistorical) return undefined;
    return subscribeToPeerMarkingAssignmentsAtPaths(paths, (records) => {
      const updated = new Map(records.map((item) => [item.assignmentPath, item]));
      setCompletedMarkingAssignments((current) => current.map((item) => updated.get(item.assignmentPath) ?? item));
    }, (error) => setStatus(error.message || 'Could not refresh peer-marking status.'));
  }, [peerAssignmentPathsKey, isHistorical]);

  const scoreSubscriptionKey = JSON.stringify(exercise && !isHistorical ? {
    studentId: exercise.studentId || studentId,
    subjectInstanceId: exercise.subjectInstanceId,
    topics: uniqueTopicNames([
      ...getExerciseTopicNames(exercise),
      ...completedMarkingAssignments.flatMap(getPeerMarkingTopicNames),
    ]),
    topicIds: [...new Set([
      ...getQuestionTopicIds(exercise),
      ...completedMarkingAssignments.flatMap(getQuestionTopicIds),
    ])],
    sourceIds: [exercise.id, ...completedMarkingAssignments.flatMap((item) => [item.id, item.assignmentPath])],
  } : null);

  useEffect(() => {
    if (!scoreSubscriptionKey || scoreSubscriptionKey === 'null') return undefined;
    return subscribeToTopicUnderstandingQuestionScores(JSON.parse(scoreSubscriptionKey), setScoreEntries,
      (error) => setStatus(error.message || 'Could not refresh understanding scores.'));
  }, [scoreSubscriptionKey]);

  const availability = exercise ? getExerciseAvailability(exercise.assignmentDate, Boolean(exercise.submittedImageUrl || exercise.submitted === 'Yes')) : null;
  const exerciseStatus = exercise ? getExerciseStatusLabels(exercise) : null;
  const assignedPeerWorkImages = peerWorkAssignment?.submittedImages?.length
    ? peerWorkAssignment.submittedImages
    : [peerWorkAssignment?.submittedImageUrl].filter(Boolean);
  const hasSubmittedExercise = Boolean(exercise && (exercise.submissionStatus === 'submitted' || exercise.submitted === 'Yes'
    || exercise.submittedImageUrl || exercise.submittedImages?.length));
  const peerWorkIsCompleted = peerWorkAssignment?.status === 'completed' || exercise?.peerMarkingWorkStatus === 'completed';

  const removeExercise = async () => {
    if (!exercise || !window.confirm(`Delete “${exercise.title || 'this exercise'}”? This cannot be undone.`)) return;
    setIsDeleting(true);
    try {
      await runOperation({ operationName: 'Deleting exercise and uploaded work', successMessage: 'The exercise and its submitted files were deleted.' }, async () => {
        const result = await deleteExerciseAssignmentForTutor({ tutorId: profile.uid, exerciseId: exercise.id });
        await deleteExerciseSubmissionFiles(result.storageUrls);
      });
      navigate(`${basePath}/exercises`, { replace: true });
    } catch (error) {
      setStatus(error.message || 'Could not delete exercise.');
      setIsDeleting(false);
    }
  };

  const retryPeerWork = async () => {
    if (!exercise || !profile?.uid || isRetryingPeerWork) return;
    setIsRetryingPeerWork(true);
    setStatus('');
    try {
      const result = await runOperation({
        operationName: 'Retrying work generation',
        successMessage: 'The work-generation retry has started.',
      }, () => retryPeerMarkingFallbackForTutor({
        studentId: exercise.studentId,
        subjectInstanceId: exercise.subjectInstanceId,
        exerciseId: exercise.id,
      }));
      setExercise((current) => current ? { ...current, peerMarkingWorkStatus: result.status || 'pending' } : current);
      if (result.status === 'not_available') {
        setStatus('No eligible practice work could be generated for this exercise yet. You can retry later.');
      }
    } catch (error) {
      setStatus(error.message || 'Could not retry work generation.');
    } finally {
      setIsRetryingPeerWork(false);
    }
  };

  return (
    <AppShell title="Exercise details" subtitle={exercise ? `${exercise.studentName || 'Student'} • ${exercise.subject} • ${exercise.assignmentDate}` : status} role={role} user={profile} onLogout={logout}>
      {isLoading ? <LoadingState label="Loading exercise, scores, and marking history…" /> : null}
      {status && !isLoading ? <div className="panel p-5 text-sm text-slate-500">{status}</div> : null}
      {isHistorical ? <div className="panel border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800">Historical assignment record · read-only</div> : null}
      {exercise && availability ? (
        <div className="space-y-4">
          <section className="panel grid gap-4 p-5 sm:grid-cols-2">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Student</p>
              <p className="mt-1 text-lg font-bold text-slate-950">{exercise.studentName || 'Student'}</p>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Subject</p>
              <p className="mt-1 text-lg font-bold text-slate-950">{exercise.subject}</p>
            </div>
          </section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link to={`${basePath}/exercises`} className="btn-secondary hidden w-fit lg:inline-flex">Back to exercises</Link>
            {['tutor', 'teacher'].includes(role)
              && ['co-owner', 'marker'].includes(accessRole)
              && !isHistorical
              && (exercise.submissionStatus === 'submitted' || exercise.submitted === 'Yes'
                || Boolean(exercise.submittedImageUrl) || (Array.isArray(exercise.submittedImages) && exercise.submittedImages.length > 0))
              && ['', 'pending', 'not_available', 'fallback_failed', 'failed'].includes(exercise.peerMarkingWorkStatus || '') ? (
              <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={retryPeerWork} disabled={isRetryingPeerWork}>
                {isRetryingPeerWork ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RotateCw className="h-4 w-4" aria-hidden="true" />}
                {isRetryingPeerWork ? 'Retrying…' : 'Retry work generation'}
              </button>
            ) : null}
            {['tutor', 'teacher'].includes(role)
              && ['co-owner', 'marker'].includes(accessRole)
              && !isHistorical
              && hasSubmittedExercise
              && !peerWorkIsCompleted ? (
              <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={() => setShowPeerWork((current) => !current)} disabled={!assignedPeerWorkImages.length}>
                <Eye className="h-4 w-4" aria-hidden="true" />
                {assignedPeerWorkImages.length ? (showPeerWork ? 'Hide assigned work' : 'View assigned work') : 'Assigned work pending'}
              </button>
            ) : null}
            {accessRole === 'co-owner' && !isHistorical && !exerciseStatus?.isToday ? <button type="button" className="hidden btn-secondary inline-flex items-center gap-2 text-rose-300" onClick={removeExercise} disabled={isDeleting}>
              <Trash2 className="h-4 w-4" aria-hidden="true" /> {isDeleting ? 'Deleting...' : 'Delete exercise'}
            </button> : null}
          </div>
          {showPeerWork && assignedPeerWorkImages.length ? (
            <section className="panel space-y-3 p-5" aria-label="System-generated work assigned for peer marking">
              <h2 className="text-lg font-bold text-slate-900">Work assigned for peer marking</h2>
              <ImagePageViewer images={assignedPeerWorkImages} title="System-generated practice work" alt="Work assigned to the student for peer marking" />
            </section>
          ) : null}
          <ExerciseCard
            exercise={exercise}
            availability={availability}
            paymentLocked={false}
            studentId={exercise.studentId}
            tutorId={profile?.uid}
            topicScores={topicScores}
            scoreEntries={scoreEntries}
            completedMarkingAssignments={completedMarkingAssignments}
            onTopicScoreSaved={(topic, score) => setTopicScores((current) => ({ ...current, [topic]: score }))}
            showQuestionLinks
            viewerRole={role}
            accessRole={accessRole}
            isHistorical={isHistorical}
          />
        </div>
      ) : null}
    </AppShell>
  );
};
