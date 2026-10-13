import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { ExerciseActivityCalendar } from '../../components/dashboard/ExerciseActivityCalendar';
import { HomeExerciseCard } from '../../components/dashboard/HomeExerciseCard';
import { useAuth } from '../../hooks/useAuth';
import {
  getTutorAssignedStudentContexts,
  getTutorExerciseCalendarBounds,
  getTutorExerciseCalendarWindow,
  getTutorExerciseWorkRecords,
} from '../../services/firestoreService';
import { getTutorCalendarDateStatus, getTutorExerciseCompletionKey, getTutorExerciseCompletionStatus } from '../../utils/tutorExerciseCompletion';
import { getLocalDateKey, shiftDateKey } from '../../utils/dateKey';
import { useEffectiveRole } from '../../utils/effectiveRole';
import { warmNavigationRoute } from '../../routes/preloadNavigationRoute';

const buildCompletionStatuses = (exercises, workRecords) => Object.fromEntries(exercises.map((exercise) => {
  const contextKey = `${exercise.studentId}:${exercise.subjectInstanceId}`;
  const records = workRecords[contextKey] ?? {};
  return [getTutorExerciseCompletionKey(exercise), getTutorExerciseCompletionStatus({
    exercise,
    peerMarkingAssignments: records.peerMarkingAssignments ?? [],
    scoreEntries: records.scoreEntries ?? [],
    workRecordsError: Boolean(records.loadError),
  })];
}));

export const TutorExercisesPage = () => {
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const { role, basePath } = useEffectiveRole();
  const [contexts, setContexts] = useState([]);
  const [bounds, setBounds] = useState({ earliestDate: '', latestDate: '' });
  const [calendarWeekStart, setCalendarWeekStart] = useState(() => shiftDateKey(getLocalDateKey(), -6));
  const [calendarExercises, setCalendarExercises] = useState([]);
  const [calendarCompletion, setCalendarCompletion] = useState({});
  const [todayExercises, setTodayExercises] = useState([]);
  const [todayCompletion, setTodayCompletion] = useState({});
  const [isLoadingContexts, setIsLoadingContexts] = useState(true);
  const [isLoadingCalendar, setIsLoadingCalendar] = useState(true);
  const [status, setStatus] = useState('');
  const [workLoadError, setWorkLoadError] = useState('');
  const today = getLocalDateKey();

  useEffect(() => {
    let active = true;
    if (!profile?.uid) {
      setContexts([]);
      setBounds({ earliestDate: '', latestDate: '' });
      setIsLoadingContexts(false);
      return () => { active = false; };
    }

    setIsLoadingContexts(true);
    setStatus('');
    getTutorAssignedStudentContexts(profile.uid)
      .then(async (rows) => {
        if (!active) return;
        setContexts(rows);
        try {
          setBounds(await getTutorExerciseCalendarBounds(rows));
        } catch (error) {
          setBounds({ earliestDate: '', latestDate: '' });
          setStatus(error.message || 'Exercise calendar history could not be loaded.');
        }
      })
      .catch((error) => {
        if (active) setStatus(error.message || 'Could not load students and exercises.');
      })
      .finally(() => { if (active) setIsLoadingContexts(false); });

    return () => { active = false; };
  }, [profile?.uid]);

  useEffect(() => {
    let active = true;
    if (isLoadingContexts) return undefined;
    if (!contexts.length) {
      setCalendarExercises([]);
      setCalendarCompletion({});
      setTodayExercises([]);
      setTodayCompletion({});
      setIsLoadingCalendar(false);
      return undefined;
    }

    const weekEnd = shiftDateKey(calendarWeekStart, 6);
    const todayInWeek = today >= calendarWeekStart && today <= weekEnd;
    setIsLoadingCalendar(true);
    setWorkLoadError('');
    getTutorExerciseCalendarWindow({ contexts, startDate: calendarWeekStart, endDate: weekEnd })
      .then(async (exercises) => {
        if (!active) return;
        setCalendarExercises(exercises);
        if (todayInWeek) setTodayExercises(exercises.filter((exercise) => String(exercise.assignmentDate ?? '').slice(0, 10) === today));
        const workRecords = await getTutorExerciseWorkRecords({ contexts, exercises });
        if (!active) return;
        const completion = buildCompletionStatuses(exercises, workRecords);
        setCalendarCompletion(completion);
        if (todayInWeek) {
          setTodayCompletion(Object.fromEntries(exercises
            .filter((exercise) => String(exercise.assignmentDate ?? '').slice(0, 10) === today)
            .map((exercise) => [getTutorExerciseCompletionKey(exercise), completion[getTutorExerciseCompletionKey(exercise)]])));
        }
        const failedContext = Object.values(workRecords).find((record) => record.loadError);
        if (failedContext?.loadError) setWorkLoadError('Some marking history could not be checked; affected work stays pending until it can be verified.');
      })
      .catch((error) => {
        if (active) setStatus(error.message || 'Could not load this week’s exercises.');
      })
      .finally(() => { if (active) setIsLoadingCalendar(false); });

    return () => { active = false; };
  }, [calendarWeekStart, contexts, isLoadingContexts, today]);

  const dateStatus = (dateKey) => getTutorCalendarDateStatus({
    dateKey,
    today,
    exercises: calendarExercises,
    completionByExerciseId: calendarCompletion,
  });

  const openExercise = (exercise) => {
    const params = new URLSearchParams();
    if (exercise.studentId) params.set('studentId', exercise.studentId);
    if (exercise.subjectInstanceId) params.set('subjectInstanceId', exercise.subjectInstanceId);
    navigate(`${basePath}/exercises/${exercise.id}${params.size ? `?${params.toString()}` : ''}`);
  };

  const emptyMessage = useMemo(() => contexts.length
    ? 'No exercises are scheduled for your students today.'
    : 'No students are assigned to you yet.', [contexts.length]);

  return (
    <AppShell title="Home" subtitle="Review today’s exercise work across your students." role={role} user={profile} onLogout={logout}>
      {status ? <div className="panel p-4 text-sm text-rose-700" role="alert">{status}</div> : null}
      {workLoadError ? <div className="panel p-4 text-sm text-amber-700" role="status">{workLoadError}</div> : null}

      <section className="space-y-4">
        <div className="rounded-2xl bg-gradient-to-r from-lime-300 via-lime-400 to-emerald-400 p-5 text-slate-950 shadow-soft sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-950/70">Exercises</p>
          <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Work to Complete</h2>
          <ExerciseActivityCalendar
            weekStart={calendarWeekStart}
            bounds={bounds}
            exercises={calendarExercises}
            loading={isLoadingContexts || isLoadingCalendar}
            onWeekChange={setCalendarWeekStart}
            getDateStatus={dateStatus}
            pendingStatusLabel="Pending"
            incompleteStatusLabel="Incomplete"
          />
        </div>

        <div>
          <div className="mb-4">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Today · {today}</p>
            <h2 className="mt-1 text-xl font-bold text-slate-950">Student exercises</h2>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {isLoadingContexts || isLoadingCalendar ? <LoadingState className="col-span-full min-h-40" label="Loading today’s exercises…" /> : null}
            {!isLoadingContexts && !isLoadingCalendar ? todayExercises.map((exercise) => (
              <HomeExerciseCard
                key={getTutorExerciseCompletionKey(exercise)}
                exercise={exercise}
                studentName={exercise.studentName}
                completion={todayCompletion[getTutorExerciseCompletionKey(exercise)]}
                allowAnyDate
                onOpen={() => {
                  openExercise(exercise);
                  warmNavigationRoute(`${basePath}/exercises/${exercise.id}`);
                }}
              />
            )) : null}
            {!isLoadingContexts && !isLoadingCalendar && !todayExercises.length ? (
              <div className="panel col-span-full flex min-h-40 items-center justify-center p-6 text-center text-sm text-slate-500">{emptyMessage}</div>
            ) : null}
          </div>
        </div>
      </section>
    </AppShell>
  );
};
