import { Check, Hourglass, Minus } from 'lucide-react';
import { DEFAULT_SUBJECT } from '../../lib/constants';
import { canOpenExercise } from '../../utils/exerciseRules';
import { ExerciseStatusBadges } from './ExerciseStatusBadges';

const completionIndicator = ({ label, state }) => {
  const Icon = state === 'completed' ? Check : state === 'none' ? Minus : Hourglass;
  const color = state === 'completed' ? 'text-emerald-700' : state === 'none' ? 'text-slate-400' : 'text-amber-600';
  const detail = state === 'completed' ? 'completed' : state === 'none' ? 'not assigned' : 'pending';
  return (
    <span key={label} className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600" aria-label={`${label}: ${detail}`}>
      <Icon className={`h-4 w-4 stroke-[2.5] ${color}`} aria-hidden="true" />
      <span>{label}: {detail}</span>
    </span>
  );
};

export const HomeExerciseCard = ({ exercise, onOpen, studentName, completion, allowAnyDate = false }) => (
  <button
    type="button"
    onClick={onOpen}
    disabled={!allowAnyDate && !canOpenExercise(exercise.assignmentDate)}
    className="panel w-full p-5 text-left transition hover:-translate-y-0.5 hover:shadow-soft disabled:cursor-not-allowed disabled:opacity-70"
  >
    <div className="flex flex-wrap items-center justify-between gap-3">
      {studentName ? <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">{exercise.subject ?? DEFAULT_SUBJECT}</span>
        {studentName ? <span className="truncate text-sm font-semibold text-slate-700">{studentName}</span> : null}
      </div> : <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">{exercise.subject ?? DEFAULT_SUBJECT}</span>}
      <ExerciseStatusBadges exercise={exercise} className="justify-end" />
    </div>
    {completion ? (
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        {completionIndicator({ label: 'Student submission', state: completion.studentSubmitted ? 'completed' : 'pending' })}
        {completionIndicator({ label: 'Peer marking', state: completion.studentPeerMarkingState })}
        {completionIndicator({ label: 'Tutor work', state: completion.tutorCompleted ? 'completed' : 'pending' })}
      </div>
    ) : null}
    <h3 className="mt-4 text-xl font-bold text-slate-950">{exercise.title}</h3>
    <p className="mt-2 text-sm font-semibold text-accent">{exercise.topic}</p>
    <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-500">{exercise.instruction}</p>
    <div className="mt-4 flex items-center justify-between gap-3 text-xs uppercase tracking-[0.25em] text-slate-400">
      <span>{exercise.assignmentDate}</span>
      <span>{allowAnyDate || canOpenExercise(exercise.assignmentDate) ? 'Open exercise' : 'Locked'}</span>
    </div>
  </button>
);
