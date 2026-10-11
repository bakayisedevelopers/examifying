import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import {
  getManualTopicCompletionOptions,
  getLessonById,
  getTutorAssignedStudentContexts,
  getTutorLessonsForAssignedStudents,
  saveManualTopicCompletion,
} from '../../services/firestoreService';
import { useEffectiveRole } from '../../utils/effectiveRole';
import { warmNavigationRoute } from '../../routes/preloadNavigationRoute';
import { useOperationStatus } from '../../hooks/useOperationStatus';

const sessionKey = (lesson) => lesson.groupSessionId || lesson.id;
const makeOperationId = () => globalThis.crypto?.randomUUID?.() ?? `manual-topic-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const contextKey = (context) => `${context.studentId}::${context.subjectInstanceId}`;
const studentLabel = (student) => student.displayName || student.name || student.email || student.studentId;

export const TutorLessonsPage = () => {
  const { profile, logout } = useAuth();
  const { basePath, role } = useEffectiveRole();
  const { runOperation } = useOperationStatus();
  const [lessons, setLessons] = useState([]);
  const [students, setStudents] = useState([]);
  const [studentFilter, setStudentFilter] = useState('all');
  const [subjectFilter, setSubjectFilter] = useState('all');
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [manualSubject, setManualSubject] = useState('');
  const [manualContextKey, setManualContextKey] = useState('');
  const [manualAvailableTopics, setManualAvailableTopics] = useState([]);
  const [manualTopicsLoading, setManualTopicsLoading] = useState(false);
  const [manualTopicsError, setManualTopicsError] = useState('');
  const [manualSelectedTopic, setManualSelectedTopic] = useState('');
  const [manualTopicRows, setManualTopicRows] = useState([]);
  const [manualSaveError, setManualSaveError] = useState('');
  const [manualSaving, setManualSaving] = useState(false);
  const manualOperationId = useRef(null);

  useEffect(() => {
    if (!profile?.uid) { setIsLoading(false); return undefined; }
    let active = true;
    setIsLoading(true);
    setStatus('');
    getTutorAssignedStudentContexts(profile.uid)
      .then((studentRows) => getTutorLessonsForAssignedStudents(profile.uid, studentRows).then((lessonRows) => [lessonRows, studentRows]))
      .then(([lessonRows, studentRows]) => { if (active) { setLessons(lessonRows); setStudents(studentRows); } })
      .catch((error) => { if (active) setStatus(error.message || 'Could not load lessons.'); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [profile?.uid]);

  const subjects = useMemo(() => [...new Set(students.map((item) => item.subject).concat(lessons.map((item) => item.subject)).filter(Boolean))], [students, lessons]);
  const studentOptions = useMemo(() => students.filter((item, index, list) => list.findIndex((row) => row.studentId === item.studentId) === index), [students]);
  const manualContexts = useMemo(() => students.filter((item) => item.accessRole === 'co-owner'), [students]);
  const manualSubjectOptions = useMemo(() => [...new Set(manualContexts.map((item) => item.subject).filter(Boolean))].sort(), [manualContexts]);
  const manualStudentOptions = useMemo(() => manualContexts
    .filter((item) => item.subject === manualSubject)
    .filter((item, index, list) => list.findIndex((row) => row.studentId === item.studentId && row.subjectInstanceId === item.subjectInstanceId) === index), [manualContexts, manualSubject]);
  const manualContext = useMemo(() => manualStudentOptions.find((item) => contextKey(item) === manualContextKey) ?? null, [manualContextKey, manualStudentOptions]);
  const filteredLessons = lessons.filter((lesson) => (studentFilter === 'all' || lesson.studentId === studentFilter) && (subjectFilter === 'all' || lesson.subject === subjectFilter));

  useEffect(() => {
    if (!manualContext) {
      setManualAvailableTopics([]);
      setManualTopicsError('');
      setManualTopicsLoading(false);
      return undefined;
    }
    let active = true;
    setManualTopicsLoading(true);
    setManualTopicsError('');
    getManualTopicCompletionOptions({
      studentId: manualContext.studentId,
      subjectInstanceId: manualContext.subjectInstanceId,
      subject: manualContext.subject,
      grade: manualContext.grade,
    })
      .then((topics) => { if (active) setManualAvailableTopics(topics); })
      .catch((error) => { if (active) { setManualAvailableTopics([]); setManualTopicsError(error.message || 'Could not load available topics.'); } })
      .finally(() => { if (active) setManualTopicsLoading(false); });
    return () => { active = false; };
  }, [manualContext]);

  const resetManualOperation = () => { manualOperationId.current = null; };
  const changeManualSubject = (value) => {
    setManualSubject(value);
    setManualContextKey('');
    setManualSelectedTopic('');
    setManualTopicRows([]);
    setManualSaveError('');
    resetManualOperation();
  };
  const changeManualStudent = (value) => {
    setManualContextKey(value);
    setManualSelectedTopic('');
    setManualTopicRows([]);
    setManualSaveError('');
    resetManualOperation();
  };
  const addManualTopic = () => {
    if (!manualSelectedTopic || manualTopicRows.some((entry) => entry.topic === manualSelectedTopic)) return;
    setManualTopicRows((current) => [...current, { topic: manualSelectedTopic, understandingLevel: '' }]);
    setManualAvailableTopics((current) => current.filter((topic) => topic !== manualSelectedTopic));
    setManualSelectedTopic('');
    setManualSaveError('');
    resetManualOperation();
  };
  const removeManualTopic = (topic) => {
    setManualTopicRows((current) => current.filter((entry) => entry.topic !== topic));
    setManualAvailableTopics((current) => [...current, topic].sort((left, right) => left.localeCompare(right)));
    setManualSaveError('');
    resetManualOperation();
  };
  const updateManualTopicScore = (topic, value) => {
    setManualTopicRows((current) => current.map((entry) => entry.topic === topic ? { ...entry, understandingLevel: value } : entry));
    setManualSaveError('');
    resetManualOperation();
  };
  const manualScoresAreValid = manualTopicRows.length > 0 && manualTopicRows.every((entry) => {
    const score = Number(entry.understandingLevel);
    return entry.understandingLevel !== '' && Number.isFinite(score) && score >= 0 && score <= 10;
  });
  const saveManualTopics = async () => {
    if (!manualContext || !manualScoresAreValid) {
      setManualSaveError('Choose a student and add a score from 0 to 10 for every topic.');
      return;
    }
    if (!manualOperationId.current) manualOperationId.current = makeOperationId();
    setManualSaving(true);
    setManualSaveError('');
    try {
      const saved = await runOperation({
        operationName: 'Saving completed topics',
        successMessage: 'The topics and scores were saved. Exercise generation will check this completed record automatically.',
      }, () => saveManualTopicCompletion({
        tutorId: profile.uid,
        studentId: manualContext.studentId,
        subjectInstanceId: manualContext.subjectInstanceId,
        subject: manualContext.subject,
        grade: manualContext.grade,
        topicScores: manualTopicRows.map((entry) => ({ topic: entry.topic, understandingLevel: Number(entry.understandingLevel) })),
        operationId: manualOperationId.current,
      }));
      manualOperationId.current = null;
      setManualTopicRows([]);
      setManualSelectedTopic('');
      try {
        const lesson = await getLessonById(saved.lessonId, {
          studentId: manualContext.studentId,
          subjectInstanceId: manualContext.subjectInstanceId,
        });
        if (lesson) {
          setLessons((current) => [{
            ...lesson,
            studentName: studentLabel(manualContext),
            subject: manualContext.subject,
            grade: manualContext.grade,
          }, ...current.filter((item) => item.id !== lesson.id)]);
        }
      } catch {
        // The confirmed write remains successful if the optional list refresh is unavailable.
      }
    } catch (error) {
      setManualSaveError(error.message || 'Could not save the completed topics.');
    } finally {
      setManualSaving(false);
    }
  };
  const sessions = useMemo(() => {
    const groups = new Map();
    filteredLessons.forEach((lesson) => {
      const key = sessionKey(lesson);
      const current = groups.get(key);
      if (!current) {
        groups.set(key, { ...lesson, studentNames: [lesson.studentName || lesson.studentId], totalStudents: Number(lesson.groupStudentCount) || 1, presentCount: lesson.attended === false || lesson.status === 'missed' ? 0 : (lesson.status === 'completed' ? 1 : null) });
        return;
      }
      if (!current.studentNames.includes(lesson.studentName || lesson.studentId)) current.studentNames.push(lesson.studentName || lesson.studentId);
      current.totalStudents = Math.max(current.totalStudents, Number(lesson.groupStudentCount) || current.studentNames.length);
      if (lesson.status === 'completed' || lesson.status === 'missed') current.presentCount = (current.presentCount ?? 0) + (lesson.attended === false || lesson.status === 'missed' ? 0 : 1);
    });
    return [...groups.values()].sort((left, right) => String(right.completedOn || right.lessonDate || '').localeCompare(String(left.completedOn || left.lessonDate || '')));
  }, [filteredLessons]);

  return (
    <AppShell title="Lessons" subtitle="Schedule one-on-one and group lessons, then record attendance and student progress." role={role} user={profile} onLogout={logout}>
      <div className="panel grid gap-3 p-4 md:grid-cols-[1fr_1fr_auto]">
        <select aria-label="Filter lessons by student" className="input" value={studentFilter} onChange={(event) => setStudentFilter(event.target.value)}><option value="all">All students</option>{studentOptions.map((student) => <option key={student.studentId} value={student.studentId}>{student.displayName || student.name || student.email || student.studentId}</option>)}</select>
        <select aria-label="Filter lessons by subject" className="input" value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)}><option value="all">All subjects</option>{subjects.map((subject) => <option key={subject}>{subject}</option>)}</select>
        <Link to={`${basePath}/lessons/new`} onMouseEnter={() => warmNavigationRoute(`${basePath}/lessons/new`)} onFocus={() => warmNavigationRoute(`${basePath}/lessons/new`)} onPointerDown={() => warmNavigationRoute(`${basePath}/lessons/new`)} className="btn-primary text-center">Schedule lesson</Link>
      </div>
      <SectionHeader eyebrow="Lessons" title="Tutor lessons" description="Each student keeps an individual lesson record; group sessions are shown once here." />
      <section className="panel space-y-4 p-4 sm:p-5" aria-labelledby="manual-topic-completion-title">
        <div>
          <h2 id="manual-topic-completion-title" className="text-base font-bold text-slate-950">Record completed topics</h2>
          <p className="mt-1 text-sm text-slate-600">Use this when topics were completed with a student but no lesson record was logged. New topics are added to the subject history with an understanding score.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-semibold text-slate-700">Subject
            <select className="input" value={manualSubject} onChange={(event) => changeManualSubject(event.target.value)} disabled={isLoading || !manualSubjectOptions.length}>
              <option value="">Choose subject</option>
              {manualSubjectOptions.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-semibold text-slate-700">Student
            <select className="input" value={manualContextKey} onChange={(event) => changeManualStudent(event.target.value)} disabled={!manualSubject || !manualStudentOptions.length}>
              <option value="">Choose assigned student</option>
              {manualStudentOptions.map((student) => <option key={contextKey(student)} value={contextKey(student)}>{studentLabel(student)}{student.grade ? ` • ${student.grade}` : ''}</option>)}
            </select>
          </label>
        </div>
        {manualContexts.length === 0 && !isLoading ? <p className="text-sm text-slate-500">This action requires current co-owner access to an assigned student.</p> : null}
        {manualContext ? (
          <>
            <div className="flex flex-col gap-2 sm:flex-row">
              <select aria-label="Choose a topic to add" className="input min-w-0 flex-1" value={manualSelectedTopic} onChange={(event) => setManualSelectedTopic(event.target.value)} disabled={manualTopicsLoading || !manualAvailableTopics.length}>
                <option value="">{manualTopicsLoading ? 'Loading available topics…' : manualAvailableTopics.length ? 'Choose a topic' : 'No uncompleted topics available'}</option>
                {manualAvailableTopics.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
              </select>
              <button type="button" className="btn-secondary inline-flex items-center justify-center gap-2" onClick={addManualTopic} disabled={!manualSelectedTopic || manualTopicsLoading}>
                <Plus className="h-4 w-4" aria-hidden="true" /> Add topic
              </button>
            </div>
            {manualTopicsError ? <p className="text-sm text-rose-700" role="alert">{manualTopicsError}</p> : null}
            {manualTopicRows.length ? (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <div className="overflow-x-auto overscroll-x-contain">
                  <table className="min-w-[520px] w-full border-collapse text-left text-sm">
                    <thead className="bg-slate-900 text-xs uppercase text-slate-200"><tr><th className="px-3 py-2.5">Topic</th><th className="w-44 px-3 py-2.5 text-center">Understanding score / 10</th><th className="w-24 px-3 py-2.5 text-center">Action</th></tr></thead>
                    <tbody className="divide-y divide-slate-200 bg-slate-950/20">
                      {manualTopicRows.map((entry) => (
                        <tr key={entry.topic}>
                          <td className="px-3 py-3 font-medium text-slate-800">{entry.topic}</td>
                          <td className="px-3 py-2"><input aria-label={`Understanding score out of 10 for ${entry.topic}`} type="number" min="0" max="10" step="1" className="input mx-auto max-w-28 text-center" value={entry.understandingLevel} onChange={(event) => updateManualTopicScore(entry.topic, event.target.value)} placeholder="0–10" disabled={manualSaving} /></td>
                          <td className="px-3 py-2 text-center"><button type="button" className="inline-flex items-center gap-1 rounded-full px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-100" onClick={() => removeManualTopic(entry.topic)} disabled={manualSaving} aria-label={`Remove ${entry.topic}`}><Trash2 className="h-4 w-4" aria-hidden="true" /> Remove</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : <p className="rounded-lg border border-slate-200 p-3 text-sm text-slate-500">Add one or more topics from the selected subject's catalogue. Topics already present in this student's subject episode are excluded.</p>}
            {manualSaveError ? <p className="text-sm text-rose-700" role="alert">{manualSaveError}</p> : null}
            <button type="button" className="btn-primary" onClick={saveManualTopics} disabled={manualSaving || !manualScoresAreValid}>
              {manualSaving ? 'Saving completed topics…' : `Save ${manualTopicRows.length || ''} completed topic${manualTopicRows.length === 1 ? '' : 's'}`}
            </button>
          </>
        ) : null}
      </section>
      {status ? <div className="panel p-4 text-sm text-rose-700">{status}</div> : null}
      <div className="grid gap-4">
        {isLoading ? <LoadingState label="Loading tutor lessons…" /> : null}
        {sessions.map((lesson) => {
          const isGroup = lesson.sessionMode === 'group';
          const missed = lesson.status === 'missed';
          const completed = lesson.status === 'completed';
          const statusLabel = missed ? 'Missed' : completed ? 'Completed' : 'Planned';
          const statusTone = missed ? 'bg-amber-100 text-amber-800' : completed ? 'bg-lime-100 text-lime-800' : 'bg-slate-100 text-slate-600';
          return (
            <Link key={sessionKey(lesson)} to={`${basePath}/lessons/${lesson.id}?studentId=${encodeURIComponent(lesson.studentId)}&subjectInstanceId=${encodeURIComponent(lesson.subjectInstanceId || '')}`} onMouseEnter={() => warmNavigationRoute(`${basePath}/lessons/${lesson.id}`)} onFocus={() => warmNavigationRoute(`${basePath}/lessons/${lesson.id}`)} onPointerDown={() => warmNavigationRoute(`${basePath}/lessons/${lesson.id}`)} className="panel block p-5 transition hover:border-lime-700/40">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-950">{(lesson.topics ?? [lesson.topic]).filter(Boolean).join(' • ') || 'Lesson topics not recorded'}</p>
                  <p className="mt-1 text-sm text-slate-500">{isGroup ? `Group lesson • ${lesson.totalStudents} students` : lesson.studentNames[0]} • {lesson.subject} • {lesson.grade || 'Grade not recorded'} • {lesson.completedOn || lesson.lessonDate || 'No date'} • {lesson.manualTopicCompletion ? 'Manual topic completion' : lesson.lessonType === 'inPerson' ? 'In-person' : 'Online (WhatsApp)'}</p>
                  {isGroup ? <p className="mt-2 line-clamp-2 text-xs text-slate-500">{lesson.studentNames.slice(0, 6).join(', ')}{lesson.totalStudents > 6 ? ` and ${lesson.totalStudents - 6} more` : ''}</p> : null}
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusTone}`}>{statusLabel}</span>
              </div>
              {lesson.topicReport ? <p className="mt-3 line-clamp-2 text-sm text-slate-600">{lesson.topicReport}</p> : null}
              {isGroup && lesson.presentCount !== null ? <p className="mt-2 text-xs font-medium text-slate-500">{lesson.presentCount} present • {lesson.totalStudents - lesson.presentCount} missed</p> : null}
            </Link>
          );
        })}
        {!isLoading && !status && !sessions.length ? <div className="panel p-5 text-sm text-slate-500">No lessons match this filter.</div> : null}
      </div>
    </AppShell>
  );
};
