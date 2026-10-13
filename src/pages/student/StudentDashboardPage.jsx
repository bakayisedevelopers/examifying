import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, CreditCard } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { HomeExerciseCard } from '../../components/dashboard/HomeExerciseCard';
import { ExerciseActivityCalendar } from '../../components/dashboard/ExerciseActivityCalendar';
import { MultiSelectDropdown } from '../../components/common/MultiSelectDropdown';
import { getLocalDateKey, shiftDateKey } from '../../utils/dateKey';
import { useAuth } from '../../hooks/useAuth';
import { useScreenLoadMetrics } from '../../hooks/useScreenLoadMetrics';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import { useStudentSubscriptionState } from '../../hooks/useStudentSubscriptionState';
import { getSubjectsAvailableForGrade } from '../../../functions/src/subjects.js';
import {
  addStudentSubjects,
  generateExercisePlanIfEligible,
  getActiveSubjectEpisodesForStudent,
  getGlobalSubjects,
  getCompletedPeerMarkingAssignmentsForCalendar,
  getPeerMarkingAssignmentsForStudent,
  getStudentExerciseCalendarBounds,
  getStudentExerciseCalendarWindow,
  getStudentAccessState,
  getStudentEntitlementState,
  subscribeToTodayExercisesForStudent,
  subscribeToExerciseGenerationStatus,
} from '../../services/firestoreService';
import { getCachedStudentSubscriptionState, loadStudentSubscriptionState } from '../../services/studentSubscriptionStateStore';
import { getCachedStudentDashboardState, updateCachedStudentDashboardState } from '../../services/studentDashboardStateStore';

const ReadinessChecklist = ({ rows, studentName }) => {
  const unmetRows = rows.filter((row) => Object.values(row.checks ?? {}).some((passed) => !passed));
  if (!unmetRows.length) return null;
  const labels = {
    paidSubscriptionActive: 'Paid subscription active',
    minimumQuestionPaperCountMet: 'At least 2 analyzed papers available',
    lessonCompleted: 'At least 1 completed topic lesson logged',
    initialGenerationExists: 'Initial AI plan already generated',
  };
  return (
    <div className="panel space-y-4 p-5">
      <div>
        <h2 className="text-xl font-bold text-slate-950">Subjects missing requirements</h2>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {unmetRows.map((row) => (
          <details key={`${row.subject}-${row.mode}`} className="group rounded-2xl bg-slate-50 p-4">
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
              <span className="min-w-0 font-semibold text-slate-950">{studentName} • {row.subject}</span>
              <span className="flex items-center gap-2"><span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">{Object.values(row.checks).filter((passed) => !passed).length ? `${Object.values(row.checks).filter((passed) => !passed).length} missing` : 'Ready'}</span><ChevronDown className="h-4 w-4 text-slate-500 transition-transform group-open:rotate-180" aria-hidden="true" /></span>
            </summary>
            <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
              {Object.entries(row.checks).map(([key, passed]) => (
                <div key={key} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-600">{labels[key] ?? key}</span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${passed ? 'bg-lime-400/15 text-lime-300 border border-lime-400/30' : 'bg-amber-400/15 text-amber-300 border border-amber-400/30'}`}>{passed ? 'Done' : 'Missing'}</span>
                </div>
              ))}
              {row.reason ? <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs font-medium text-amber-300">{row.reason}</p> : null}
              <p className="text-xs text-slate-500">Papers available: {row.availablePaperCount}. Completed lessons: {row.completedLessonCount}.</p>
            </div>
          </details>
        ))}
      </div>
    </div>
  );
};

export const StudentDashboardPage = () => {
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const { runOperation } = useOperationStatus();
  const subscriptionState = useStudentSubscriptionState(profile);
  const cachedDashboardState = getCachedStudentDashboardState(profile?.uid);
  const cachedSubscriptionState = getCachedStudentSubscriptionState(profile?.uid);
  const hasCachedAccessState = Boolean(cachedDashboardState?.accessChecked || cachedSubscriptionState);
  const [lastAppData, setLastAppData] = useState(() => cachedDashboardState ? { uid: profile?.uid, ...cachedDashboardState } : null);
  const visibleLastAppData = lastAppData?.uid === profile?.uid ? lastAppData : null;
  const saveLastAppData = useCallback((patch) => {
    if (!profile?.uid) return;
    const next = updateCachedStudentDashboardState(profile.uid, patch);
    setLastAppData({ uid: profile.uid, ...next });
  }, [profile?.uid]);
  const [availableSubjects, setAvailableSubjects] = useState(() => cachedDashboardState?.availableSubjects ?? []);
  const [availableSubjectEpisodes, setAvailableSubjectEpisodes] = useState(() => cachedDashboardState?.availableSubjectEpisodes ?? []);
  const [isLoadingSubjects, setIsLoadingSubjects] = useState(() => !cachedDashboardState?.subjectsLoaded);
  const [todayExercises, setTodayExercises] = useState(() => cachedDashboardState?.todayExercises ?? []);
  const todayExercisesRef = useRef(cachedDashboardState?.todayExercises ?? []);
  const [peerAssignments, setPeerAssignments] = useState(() => cachedDashboardState?.peerAssignments ?? []);
  const [calendarWeekStart, setCalendarWeekStart] = useState(() => shiftDateKey(getLocalDateKey(), -6));
  const [exerciseCalendarBounds, setExerciseCalendarBounds] = useState(null);
  const [calendarExercises, setCalendarExercises] = useState([]);
  const [completedCalendarMarking, setCompletedCalendarMarking] = useState([]);
  const [isLoadingCalendar, setIsLoadingCalendar] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [paymentLocked, setPaymentLocked] = useState(() => cachedDashboardState?.paymentLocked ?? true);
  const [isLoadingExercises, setIsLoadingExercises] = useState(() => !cachedDashboardState?.exercisesLoaded);
  const [isCheckingAccess, setIsCheckingAccess] = useState(() => !hasCachedAccessState);
  const [isGenerating, setIsGenerating] = useState(false);
  const [readinessRows, setReadinessRows] = useState(() => cachedDashboardState?.readinessRows ?? []);
  const [generationStatuses, setGenerationStatuses] = useState({});
  const [initialRetrySubjects, setInitialRetrySubjects] = useState([]);
  const [retryingInitialSubject, setRetryingInitialSubject] = useState('');
  const [globalSubjects, setGlobalSubjects] = useState([]);
  const [globalSubjectsLoading, setGlobalSubjectsLoading] = useState(true);
  const [homeSelectedSubjects, setHomeSelectedSubjects] = useState([]);
  const [savingHomeSubjects, setSavingHomeSubjects] = useState(false);
  const [homeSubjectStatus, setHomeSubjectStatus] = useState('');
  const localGenerationSubjectsRef = useRef(new Set());
  const backgroundGenerationOperationsRef = useRef(new Map());
  const [subscriptionPlanId, setSubscriptionPlanId] = useState(() => cachedDashboardState?.subscriptionPlanId ?? cachedSubscriptionState?.subscriptionPlanId ?? 'free');
  const [subscriptionPlanName, setSubscriptionPlanName] = useState(() => cachedDashboardState?.subscriptionPlanName ?? cachedSubscriptionState?.subscriptionPlanName ?? 'Free');
  const [requiresSubscriptionSelection, setRequiresSubscriptionSelection] = useState(() => cachedDashboardState?.requiresSubscriptionSelection ?? cachedSubscriptionState?.requiresSubscriptionSelection ?? true);
  const subjectLimit = Number(subscriptionState?.subscriptionSubjectCount) || 0;
  const remainingHomeSubjectSlots = Math.max(0, subjectLimit - availableSubjects.length);
  const homeSubjectOptions = useMemo(() => getSubjectsAvailableForGrade(profile?.grade, globalSubjects)
    .filter((subject) => !availableSubjects.includes(subject)), [availableSubjects, globalSubjects, profile?.grade]);

  useEffect(() => {
    let active = true;
    getGlobalSubjects().then((subjects) => {
      if (active) setGlobalSubjects(subjects);
    }).catch((error) => {
      if (active) setHomeSubjectStatus(error.message || 'Could not load available subjects.');
    }).finally(() => {
      if (active) setGlobalSubjectsLoading(false);
    });
    return () => { active = false; };
  }, []);

  const handleHomeSubjectSelectionChange = (subjects) => {
    if (subjects.length > remainingHomeSubjectSlots) {
      setHomeSubjectStatus(`Your subscription includes up to ${subjectLimit} subjects.`);
      return;
    }
    setHomeSelectedSubjects(subjects);
    setHomeSubjectStatus('');
  };

  const saveHomeSubjects = async () => {
    if (!profile?.uid || !homeSelectedSubjects.length) return;
    if (!subscriptionState?.paymentCompleted || availableSubjects.length + homeSelectedSubjects.length > subjectLimit) {
      setHomeSubjectStatus(`Your active subscription allows up to ${subjectLimit} subjects.`);
      return;
    }
    setSavingHomeSubjects(true);
    setHomeSubjectStatus('');
    try {
      await runOperation({ operationName: 'Adding subjects', successMessage: 'Your subjects were updated.' }, async () => {
        await addStudentSubjects({ studentId: profile.uid, subjects: homeSelectedSubjects });
        const episodes = await getActiveSubjectEpisodesForStudent(profile.uid);
        const subjects = [...new Set(episodes.map((episode) => episode.subjectKey).filter(Boolean))].sort();
        setAvailableSubjectEpisodes(episodes);
        setAvailableSubjects(subjects);
        saveLastAppData({ availableSubjects: subjects, availableSubjectEpisodes: episodes, subjectsLoaded: true });
      });
      setHomeSelectedSubjects([]);
    } catch (error) {
      setHomeSubjectStatus(error.message || 'Could not add the selected subjects.');
    } finally {
      setSavingHomeSubjects(false);
    }
  };

  useEffect(() => {
    const snapshot = getCachedStudentDashboardState(profile?.uid);
    if (!snapshot) {
      setLastAppData(null);
      if (profile?.uid) {
        const currentSubscription = getCachedStudentSubscriptionState(profile.uid);
        setAvailableSubjects([]);
        setAvailableSubjectEpisodes([]);
        setTodayExercises([]);
        todayExercisesRef.current = [];
        setPeerAssignments([]);
        setReadinessRows([]);
        setIsLoadingSubjects(true);
        setIsLoadingExercises(true);
        setPaymentLocked(currentSubscription ? !currentSubscription.paymentCompleted : true);
        setSubscriptionPlanId(currentSubscription?.subscriptionPlanId ?? 'free');
        setSubscriptionPlanName(currentSubscription?.subscriptionPlanName ?? 'Free');
        setRequiresSubscriptionSelection(currentSubscription?.requiresSubscriptionSelection ?? true);
        setIsCheckingAccess(!currentSubscription);
      }
      return;
    }
    setLastAppData({ uid: profile.uid, ...snapshot });
    setAvailableSubjects(snapshot.availableSubjects ?? []);
    setAvailableSubjectEpisodes(snapshot.availableSubjectEpisodes ?? []);
    setIsLoadingSubjects(!snapshot.subjectsLoaded);
    setTodayExercises(snapshot.todayExercises ?? []);
    todayExercisesRef.current = snapshot.todayExercises ?? [];
    setPeerAssignments(snapshot.peerAssignments ?? []);
    setReadinessRows(snapshot.readinessRows ?? []);
    setSubscriptionPlanId(snapshot.subscriptionPlanId ?? 'free');
    setSubscriptionPlanName(snapshot.subscriptionPlanName ?? 'Free');
    setRequiresSubscriptionSelection(snapshot.requiresSubscriptionSelection ?? true);
    setPaymentLocked(snapshot.paymentLocked ?? true);
    setIsLoadingExercises(!snapshot.exercisesLoaded);
  }, [profile?.uid]);

  useScreenLoadMetrics(
    'Student Home',
    'student',
    !isLoadingSubjects && !isCheckingAccess && !isLoadingExercises,
  );

  useEffect(() => {
    let active = true;
    if (!profile?.uid) {
      setAvailableSubjects([]);
      setAvailableSubjectEpisodes([]);
      setIsLoadingSubjects(false);
      return undefined;
    }
    const cachedState = getCachedStudentDashboardState(profile.uid);
    setIsLoadingSubjects(!cachedState?.subjectsLoaded);
    getActiveSubjectEpisodesForStudent(profile.uid)
      .then((episodes) => {
        if (!active) return;
        const subjects = [...new Set(episodes.map((episode) => episode.subjectKey).filter(Boolean))].sort();
        const episodeSignature = (items = []) => JSON.stringify([...items]
          .map((episode) => ({
            id: episode.id,
            studentId: episode.studentId,
            subjectKey: episode.subjectKey,
            status: episode.status,
            accessRole: episode.accessRole,
          }))
          .sort((left, right) => String(left.id).localeCompare(String(right.id))));
        if (episodeSignature(cachedState?.availableSubjectEpisodes) !== episodeSignature(episodes)) {
          setAvailableSubjectEpisodes(episodes);
        }
        if (JSON.stringify(cachedState?.availableSubjects ?? []) !== JSON.stringify(subjects)) {
          setAvailableSubjects(subjects);
        }
        saveLastAppData({ availableSubjects: subjects, availableSubjectEpisodes: episodes, subjectsLoaded: true });
        setIsLoadingSubjects(false);
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(error.message || 'Could not load your active subjects.');
        setIsLoadingSubjects(false);
      });
    return () => { active = false; };
  }, [profile?.uid, saveLastAppData]);

  useEffect(() => {
    if (!profile?.uid || isLoadingSubjects) return undefined;
    if (!availableSubjectEpisodes.length) {
      setTodayExercises([]);
      todayExercisesRef.current = [];
      saveLastAppData({ todayExercises: [], exercisesLoaded: true });
      setIsLoadingExercises(false);
      return undefined;
    }

    return subscribeToTodayExercisesForStudent(profile.uid, availableSubjectEpisodes, (exercises) => {
      todayExercisesRef.current = exercises;
      setTodayExercises(exercises);
      saveLastAppData({ todayExercises: exercises, exercisesLoaded: true });
      setIsLoadingExercises(false);
    }, (error) => {
      setLoadError((current) => current || error?.message || 'Today’s exercises could not be refreshed.');
      setIsLoadingExercises(false);
    });
  }, [availableSubjectEpisodes, isLoadingSubjects, profile?.uid, saveLastAppData]);

  useEffect(() => {
    const today = getLocalDateKey();
    if (today < calendarWeekStart || today > shiftDateKey(calendarWeekStart, 6)) return;
    setCalendarExercises((current) => [
      ...current.filter((exercise) => String(exercise.assignmentDate ?? '').slice(0, 10) !== today),
      ...todayExercises,
    ].sort((left, right) => String(left.assignmentDate ?? '').localeCompare(String(right.assignmentDate ?? ''))));
  }, [calendarWeekStart, todayExercises]);

  useEffect(() => {
    let active = true;
    if (!profile?.uid || isLoadingSubjects) return undefined;
    if (!availableSubjectEpisodes.length) {
      setExerciseCalendarBounds({ earliestDate: '', latestDate: '', subjectBounds: {} });
      return undefined;
    }
    getStudentExerciseCalendarBounds(profile.uid, availableSubjectEpisodes)
      .then((bounds) => { if (active) setExerciseCalendarBounds(bounds); })
      .catch((error) => {
        if (active) setLoadError((current) => current || error?.message || 'Exercise history dates could not be loaded.');
      });
    return () => { active = false; };
  }, [availableSubjectEpisodes, isLoadingSubjects, profile?.uid]);

  useEffect(() => {
    let active = true;
    if (!profile?.uid || isLoadingSubjects) return undefined;
    if (!availableSubjectEpisodes.length) {
      setCalendarExercises([]);
      setCompletedCalendarMarking([]);
      setIsLoadingCalendar(false);
      return undefined;
    }

    const weekEnd = shiftDateKey(calendarWeekStart, 6);
    setIsLoadingCalendar(true);
    Promise.all([
      getStudentExerciseCalendarWindow({
        studentId: profile.uid,
        subjectEpisodes: availableSubjectEpisodes,
        startDate: calendarWeekStart,
        endDate: weekEnd,
      }),
      getCompletedPeerMarkingAssignmentsForCalendar({
        reviewerId: profile.uid,
        startDate: calendarWeekStart,
        endDate: weekEnd,
        subjectInstanceIds: availableSubjectEpisodes.map((episode) => episode.id),
      }).catch(() => {
        if (active) setLoadError((current) => current || 'Completed marking activity could not be refreshed.');
        return [];
      }),
    ]).then(([exercises, completedMarking]) => {
      if (!active) return;
      const today = getLocalDateKey();
      const todayIsVisible = today >= calendarWeekStart && today <= weekEnd;
      const currentWeekExercises = todayIsVisible
        ? [...exercises.filter((exercise) => String(exercise.assignmentDate ?? '').slice(0, 10) !== today), ...todayExercisesRef.current]
        : exercises;
      setCalendarExercises(currentWeekExercises);
      setCompletedCalendarMarking(completedMarking);
    }).catch((error) => {
      if (active) {
        setLoadError((current) => current || error?.message || 'Exercise activity could not be loaded.');
      }
    }).finally(() => {
      if (active) setIsLoadingCalendar(false);
    });

    return () => { active = false; };
  }, [availableSubjectEpisodes, calendarWeekStart, isLoadingSubjects, profile?.uid, saveLastAppData]);

  useEffect(() => {
    if (!profile?.uid) return undefined;
    const generationOperations = backgroundGenerationOperationsRef.current;
    const unsubscribes = availableSubjects.map((subject) => {
      const episode = availableSubjectEpisodes.find((item) => item.studentId === profile.uid && item.subjectKey === subject);
      return subscribeToExerciseGenerationStatus(profile.uid, subject, (status) => {
        setGenerationStatuses((current) => ({ ...current, [subject]: status }));
        if (!status) return;

        const episodeId = episode?.id ?? subject;
        const currentOperation = generationOperations.get(episodeId);
        const runId = status.startedAtMs ?? status.generationRunId ?? null;
        if (status.status === 'processing') {
          setReadinessRows((current) => {
            const next = current.filter((row) => row.subject !== subject);
            if (next.length !== current.length) saveLastAppData({ readinessRows: next });
            return next;
          });
          setInitialRetrySubjects((current) => current.filter((item) => item !== subject));

          if (localGenerationSubjectsRef.current.has(subject)) return;
          if (currentOperation && currentOperation.runId === runId) return;
          currentOperation?.resolve({ superseded: true });

          let resolveOperation;
          let rejectOperation;
          const operationPromise = new Promise((resolve, reject) => {
            resolveOperation = resolve;
            rejectOperation = reject;
          });
          generationOperations.set(episodeId, {
            runId,
            resolve: resolveOperation,
            reject: rejectOperation,
          });
          runOperation({
            operationName: `Generating ${subject} exercises`,
            successMessage: 'Exercise generation has finished.',
            failureMessage: 'Could not generate the exercise plan.',
            autoDismissMs: 1800,
            showProgress: true,
          }, () => operationPromise).catch(() => {});
          return;
        }

        if (status.status === 'completed' || status.status === 'failed') {
          if (status.status === 'completed') {
            setReadinessRows((current) => {
              const next = current.filter((row) => row.subject !== subject);
              if (next.length !== current.length) saveLastAppData({ readinessRows: next });
              return next;
            });
            setInitialRetrySubjects((current) => current.filter((item) => item !== subject));
          } else if (status.lastTrigger === 'initial') {
            setInitialRetrySubjects((current) => current.includes(subject) ? current : [...current, subject]);
          }

          const operation = generationOperations.get(episodeId);
          if (operation && (operation.runId == null || runId == null || operation.runId === runId)) {
            generationOperations.delete(episodeId);
            if (status.status === 'completed') operation.resolve();
            else operation.reject(new Error(status.message || 'Exercise generation did not complete.'));
          }
        }
      }, episode?.id ?? null);
    });
    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      generationOperations.forEach((operation) => operation.resolve());
      generationOperations.clear();
    };
  }, [profile?.uid, availableSubjects, availableSubjectEpisodes, runOperation, saveLastAppData]);

  useEffect(() => {
    let active = true;

    const runGeneratePlan = async (subject, mode) => {
      setIsGenerating(true);
      setReadinessRows((current) => {
        const next = current.filter((row) => row.subject !== subject);
        if (next.length !== current.length) saveLastAppData({ readinessRows: next });
        return next;
      });
      localGenerationSubjectsRef.current.add(subject);
      try {
        return await runOperation({
          operationName: `Generating ${subject} exercises`,
          successMessage: 'Exercise generation has finished.',
          failureMessage: 'Could not generate the exercise plan.',
          autoDismissMs: 1800,
          showProgress: true,
        }, async () => {
          const result = await generateExercisePlanIfEligible({ student: profile, mode, subject });
          if (!result?.generated) throw new Error(result?.reason || 'Exercise generation did not produce assignments.');
          return result;
        });
      } catch (error) {
        return { generated: false, reason: error?.message || 'Exercise generation failed.' };
      } finally {
        localGenerationSubjectsRef.current.delete(subject);
      }
    };

    const load = async () => {
      if (!profile?.uid || isLoadingSubjects) return;
      try {
        setLoadError('');
        const previousData = getCachedStudentDashboardState(profile.uid);
        if (!previousData) setPaymentLocked(true);
        setIsLoadingExercises(!previousData?.exercisesLoaded);
        setIsCheckingAccess(true);
        setInitialRetrySubjects([]);
        const readiness = [];
        const subjectsToCheck = availableSubjects;
        const sharedSubscriptionState = loadStudentSubscriptionState(profile, { force: true });
        getPeerMarkingAssignmentsForStudent(profile.uid)
          .then((rows) => {
            if (active) {
              setPeerAssignments(rows);
              saveLastAppData({ peerAssignments: rows, peerAssignmentsLoaded: true });
            }
            return rows;
          })
          .catch((error) => {
            if (active) {
              setLoadError((current) => current || error?.message || 'Marking work could not be loaded yet.');
            }
            return [];
          });
        const entitlementStates = await Promise.all(subjectsToCheck.map((subject) =>
          getStudentEntitlementState(
            profile,
            subject,
            availableSubjectEpisodes.find((episode) => episode.studentId === profile.uid && episode.subjectKey === subject) ?? null,
            sharedSubscriptionState,
          ).then((access) => ({ subject, access })),
        ));
        if (!active) return;
        const effectiveSubscription = entitlementStates[0]?.access ?? await sharedSubscriptionState;
        setSubscriptionPlanId(effectiveSubscription.subscriptionPlanId || 'free');
        setSubscriptionPlanName(effectiveSubscription.subscriptionPlanName || 'Free');
        setRequiresSubscriptionSelection(Boolean(effectiveSubscription.requiresSubscriptionSelection));
        const anyPaidSubject = entitlementStates.some(({ access }) => Boolean(access.paidSubscriptionActive));
        setPaymentLocked(!anyPaidSubject);
        setIsCheckingAccess(false);
        saveLastAppData({
          subscriptionPlanId: effectiveSubscription.subscriptionPlanId || 'free',
          subscriptionPlanName: effectiveSubscription.subscriptionPlanName || 'Free',
          requiresSubscriptionSelection: Boolean(effectiveSubscription.requiresSubscriptionSelection),
          paymentLocked: !anyPaidSubject,
          accessChecked: true,
        });
        if (!anyPaidSubject) {
          setReadinessRows([]);
          saveLastAppData({ readinessRows: [] });
          setInitialRetrySubjects([]);
          return;
        }

        try {
          const accessStates = await Promise.all(subjectsToCheck.map((subject) =>
            getStudentAccessState(
              profile,
              subject,
              availableSubjectEpisodes.find((episode) => episode.studentId === profile.uid && episode.subjectKey === subject) ?? null,
              sharedSubscriptionState,
            ).then((access) => ({ subject, access })),
          ));
          if (!active) return;
          setInitialRetrySubjects(accessStates
            .filter(({ access }) => access.paidSubscriptionActive
              && !access.hasInitialGeneration
              && access.initialGenerationReady
              && access.generationRunStatus?.lastTrigger === 'initial'
              && access.generationRunStatus?.status === 'failed')
            .map(({ subject }) => subject));

          for (const { subject, access } of accessStates) {
            const initialWasAttempted = access.generationRunStatus?.lastTrigger === 'initial'
              && ['completed', 'failed'].includes(access.generationRunStatus?.status);
            const generationIsProcessing = access.generationRunStatus?.status === 'processing';
            const shouldGenerate = access.paidSubscriptionActive
              && !access.hasInitialGeneration
              && access.initialGenerationReady
              && !initialWasAttempted
              && !generationIsProcessing;
            if (shouldGenerate) {
              const result = await runGeneratePlan(subject, 'initial');
              if (!result?.generated) {
                const resultStatus = result?.criteria?.initial ?? access.generationStatus?.initial;
                readiness.push({
                  subject,
                  mode: 'initial',
                  checks: resultStatus?.checks ?? access.generationStatus?.initial?.checks ?? {},
                  availablePaperCount: result?.criteria?.analyzedPaperCount ?? access.matchingQuestionPapers?.length ?? 0,
                  completedLessonCount: access.completedLessons?.length ?? 0,
                  reason: result?.reason ?? 'Generation did not complete.',
                });
              }
            } else if (!generationIsProcessing && !access.hasInitialGeneration && !access.generationStatus?.initial?.ready) {
              readiness.push({ subject, mode: 'initial', checks: access.generationStatus?.initial?.checks ?? {}, availablePaperCount: access.matchingQuestionPapers?.length ?? 0, completedLessonCount: access.completedLessons?.length ?? 0 });
            }
          }

          if (!active) return;
          setReadinessRows(readiness);
          saveLastAppData({ readinessRows: readiness });
        } catch (error) {
          if (active) setLoadError((current) => current || error?.message || 'Subject readiness could not be loaded yet.');
        }
      } catch (error) {
        if (!active) return;
        const previousData = getCachedStudentDashboardState(profile?.uid);
        if (!previousData) {
          setTodayExercises([]);
          setReadinessRows([]);
          setInitialRetrySubjects([]);
          setSubscriptionPlanId('free');
          setSubscriptionPlanName('Free');
          setRequiresSubscriptionSelection(true);
          setPaymentLocked(true);
        }
        setIsLoadingExercises(false);
        setIsCheckingAccess(false);
        setLoadError(error?.message ?? 'Some exercises could not be loaded yet.');
      } finally {
        if (active) setTimeout(() => setIsGenerating(false), 500);
      }
    };

    load();
    return () => { active = false; };
  }, [availableSubjects, availableSubjectEpisodes, isLoadingSubjects, profile, runOperation, saveLastAppData]);

  const retryInitialGeneration = async (subject) => {
    if (!subject || retryingInitialSubject) return;
    setRetryingInitialSubject(subject);
    setIsGenerating(true);
    setReadinessRows((current) => {
      const next = current.filter((row) => row.subject !== subject);
      if (next.length !== current.length) saveLastAppData({ readinessRows: next });
      return next;
    });
    localGenerationSubjectsRef.current.add(subject);
    try {
      const result = await runOperation({
        operationName: `Generating ${subject} exercises`,
        successMessage: 'Exercise generation has finished.',
        failureMessage: 'Initial exercise generation failed.',
        autoDismissMs: 1800,
        showProgress: true,
      }, async () => {
        const generated = await generateExercisePlanIfEligible({ student: profile, mode: 'initial', subject });
        if (!generated?.generated) throw new Error(generated?.reason || 'Initial exercise generation did not produce assignments.');
        return generated;
      });
      if (!result.generated) return;

      setInitialRetrySubjects((current) => current.filter((item) => item !== subject));
      setReadinessRows((current) => current.filter((row) => row.subject !== subject));
      saveLastAppData({ readinessRows: readinessRows.filter((row) => row.subject !== subject) });
    } catch (error) {
      setLoadError(error.message || 'Initial generation failed.');
    } finally {
      localGenerationSubjectsRef.current.delete(subject);
      setRetryingInitialSubject('');
      setTimeout(() => setIsGenerating(false), 500);
    }
  };

  if (subscriptionPlanId === 'free' && (hasCachedAccessState || !isCheckingAccess)) {
    return (
      <AppShell
        title="Past papers"
        subtitle="Your Free plan includes access to question papers."
        role="student"
        user={profile}
        onLogout={logout}
      >
        {isCheckingAccess ? <p className="inline-flex items-center gap-2 text-sm text-slate-300" role="status"><span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-lime-300 border-r-transparent" aria-hidden="true" />Refreshing your subscription status in the background.</p> : null}
        <section className="panel mx-auto max-w-3xl space-y-4 p-6">
          <div>
            <p className="text-sm font-semibold text-lime-700">Current plan: {subscriptionPlanName}</p>
            <h2 className="mt-2 text-xl font-bold text-slate-950">
              {requiresSubscriptionSelection ? 'Choose a subscription to unlock the Examifying Program' : 'Your Free plan is active'}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {requiresSubscriptionSelection
                ? 'Your account is on Free for now. Past papers remain available; choose Circle or Personalized and complete payment to unlock exercises, lessons, peer marking, and subject selection.'
                : 'Past papers remain available on Free. Choose Circle or Personalized and complete payment to unlock the Examifying Program.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-primary inline-flex items-center gap-2" onClick={() => navigate('/student/billing')}>
              <CreditCard className="h-4 w-4" aria-hidden="true" />
              View subscriptions
            </button>
            <button type="button" className="btn-secondary" onClick={() => navigate('/student/papers')}>Browse Past Papers</button>
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Today’s exercises"
      subtitle="Open today’s exercise, view the exact question pages, and submit your work from the exercise details page."
      role="student"
      user={profile}
      onLogout={logout}
    >
      {loadError ? <div className="panel p-4 text-sm text-amber-700">{loadError}</div> : null}
      {isCheckingAccess && (visibleLastAppData?.accessChecked || hasCachedAccessState) ? <p className="inline-flex items-center gap-2 text-xs font-medium text-slate-300" role="status"><span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-lime-300 border-r-transparent" aria-hidden="true" />Refreshing subscription and access in the background; showing your last loaded data.</p> : null}
      {!availableSubjects.length && !requiresSubscriptionSelection && !globalSubjectsLoading && !homeSubjectOptions.length ? (
        <div className="panel p-5 text-sm text-slate-600">
          No additional subjects are available for your grade and subscription. <button type="button" className="ml-1 font-semibold text-brand-700 underline" onClick={() => navigate('/student/profile/subjects')}>Manage subjects</button>
        </div>
      ) : null}

      {subscriptionState?.paymentCompleted && remainingHomeSubjectSlots > 0 ? (
        <section className="panel space-y-4 p-5" aria-labelledby="home-subject-picker-title">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 id="home-subject-picker-title" className="text-lg font-bold text-slate-950">Add subjects</h2>
              <p className="mt-1 text-sm text-slate-500">Choose up to {remainingHomeSubjectSlots} more subject{remainingHomeSubjectSlots === 1 ? '' : 's'} on your plan.</p>
            </div>
            <span className="rounded-full bg-lime-100 px-3 py-1 text-xs font-semibold text-lime-800">{availableSubjects.length} of {subjectLimit} selected</span>
          </div>
          <MultiSelectDropdown
            choices={homeSubjectOptions}
            selectedValues={homeSelectedSubjects}
            onChange={handleHomeSubjectSelectionChange}
            maxSelections={remainingHomeSubjectSlots}
            placeholder={globalSubjectsLoading ? 'Loading subjects…' : !profile?.grade ? 'Set your grade to see eligible subjects' : 'Select one or more subjects'}
            emptyMessage={globalSubjectsLoading ? 'Loading subjects…' : `No additional subjects available for ${profile?.grade || 'your grade'}`}
            ariaLabel="Choose subjects to add from Home"
            disabled={globalSubjectsLoading || !profile?.grade || !homeSubjectOptions.length || savingHomeSubjects}
          />
          <div className="min-h-14 rounded-xl bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Selected subjects</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {homeSelectedSubjects.length ? homeSelectedSubjects.map((subject) => (
                <button key={subject} type="button" className="rounded-full border border-lime-500/50 px-3 py-1 text-sm font-semibold text-slate-800 hover:bg-lime-100" onClick={() => handleHomeSubjectSelectionChange(homeSelectedSubjects.filter((item) => item !== subject))} disabled={savingHomeSubjects} aria-label={`Remove ${subject}`}>
                  {subject} ×
                </button>
              )) : <span className="text-sm text-slate-500">Subjects you choose will appear here immediately.</span>}
            </div>
          </div>
          {homeSubjectStatus ? <p className="text-sm text-rose-700" role="alert">{homeSubjectStatus}</p> : null}
          <button type="button" className="btn-primary" onClick={saveHomeSubjects} disabled={savingHomeSubjects || !homeSelectedSubjects.length}>
            {savingHomeSubjects ? 'Saving subjects…' : 'Save subjects'}
          </button>
        </section>
      ) : null}

      {initialRetrySubjects.map((subject) => (
        <div key={`generation-retry-${subject}`} role="status" className="panel flex flex-wrap items-center justify-between gap-3 border border-rose-400/30 bg-rose-400/10 p-4">
          <div>
            <p className="font-semibold text-rose-900">{subject} exercises could not be generated.</p>
            {generationStatuses[subject]?.message ? <p className="mt-1 text-sm text-rose-800">{generationStatuses[subject].message}</p> : null}
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => retryInitialGeneration(subject)}
            disabled={Boolean(retryingInitialSubject)}
          >
            {retryingInitialSubject === subject ? 'Retrying initial generation…' : 'Retry initial generation'}
          </button>
        </div>
      ))}

      <section className="space-y-4">
        <div className="rounded-2xl bg-gradient-to-r from-lime-300 via-lime-400 to-emerald-400 p-5 text-slate-950 shadow-soft sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-950/70">Exercises</p>
          <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Work to Complete</h2>
          <ExerciseActivityCalendar
            weekStart={calendarWeekStart}
            bounds={exerciseCalendarBounds}
            exercises={calendarExercises}
            assignedMarking={peerAssignments}
            completedMarking={completedCalendarMarking}
            activeSubjectInstanceIds={availableSubjectEpisodes.map((episode) => episode.id)}
            loading={isLoadingCalendar}
            onWeekChange={setCalendarWeekStart}
          />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {(isLoadingExercises || (isCheckingAccess && !hasCachedAccessState)) && !todayExercises.length ? (
            <LoadingState className="col-span-full min-h-40" label="Loading today’s exercises…" />
          ) : isGenerating && !todayExercises.length ? null : !paymentLocked && todayExercises.length ? todayExercises.map((exercise) => (
            <HomeExerciseCard key={exercise.id} exercise={exercise} onOpen={() => {
              const params = new URLSearchParams();
              if (exercise.subjectInstanceId) params.set('subjectInstanceId', exercise.subjectInstanceId);
              navigate(`/student/exercises/${exercise.id}${params.size ? `?${params.toString()}` : ''}`);
            }} />
          )) : (
            <div className="panel col-span-full flex min-h-40 items-center justify-center p-6 text-center text-sm text-slate-500">
              {paymentLocked ? 'Exercises are locked until payment is complete.' : 'No exercises have been assigned for today yet.'}
            </div>
          )}
        </div>
        <ReadinessChecklist rows={readinessRows} studentName={profile?.displayName || profile?.name || profile?.email || 'Student'} />
      </section>

    </AppShell>
  );
};
