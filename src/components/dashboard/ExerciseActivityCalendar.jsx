import { Check, ChevronLeft, ChevronRight, Hourglass, LockKeyhole, X } from 'lucide-react';
import { getLocalDateKey, shiftDateKey } from '../../utils/dateKey';
const dateFromKey = (dateKey) => new Date(`${dateKey}T12:00:00`);
const isSubmittedExercise = (exercise = {}) => Boolean(exercise.submittedImageUrl || exercise.submitted === 'Yes' || exercise.submissionStatus === 'submitted');

const statusDetails = {
  completed: { label: 'Completed', Icon: Check, iconClass: 'text-slate-950' },
  missed: { label: 'Missed', Icon: X, iconClass: 'text-rose-700' },
  inProgress: { label: 'In progress', Icon: Hourglass, iconClass: 'text-slate-950' },
  locked: { label: 'Locked', Icon: LockKeyhole, iconClass: 'text-slate-700' },
  none: { label: 'No work assigned', Icon: null, iconClass: '' },
};

const studentStatusForDate = ({ dateKey, today, bounds, exercises, assignedMarking, completedMarking, activeSubjectInstanceIds }) => {
  if (dateKey > today) return 'locked';
  if (!bounds) return dateKey === today ? 'inProgress' : 'none';

  const activeInstances = new Set(activeSubjectInstanceIds);
  const markingRowsByPath = new Map();
  [...assignedMarking, ...completedMarking].forEach((assignment) => {
    if (activeInstances.has(assignment.reviewerSubjectInstanceId)) {
      markingRowsByPath.set(assignment.assignmentPath || assignment.id, assignment);
    }
  });
  const dayExercises = exercises.filter((exercise) => String(exercise.assignmentDate ?? '').slice(0, 10) === dateKey);
  const dayMarking = [...markingRowsByPath.values()]
    .filter((assignment) => String(assignment.assignmentDate ?? '').slice(0, 10) === dateKey);
  const expectedSubjectIds = activeSubjectInstanceIds.filter((subjectInstanceId) => {
    const subjectBounds = bounds?.subjectBounds?.[subjectInstanceId];
    return subjectBounds?.earliestDate && subjectBounds?.latestDate
      && dateKey >= subjectBounds.earliestDate && dateKey <= subjectBounds.latestDate;
  });
  const hasActivity = expectedSubjectIds.length > 0 || dayExercises.length > 0 || dayMarking.length > 0;
  const allExercisesSubmitted = expectedSubjectIds.length
    ? expectedSubjectIds.every((subjectInstanceId) => {
      const subjectExercises = dayExercises.filter((exercise) => exercise.subjectInstanceId === subjectInstanceId);
      return subjectExercises.length > 0 && subjectExercises.every(isSubmittedExercise);
    })
    : dayExercises.every(isSubmittedExercise);
  const allMarkingCompleted = dayMarking.every((assignment) => assignment.status === 'completed');

  if (hasActivity && allExercisesSubmitted && allMarkingCompleted) return 'completed';
  if (dateKey === today) return 'inProgress';
  return hasActivity ? 'missed' : 'none';
};

export const ExerciseActivityCalendar = ({
  weekStart,
  bounds,
  exercises = [],
  assignedMarking = [],
  completedMarking = [],
  activeSubjectInstanceIds = [],
  loading = false,
  onWeekChange,
  getDateStatus,
  pendingStatusLabel,
  incompleteStatusLabel,
}) => {
  const today = getLocalDateKey();
  const dates = Array.from({ length: 7 }, (_, index) => shiftDateKey(weekStart, index));
  const weekEnd = dates.at(-1);
  const canGoBack = Boolean(bounds?.earliestDate && weekStart > bounds.earliestDate);
  const canGoForward = Boolean(bounds?.latestDate && weekEnd < bounds.latestDate);

  const changeWeek = (direction) => {
    if (direction < 0) {
      const previousStart = shiftDateKey(weekStart, -7);
      onWeekChange(bounds?.earliestDate && previousStart < bounds.earliestDate ? bounds.earliestDate : previousStart);
      return;
    }
    const nextStart = shiftDateKey(weekStart, 7);
    const latestFullWeekStart = bounds?.latestDate ? shiftDateKey(bounds.latestDate, -6) : nextStart;
    onWeekChange(nextStart > latestFullWeekStart ? latestFullWeekStart : nextStart);
  };

  const visibleRange = `${dateFromKey(weekStart).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })} – ${dateFromKey(weekEnd).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}`;

  return (
    <div className="mt-4 w-full rounded-xl border border-emerald-950/20 bg-transparent p-3 sm:p-4" aria-label="Exercise and peer-marking activity calendar">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="shrink-0 text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-950/75 sm:text-xs">Last 7 days</p>
        <div className="flex min-w-0 items-center gap-1">
          <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-950 transition hover:bg-lime-200 disabled:cursor-not-allowed disabled:opacity-35" onClick={() => changeWeek(-1)} disabled={!canGoBack} aria-label="Show previous week">
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="min-w-0 text-center text-[10px] font-semibold tabular-nums text-emerald-950/80 sm:text-xs" aria-live="polite">{visibleRange}</span>
          <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-950 transition hover:bg-lime-200 disabled:cursor-not-allowed disabled:opacity-35" onClick={() => changeWeek(1)} disabled={!canGoForward} aria-label="Show next week">
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      {loading ? <p className="sr-only" role="status">Loading activity for this week.</p> : null}
      <div className="mt-3 grid w-full grid-cols-7 gap-1.5 sm:gap-3">
        {dates.map((dateKey) => {
          const status = getDateStatus
            ? getDateStatus(dateKey)
            : studentStatusForDate({ dateKey, today, bounds, exercises, assignedMarking, completedMarking, activeSubjectInstanceIds });
          const details = statusDetails[status] ?? statusDetails.none;
          const label = status === 'inProgress' ? pendingStatusLabel || details.label
            : status === 'missed' ? incompleteStatusLabel || details.label
              : details.label;
          const { Icon, iconClass } = details;
          const date = dateFromKey(dateKey);
          return (
            <div key={dateKey} className="grid min-w-0 justify-items-center gap-1" role="group" aria-label={`${date.toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' })}: ${label}`}>
              <span className="text-[9px] font-semibold uppercase text-emerald-950/65 sm:text-[10px]">{date.toLocaleDateString('en-ZA', { weekday: 'short' }).slice(0, 2)}</span>
              <span className="flex aspect-square w-full max-w-11 items-center justify-center rounded-full border border-emerald-950/35 bg-transparent" title={`${date.toLocaleDateString('en-ZA')}: ${label}`}>
                {Icon ? <Icon className={`h-4 w-4 stroke-[2.5] sm:h-5 sm:w-5 ${iconClass}`} aria-hidden="true" /> : null}
              </span>
              <span className="text-[10px] font-semibold tabular-nums text-emerald-950/80 sm:text-xs">{date.getDate()}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

