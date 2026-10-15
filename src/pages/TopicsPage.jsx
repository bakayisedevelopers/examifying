import { useEffect, useMemo, useState } from 'react';
import { Check, Clock3, Trash2 } from 'lucide-react';
import { AppShell } from '../components/common/AppShell';
import { LoadingState } from '../components/common/LoadingState';
import { OperationStatusOverlay } from '../components/common/OperationStatusOverlay';
import { SectionHeader } from '../components/common/SectionHeader';
import { useOperationStatus } from '../hooks/useOperationStatus';
import { useStudentWorkspaceProfile } from '../hooks/useStudentWorkspaceProfile';
import { useEffectiveRole } from '../utils/effectiveRole';
import {
  deleteStudentTopics,
  getActiveSubjectEpisodesForStudent,
  getTopicOverviewForEpisode,
  getTopicStudentProfile,
  getTutorAssignedStudentContexts,
} from '../services/firestoreService';

const formatPercent = (value) => Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
const newOperationId = () => globalThis.crypto?.randomUUID?.() ?? `topic-delete-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const StatusValue = ({ value }) => (
  value
    ? <span className="inline-flex items-center gap-1.5 rounded-full bg-lime-100 px-2.5 py-1 text-xs font-semibold text-lime-800"><Check className="h-3.5 w-3.5" aria-hidden="true" />Yes</span>
    : <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500"><Clock3 className="h-3.5 w-3.5" aria-hidden="true" />Pending</span>
);

export const TopicsPage = () => {
  const { profile, logout, isParentWorkspace } = useStudentWorkspaceProfile();
  const { role, isTeacher } = useEffectiveRole();
  const isTutorView = !isParentWorkspace && ['tutor', 'teacher'].includes(role);
  const isTeacherView = isTutorView && (isTeacher || role === 'teacher');
  const viewerRole = isTutorView ? (isTeacherView ? 'teacher' : 'tutor') : 'student';
  const { operationStatus, runOperation, closeOperationStatus } = useOperationStatus();
  const [contexts, setContexts] = useState([]);
  const [studentProfiles, setStudentProfiles] = useState({});
  const [studentFilter, setStudentFilter] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('');
  const [studentEpisodes, setStudentEpisodes] = useState([]);
  const [topics, setTopics] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setLoadError('');
    if (isTutorView) {
      if (!profile?.uid) { setContexts([]); setIsLoading(false); return undefined; }
      getTutorAssignedStudentContexts(profile.uid).then(async (rows) => {
        const uniqueIds = [...new Set(rows.map((row) => row.studentId).filter(Boolean))];
        const students = await Promise.all(uniqueIds.map(async (studentId) => [studentId, await getTopicStudentProfile(studentId)]));
        if (!active) return;
        const profileMap = Object.fromEntries(students.filter(([, student]) => student).map(([studentId, student]) => [studentId, student]));
        setStudentProfiles(profileMap);
        setContexts(rows.map((row) => ({
          ...row,
          studentName: profileMap[row.studentId]?.displayName || profileMap[row.studentId]?.name || profileMap[row.studentId]?.fullName || profileMap[row.studentId]?.email || row.studentId,
        })));
        setStudentFilter((current) => current && uniqueIds.includes(current) ? current : (uniqueIds[0] ?? ''));
      }).catch((error) => { if (active) setLoadError(error.message || 'Could not load assigned students.'); })
        .finally(() => { if (active) setIsLoading(false); });
    } else if (profile?.uid) {
      getActiveSubjectEpisodesForStudent(profile.uid)
        .then((rows) => { if (active) setStudentEpisodes(rows); })
        .catch((error) => { if (active) setLoadError(error.message || 'Could not load active subjects.'); })
        .finally(() => { if (active) setIsLoading(false); });
    } else setIsLoading(false);
    return () => { active = false; };
  }, [isTutorView, profile?.uid]);

  const studentOptions = useMemo(() => [...new Map(contexts.map((row) => [row.studentId, {
    id: row.studentId,
    name: row.studentName || studentProfiles[row.studentId]?.displayName || row.studentId,
  }])).values()], [contexts, studentProfiles]);
  const selectedContexts = useMemo(() => contexts.filter((row) => row.studentId === studentFilter), [contexts, studentFilter]);
  const subjectOptions = useMemo(() => [...new Set(selectedContexts.map((row) => row.subject).filter(Boolean))].sort(), [selectedContexts]);
  const selectedContext = isTutorView
    ? selectedContexts.find((row) => row.subject === subjectFilter)
    : studentEpisodes.find((row) => row.id === subjectFilter);
  const canDeleteTopics = isTutorView && selectedContext?.accessRole === 'co-owner';
  const activeSubject = selectedContext?.subject || selectedContext?.subjectKey || selectedContext?.subjectName || '';

  useEffect(() => {
    const options = isTutorView ? subjectOptions : studentEpisodes.map((row) => row.id).filter(Boolean);
    if (!options.length) { setSubjectFilter(''); return; }
    setSubjectFilter((current) => options.includes(current) ? current : options[0]);
  }, [isTutorView, studentEpisodes, subjectOptions]);

  useEffect(() => {
    let active = true;
    const context = isTutorView
      ? selectedContexts.find((row) => row.subject === subjectFilter)
      : studentEpisodes.find((row) => row.id === subjectFilter);
    setTopics([]);
    setSelectedIds([]);
    setLoadError('');
    if (!context || !profile?.uid && !isTutorView) return undefined;
    setIsLoading(true);
    getTopicOverviewForEpisode({
      studentId: isTutorView ? context.studentId : profile.uid,
      subjectInstanceId: isTutorView ? context.subjectInstanceId : context.id,
    }).then((result) => { if (active) setTopics(result.topics); })
      .catch((error) => { if (active) setLoadError(error.message || 'Could not load this topic list.'); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [isTutorView, profile?.uid, selectedContexts, studentEpisodes, studentFilter, subjectFilter]);

  const subjectAverage = useMemo(() => {
    const scored = topics.filter((item) => Number.isFinite(item.understandingLevel));
    return scored.length ? scored.reduce((sum, item) => sum + item.understandingLevel, 0) / scored.length : null;
  }, [topics]);

  const toggleTopic = (topicId) => setSelectedIds((current) => current.includes(topicId)
    ? current.filter((item) => item !== topicId) : [...current, topicId]);
  const toggleAll = () => setSelectedIds((current) => current.length === topics.length ? [] : topics.map((item) => item.id));

  const handleDelete = async () => {
    const context = isTutorView ? selectedContext : null;
    if (!isTutorView || !context || !selectedIds.length) return;
    const names = topics.filter((item) => selectedIds.includes(item.id)).map((item) => item.topic);
    const confirmed = window.confirm(
      `Permanently delete ${names.length} topic${names.length === 1 ? '' : 's'} from ${studentOptions.find((item) => item.id === studentFilter)?.name || 'this student'}?\n\nThis deletion cannot be undone. The topic records and all understanding scores for this subject episode will be permanently deleted and cannot be retrieved.`,
    );
    if (!confirmed) return;
    await runOperation({
      operationName: 'Permanently deleting topics',
      successMessage: 'The selected topics and their understanding scores were permanently deleted. Exercise generation has been queued.',
      failureMessage: 'Could not delete the selected topics.',
    }, async () => {
      const result = await deleteStudentTopics({
        studentId: context.studentId,
        subjectInstanceId: context.subjectInstanceId,
        subject: context.subject,
        topicIds: selectedIds,
        operationId: newOperationId(),
      });
      const updated = await getTopicOverviewForEpisode({ studentId: context.studentId, subjectInstanceId: context.subjectInstanceId });
      setTopics(updated.topics);
      setSelectedIds([]);
      return result;
    });
  };

  const title = 'Topics';
  const description = isTutorView
    ? 'Review topic progress across your assigned students and remove topics that should no longer drive exercises.'
    : 'Review the topics recorded for each of your subjects and the understanding scores saved for them.';
  const studentFilterOptions = isTutorView
    ? studentOptions
    : [{ id: profile?.uid || '', name: profile?.displayName || profile?.name || 'Student' }];

  return (
    <AppShell title={title} subtitle={description} role={viewerRole} user={profile} onLogout={logout}>
      <div className="space-y-6">
        <SectionHeader eyebrow="Learning progress" title="Topics" description={description} />
        <section className="panel space-y-5 p-5 sm:p-6">
          <div className="flex flex-wrap items-end gap-4">
            {isTutorView ? (
              <label className="grid min-w-56 gap-2 text-sm font-medium text-slate-300">
                Student
                <select className="input" value={studentFilter} onChange={(event) => setStudentFilter(event.target.value)}>
                  {studentFilterOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
            ) : null}
            <label className="grid min-w-48 gap-2 text-sm font-medium text-slate-300">
              Subject
              <select className="input" value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)}>
                {(isTutorView
                  ? subjectOptions.map((subject) => ({ id: subject, label: subject }))
                  : studentEpisodes.map((episode) => ({ id: episode.id, label: episode.subjectKey || episode.subjectName || 'Subject' })))
                  .map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <div className="rounded-xl border border-lime-400/25 bg-lime-400/10 px-4 py-2.5 text-sm text-lime-100">
              <span className="text-slate-300">{activeSubject || 'Subject'} understanding average</span>
              <strong className="ml-2 text-lg">{formatPercent(subjectAverage)}</strong>
            </div>
            {canDeleteTopics ? <button type="button" className="btn-secondary ml-auto inline-flex items-center gap-2 border-rose-400/30 px-4 py-2 text-rose-200 hover:border-rose-300 hover:text-rose-100" onClick={handleDelete} disabled={!selectedIds.length || !selectedContext}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />Delete selected{selectedIds.length ? ` (${selectedIds.length})` : ''}
            </button> : null}
          </div>

          {isLoading ? <LoadingState label="Loading topic records…" /> : null}
          {loadError ? <div className="rounded-xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-200" role="alert">{loadError}</div> : null}
          {!isLoading && !loadError ? (
            <div className="overflow-x-auto rounded-2xl border border-slate-700/70">
              <table className="min-w-[760px] w-full border-collapse text-left text-sm">
                <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600">
                  <tr>
                    {canDeleteTopics ? <th scope="col" className="w-12 px-4 py-3"><input aria-label="Select all topics" type="checkbox" checked={topics.length > 0 && selectedIds.length === topics.length} onChange={toggleAll} /></th> : null}
                    <th scope="col" className="px-4 py-3 font-semibold">Topic</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Labels</th>
                    <th scope="col" className="px-4 py-3 text-center font-semibold">Attended</th>
                    <th scope="col" className="px-4 py-3 text-center font-semibold">Manual</th>
                    <th scope="col" className="px-4 py-3 text-center font-semibold">Marked</th>
                    <th scope="col" className="px-4 py-3 text-center font-semibold">Understanding</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {topics.map((topic) => (
                    <tr key={topic.id} className={`align-middle transition ${selectedIds.includes(topic.id) ? 'bg-lime-400/10' : 'hover:bg-slate-800/50'}`}>
                      {canDeleteTopics ? <td className="px-4 py-4"><input aria-label={`Select ${topic.topic}`} type="checkbox" checked={selectedIds.includes(topic.id)} onChange={() => toggleTopic(topic.id)} /></td> : null}
                      <th scope="row" className="px-4 py-4 text-left font-semibold text-slate-900">{topic.topic}</th>
                      <td className="px-4 py-4"><div className="flex flex-wrap gap-1.5">{topic.labels.map((label) => <span key={`${topic.id}-${label}`} className="rounded-full bg-slate-700 px-2.5 py-1 text-xs text-slate-200">{label}</span>)}</div></td>
                      <td className="px-4 py-4 text-center"><StatusValue value={topic.attended} /></td>
                      <td className="px-4 py-4 text-center"><StatusValue value={topic.manual} /></td>
                      <td className="px-4 py-4 text-center"><StatusValue value={topic.marked} /></td>
                      <td className="px-4 py-4 text-center font-semibold text-lime-300">{formatPercent(topic.understandingLevel)}</td>
                    </tr>
                  ))}
                  {!topics.length ? <tr><td colSpan={canDeleteTopics ? 7 : 6} className="px-4 py-10 text-center text-slate-400">No completed or marked topics are recorded for this subject yet.</td></tr> : null}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </div>
      <OperationStatusOverlay
        state={operationStatus?.state}
        operationName={operationStatus?.operationName}
        message={operationStatus?.message}
        onDone={closeOperationStatus}
      />
    </AppShell>
  );
};
