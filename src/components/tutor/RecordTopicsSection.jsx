import { useEffect, useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { MultiSelectDropdown } from '../common/MultiSelectDropdown';
import {
  getManualTopicCompletionOptions,
  saveManualTopicCompletion,
} from '../../services/firestoreService';

const makeOperationId = () => globalThis.crypto?.randomUUID?.() ?? `manual-topic-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const contextKey = (context) => `${context.studentId}::${context.subjectInstanceId}`;
const studentLabel = (student) => student.displayName || student.name || student.email || student.studentId;

export const RecordTopicsSection = ({ tutorId, contexts = [], isLoading = false, runOperation, onTopicsSaved }) => {
  const [manualSubject, setManualSubject] = useState('');
  const [manualContextKey, setManualContextKey] = useState('');
  const [manualAvailableTopics, setManualAvailableTopics] = useState([]);
  const [manualTopicsLoading, setManualTopicsLoading] = useState(false);
  const [manualTopicsError, setManualTopicsError] = useState('');
  const [manualTopicRows, setManualTopicRows] = useState([]);
  const [manualSaveError, setManualSaveError] = useState('');
  const [manualSaving, setManualSaving] = useState(false);
  const manualOperationId = useRef(null);

  const manualContexts = useMemo(() => contexts.filter((item) => item.accessRole === 'co-owner'), [contexts]);
  const manualSubjectOptions = useMemo(() => [...new Set(manualContexts.map((item) => item.subject).filter(Boolean))].sort(), [manualContexts]);
  const manualStudentOptions = useMemo(() => manualContexts
    .filter((item) => item.subject === manualSubject)
    .filter((item, index, list) => list.findIndex((row) => row.studentId === item.studentId && row.subjectInstanceId === item.subjectInstanceId) === index), [manualContexts, manualSubject]);
  const manualContext = useMemo(() => manualStudentOptions.find((item) => contextKey(item) === manualContextKey) ?? null, [manualContextKey, manualStudentOptions]);

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
    setManualTopicRows([]);
    setManualSaveError('');
    resetManualOperation();
  };
  const changeManualStudent = (value) => {
    setManualContextKey(value);
    setManualTopicRows([]);
    setManualSaveError('');
    resetManualOperation();
  };
  const updateManualTopicSelection = (selectedTopics) => {
    setManualTopicRows((current) => {
      const currentByTopic = new Map(current.map((entry) => [entry.topic, entry]));
      return selectedTopics.map((topic) => currentByTopic.get(topic) ?? { topic, understandingLevel: '' });
    });
    setManualSaveError('');
    resetManualOperation();
  };
  const removeManualTopic = (topic) => {
    setManualTopicRows((current) => current.filter((entry) => entry.topic !== topic));
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
      await runOperation({
        operationName: 'Saving completed topics',
        successMessage: 'The topics and scores were saved. Exercise generation will check this completed record automatically.',
      }, () => saveManualTopicCompletion({
        tutorId,
        studentId: manualContext.studentId,
        subjectInstanceId: manualContext.subjectInstanceId,
        subject: manualContext.subject,
        grade: manualContext.grade,
        topicScores: manualTopicRows.map((entry) => ({ topic: entry.topic, understandingLevel: Number(entry.understandingLevel) })),
        operationId: manualOperationId.current,
      }));
      const savedContext = manualContext;
      const recordedTopics = new Set(manualTopicRows.map((entry) => entry.topic));
      manualOperationId.current = null;
      setManualTopicRows([]);
      setManualAvailableTopics((current) => current.filter((topic) => !recordedTopics.has(topic)));
      try {
        await onTopicsSaved?.(savedContext);
      } catch {
        // A successful completion write remains successful if the optional topic-list refresh fails.
      }
    } catch (error) {
      setManualSaveError(error.message || 'Could not save the completed topics.');
    } finally {
      setManualSaving(false);
    }
  };

  return (
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
          <div className="grid gap-2">
            <label className="text-sm font-semibold text-slate-700" htmlFor="manual-topic-multi-select">Topics to record</label>
            <MultiSelectDropdown
              id="manual-topic-multi-select"
              choices={manualAvailableTopics}
              selectedValues={manualTopicRows.map((entry) => entry.topic)}
              onChange={updateManualTopicSelection}
              placeholder={manualTopicsLoading ? 'Loading available topics…' : 'Select one or more topics'}
              emptyMessage={manualTopicsLoading ? 'Loading available topics…' : 'No uncompleted topics available'}
              ariaLabel="Choose completed topics"
              disabled={manualTopicsLoading || manualSaving || !manualAvailableTopics.length}
            />
            {manualTopicRows.length ? <p className="text-xs text-slate-500">Selected topics appear below immediately. Choose Done to close this menu.</p> : null}
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
          ) : <p className="rounded-lg border border-slate-200 p-3 text-sm text-slate-500">Select one or more topics from the subject catalogue. Topics already present in this student's subject episode are excluded.</p>}
          {manualSaveError ? <p className="text-sm text-rose-700" role="alert">{manualSaveError}</p> : null}
          <button type="button" className="btn-primary" onClick={saveManualTopics} disabled={manualSaving || !manualScoresAreValid}>
            {manualSaving ? 'Saving completed topics…' : `Save ${manualTopicRows.length || ''} completed topic${manualTopicRows.length === 1 ? '' : 's'}`}
          </button>
        </>
      ) : null}
    </section>
  );
};
