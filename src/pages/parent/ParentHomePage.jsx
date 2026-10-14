import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, Clock3, CreditCard, Users } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { ExerciseActivityCalendar } from '../../components/dashboard/ExerciseActivityCalendar';
import { LoadingState } from '../../components/common/LoadingState';
import { useAuth } from '../../hooks/useAuth';
import {
  getActiveSubjectEpisodesForStudent,
  getCompletedPeerMarkingAssignmentsForCalendar,
  getPeerMarkingAssignmentsForStudent,
  getStudentExerciseCalendarBounds,
  getStudentExerciseCalendarWindow,
  getStudentSubscriptionState,
  getStudentsForParent,
} from '../../services/firestoreService';
import { getLocalDateKey, shiftDateKey } from '../../utils/dateKey';
import { getParentCalendarDateStatus, getStudentDailyCompletion } from '../../utils/parentCompletion';
import { ParentFamilyPlanBuilder } from '../../components/parent/ParentFamilyPlanBuilder';

const weekEnd = (weekStart) => shiftDateKey(weekStart, 6);
const mergeByPath = (...groups) => [...new Map(groups.flat().map((item) => [item.assignmentPath || item.id, item])).values()];

const ParentStudentCard = ({ student }) => {
  const completed = student.todayCompletion?.complete;
  const Icon = completed ? Check : Clock3;
  return (
    <Link to={`/parent/kids/${student.uid}`} className="panel group block p-5 transition hover:-translate-y-0.5 hover:border-lime-400/50 hover:shadow-soft">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-bold text-slate-950">{student.displayName || student.name || student.email || 'Student'}</h2>
          <p className="mt-1 text-sm text-slate-500">{student.grade || 'Grade not set'} · {student.activeSubjects?.length || 0} active subject{student.activeSubjects?.length === 1 ? '' : 's'}</p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${completed ? 'bg-lime-100 text-lime-800' : 'bg-amber-100 text-amber-800'}`}>
          <Icon className="h-4 w-4" aria-hidden="true" />{completed ? 'Done today' : 'Not done'}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {(student.activeSubjects ?? []).length ? student.activeSubjects.map((subject) => (
          <span key={subject} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600">{subject}</span>
        )) : <span className="text-sm text-slate-500">No active subjects</span>}
      </div>
      <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4 text-sm">
        <span className={`inline-flex items-center gap-2 font-medium ${student.subscriptionState?.paymentCompleted ? 'text-emerald-700' : 'text-amber-700'}`}>
          <CreditCard className="h-4 w-4" aria-hidden="true" />
          {student.subscriptionState?.paymentCompleted ? `${student.subscriptionState.subscriptionPlanName} active` : 'Subscription needed'}
        </span>
        <span className="inline-flex items-center gap-1 font-semibold text-slate-700 group-hover:text-emerald-800">Open student <ChevronRight className="h-4 w-4" aria-hidden="true" /></span>
      </div>
    </Link>
  );
};

export const ParentHomePage = () => {
  const { profile, logout } = useAuth();
  const location = useLocation();
  const [weekStart, setWeekStart] = useState(() => shiftDateKey(getLocalDateKey(), -6));
  const [students, setStudents] = useState([]);
  const [calendarStudents, setCalendarStudents] = useState([]);
  const [bounds, setBounds] = useState(null);
  const [loading, setLoading] = useState(true);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [error, setError] = useState('');
  const studentsRef = useRef(students);
  studentsRef.current = students;
  const studentSignature = students.map((student) => `${student.uid}:${(student.episodes ?? []).map((episode) => episode.id).join(',')}`).join('|');

  const loadStudents = useCallback(async () => {
    if (!profile?.uid) return [];
    const linkedStudents = await getStudentsForParent(profile.uid);
    const enriched = await Promise.all(linkedStudents.map(async (student) => {
      const [episodes, subscriptionState] = await Promise.all([
        getActiveSubjectEpisodesForStudent(student.uid),
        getStudentSubscriptionState(student),
      ]);
      return { ...student, episodes, activeSubjects: [...new Set(episodes.map((episode) => episode.subjectKey).filter(Boolean))].sort(), subscriptionState };
    }));
    setStudents(enriched);
    return enriched;
  }, [profile?.uid]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    loadStudents().catch((loadError) => {
      if (active) setError(loadError?.message || 'Could not load your linked students.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadStudents]);

  useEffect(() => {
    let active = true;
    const startDate = weekStart;
    const endDate = weekEnd(weekStart);
    const currentStudents = studentsRef.current;
    setCalendarLoading(true);
    Promise.all(currentStudents.map(async (student) => {
      const episodes = student.episodes ?? [];
      if (!episodes.length) return { ...student, bounds: null, exercises: [], assignments: [] };
      const [studentBounds, exercises, assigned, completed] = await Promise.all([
        getStudentExerciseCalendarBounds(student.uid, episodes),
        getStudentExerciseCalendarWindow({ studentId: student.uid, subjectEpisodes: episodes, startDate, endDate }),
        getPeerMarkingAssignmentsForStudent(student.uid),
        getCompletedPeerMarkingAssignmentsForCalendar({ reviewerId: student.uid, startDate, endDate, subjectInstanceIds: episodes.map((episode) => episode.id) }),
      ]);
      const assignments = mergeByPath(assigned.filter((item) => item.assignmentDate >= startDate && item.assignmentDate <= endDate), completed);
      return { ...student, bounds: studentBounds, exercises, assignments };
    })).then((rows) => {
      if (!active) return;
      setCalendarStudents(rows);
      const dates = rows.flatMap((student) => [student.bounds?.earliestDate, student.bounds?.latestDate]).filter(Boolean).sort();
      setBounds({ earliestDate: dates[0] ?? '', latestDate: dates.at(-1) ?? '' });
      const today = getLocalDateKey();
      setStudents((current) => current.map((student) => {
        const latest = rows.find((row) => row.uid === student.uid);
        const todayCompletion = getStudentDailyCompletion({
          dateKey: today,
          episodes: latest?.episodes ?? student.episodes ?? [],
          exercises: latest?.exercises ?? [],
          assignments: latest?.assignments ?? [],
        });
        return { ...student, todayCompletion };
      }));
    }).catch((loadError) => {
      if (active) setError((current) => current || loadError?.message || 'Calendar activity could not be loaded.');
    }).finally(() => { if (active) setCalendarLoading(false); });
    return () => { active = false; };
  }, [studentSignature, weekStart]);

  const getDateStatus = useCallback((dateKey) => getParentCalendarDateStatus({
    dateKey,
    today: getLocalDateKey(),
    students: calendarStudents,
  }), [calendarStudents]);
  const todayLabel = useMemo(() => new Date(`${getLocalDateKey()}T12:00:00`).toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' }), []);

  return (
    <AppShell title="Home" subtitle="See each child’s daily exercise and marking completion." role="parent" user={profile} onLogout={logout}>
      <section className="rounded-2xl bg-gradient-to-r from-lime-300 via-lime-400 to-emerald-400 p-5 text-slate-950 shadow-soft sm:p-6">
        <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-950/70">Family activity</p>
        <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Completion calendar</h2>
        <p className="mt-1 text-sm text-emerald-950/80">A day is complete when every linked child has submitted exercises for all active subjects and finished assigned peer marking.</p>
        <ExerciseActivityCalendar
          weekStart={weekStart}
          bounds={bounds}
          loading={calendarLoading}
          onWeekChange={setWeekStart}
          getDateStatus={getDateStatus}
        />
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-lime-400">{todayLabel}</p>
            <h2 className="text-xl font-bold text-white">Your kids</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to={`/parent/family-setup${location.search}`} className="btn-primary inline-flex items-center gap-2"><CreditCard className="h-4 w-4" aria-hidden="true" />Family checkout</Link>
            <Link to="/parent/kids" className="btn-secondary inline-flex items-center gap-2"><Users className="h-4 w-4" aria-hidden="true" />Manage kids</Link>
          </div>
        </div>
        {error ? <div className="panel p-4 text-sm text-rose-700" role="alert">{error}</div> : null}
        {loading ? <LoadingState label="Loading your kids…" /> : students.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {students.map((student) => <ParentStudentCard key={student.uid} student={student} />)}
          </div>
        ) : (
          <div className="panel flex flex-col items-center gap-3 p-8 text-center">
            <Users className="h-10 w-10 text-slate-400" aria-hidden="true" />
            <p className="font-semibold text-slate-900">No kids linked yet</p>
            <p className="max-w-md text-sm text-slate-500">Link a student account or create a managed student profile to see their learning activity here.</p>
            <Link to="/parent/kids" className="btn-primary">Open Kids</Link>
          </div>
        )}
      </section>
      <ParentFamilyPlanBuilder />
    </AppShell>
  );
};
