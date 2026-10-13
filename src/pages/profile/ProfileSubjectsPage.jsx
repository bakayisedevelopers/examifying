import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { MultiSelectDropdown } from '../../components/common/MultiSelectDropdown';
import { useAuth } from '../../hooks/useAuth';
import { ROLES } from '../../lib/constants';
import { addStudentSubjects, getActiveSubjectsForStudent, getGlobalSubjects, getStudentSubjectHistoryOptions, getStudentSubscriptionState, getTutorMarksDocuments, removeUserSubject, updateUserSubjectAvailability } from '../../services/firestoreService';
import { deleteTutorMarksDocument, retryTutorMarksDocument, uploadTutorMarksDocument } from '../../services/storageService';
import { getApprovedTutorSubjects } from '../../utils/tutorSubjects';
import { useStudentSubscriptionState } from '../../hooks/useStudentSubscriptionState';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import { getTutorWhatsAppSettings, saveTutorWhatsAppGroupLink } from '../../services/whatsappService';
import { normalizeWhatsAppGroupInviteLink } from '../../utils/whatsapp';
import { getSubjectsAvailableForGrade, isSubjectAvailableForGrade } from '../../../functions/src/subjects.js';

const statusStyles = {
  processing: 'bg-amber-50 text-amber-700',
  done: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-rose-50 text-rose-700',
};

const formatDate = (value) => {
  if (!value) return 'Just now';
  if (value?.toDate) return value.toDate().toLocaleString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Just now' : date.toLocaleString();
};

export const ProfileSubjectsPage = ({ role, onboarding = false, onboardingNotice = '' }) => {
  const { profile, logout, refreshProfile, setProfileCompletionStatus, retryProfileCompletionCheck } = useAuth();
  const navigate = useNavigate();
  const { runOperation } = useOperationStatus();
  const isTutorRole = role === ROLES.TUTOR || role === 'teacher';
  const subscriptionState = useStudentSubscriptionState(role === ROLES.STUDENT ? profile : null);
  const [selectedSubjects, setSelectedSubjects] = useState([]);
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [documents, setDocuments] = useState([]);
  const [documentsLoading, setDocumentsLoading] = useState(isTutorRole);
  const [activeDocumentId, setActiveDocumentId] = useState('');
  const [activeStudentSubjects, setActiveStudentSubjects] = useState([]);
  const [activeStudentSubjectsLoading, setActiveStudentSubjectsLoading] = useState(role === ROLES.STUDENT);
  const [globalSubjects, setGlobalSubjects] = useState([]);
  const [globalSubjectsLoading, setGlobalSubjectsLoading] = useState(role === ROLES.STUDENT);
  const [historyCandidates, setHistoryCandidates] = useState([]);
  const [historyCandidatesLoading, setHistoryCandidatesLoading] = useState(false);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState([]);
  const [historyCapacity, setHistoryCapacity] = useState(0);
  const [whatsappGroupLinks, setWhatsAppGroupLinks] = useState({});
  const [whatsappGroupDrafts, setWhatsAppGroupDrafts] = useState({});
  const [whatsappSettingsLoading, setWhatsAppSettingsLoading] = useState(isTutorRole);
  const tutorUploadFormRef = useRef(null);
  const loadStudentSubjects = useCallback(async () => {
    if (role !== ROLES.STUDENT || !profile?.uid) { setActiveStudentSubjectsLoading(false); return; }
    setActiveStudentSubjectsLoading(true);
    try {
      setActiveStudentSubjects(await getActiveSubjectsForStudent(profile.uid));
    } finally {
      setActiveStudentSubjectsLoading(false);
    }
  }, [profile?.uid, role]);
  const currentSubjects = useMemo(() => {
    if (isTutorRole) return getApprovedTutorSubjects(profile);
    return role === ROLES.STUDENT ? activeStudentSubjects : [];
  }, [activeStudentSubjects, isTutorRole, profile, role]);
  const availableSubjects = getSubjectsAvailableForGrade(profile?.grade, globalSubjects)
    .filter((subject) => !currentSubjects.includes(subject));
  const restorableHistoryCandidates = historyCandidates.filter((candidate) =>
    isSubjectAvailableForGrade(candidate.subject, profile?.grade) && !currentSubjects.includes(candidate.subject));
  const subjectLimit = Number(subscriptionState?.subscriptionSubjectCount) || 0;
  const remainingSubjectSlots = Math.max(0, subjectLimit - currentSubjects.length - selectedSubjects.length);
  const tutorMarkBySubject = useMemo(() => new Map(
    (profile?.tutorSubjectMarks ?? []).map((item) => [item.subject, item.mark]),
  ), [profile?.tutorSubjectMarks]);
  const subjectAvailability = profile?.subjectAvailability ?? {};

  const completeStudentOnboarding = async () => {
    const [verifiedSubscription, activeSubjects] = await Promise.all([
      getStudentSubscriptionState(profile),
      getActiveSubjectsForStudent(profile.uid),
    ]);
    const paymentIsVerified = verifiedSubscription?.paymentCompleted === true
      && verifiedSubscription?.paidSubscriptionActive === true
      && verifiedSubscription?.subscriptionPaymentVerified === true;
    if (!paymentIsVerified) {
      await setProfileCompletionStatus('unpaid_incomplete');
      setStatus('We could not confirm an active payment. Please return to subscription checkout.');
      navigate('/student/billing', { replace: true });
      throw new Error('We could not confirm your active subscription. Please return to checkout.');
    }
    if (!activeSubjects.length) {
      setStatus('Add at least one subject before continuing.');
      throw new Error('Add at least one subject before continuing.');
    }
    await setProfileCompletionStatus('paid_completed');
    await refreshProfile(profile.uid);
    navigate('/student', { replace: true });
    return true;
  };

  const showTutorProgress = (message) => {
    if (onboarding) {
      setStatus('Checking your results document…');
      return;
    }
    setStatus(message);
  };

  const loadTutorDocuments = useCallback(async () => {
    if (!isTutorRole || !profile?.uid) { setDocumentsLoading(false); return; }
    setDocumentsLoading(true);
    try {
      const uploadedDocuments = await getTutorMarksDocuments(profile.uid);
      setDocuments(uploadedDocuments);
    } finally {
      setDocumentsLoading(false);
    }
  }, [isTutorRole, profile?.uid]);

  useEffect(() => {
    loadTutorDocuments().catch((error) => {
      setStatus(onboarding ? 'Uploaded results could not be loaded. You can still upload a new document.' : error.message || 'Could not load uploaded tutor documents.');
    });
  }, [loadTutorDocuments, onboarding]);

  useEffect(() => {
    if (!isTutorRole || !profile?.uid) return undefined;
    let active = true;
    setWhatsAppSettingsLoading(true);
    getTutorWhatsAppSettings().then((settings) => {
      if (!active) return;
      const links = settings.groupLinks || {};
      setWhatsAppGroupLinks(links);
      setWhatsAppGroupDrafts(links);
    }).catch((error) => {
      if (active) setStatus(error.message || 'Could not load WhatsApp group settings.');
    }).finally(() => { if (active) setWhatsAppSettingsLoading(false); });
    return () => { active = false; };
  }, [isTutorRole, profile?.uid]);

  useEffect(() => {
    loadStudentSubjects().catch((error) => setStatus(error.message || 'Could not load your active subjects.'));
  }, [loadStudentSubjects]);

  useEffect(() => {
    if (role !== ROLES.STUDENT) return undefined;
    let isActive = true;
    setGlobalSubjectsLoading(true);
    getGlobalSubjects().then((subjects) => {
      if (isActive) setGlobalSubjects(subjects);
    }).catch((error) => {
      if (isActive) {
        setGlobalSubjects([]);
        setStatus(error.message || 'Could not load the global subject list.');
      }
    }).finally(() => {
      if (isActive) setGlobalSubjectsLoading(false);
    });
    return () => { isActive = false; };
  }, [role]);

  useEffect(() => {
    if (role !== ROLES.STUDENT || !profile?.uid || !profile?.grade) { setHistoryCandidatesLoading(false); return undefined; }
    let isActive = true;
    setHistoryCandidatesLoading(true);
    getStudentSubjectHistoryOptions({ studentId: profile.uid, grade: profile.grade }).then((result) => {
      if (!isActive) return;
      setHistoryCandidates(Array.isArray(result.candidates) ? result.candidates : []);
      setHistoryCapacity(Number(result.subjectCapacity) || 0);
    }).catch(() => {
      if (isActive) {
        setHistoryCandidates([]);
        setHistoryCapacity(0);
      }
    }).finally(() => {
      if (isActive) setHistoryCandidatesLoading(false);
    });
    return () => { isActive = false; };
  }, [profile?.grade, profile?.uid, role]);

  const handleSubjectSelectionChange = (nextSubjects) => {
    if (nextSubjects.some((subject) => !isSubjectAvailableForGrade(subject, profile?.grade))) {
      setStatus(`Choose only subjects available for ${profile?.grade || 'your current grade'}.`);
      return;
    }
    if (currentSubjects.length + nextSubjects.length > subjectLimit) {
      setStatus(`Your subscription includes up to ${subjectLimit} subjects. Remove a current subject before adding another.`);
      return;
    }
    setSelectedSubjects(nextSubjects);
    setSelectedHistoryIds((current) => current.filter((id) => {
      const candidate = historyCandidates.find((item) => item.episodeId === id);
      return candidate && nextSubjects.includes(candidate.subject);
    }));
    setStatus('');
  };

  const handleRemoveSelectedSubject = (subject) => {
    setSelectedSubjects((current) => current.filter((item) => item !== subject));
    const candidate = historyCandidates.find((item) => item.subject === subject);
    if (candidate) setSelectedHistoryIds((current) => current.filter((id) => id !== candidate.episodeId));
  };

  const handleRestoreHistoryChoice = (candidate, checked) => {
    if (checked && !isSubjectAvailableForGrade(candidate.subject, profile?.grade)) {
      setStatus(`${candidate.subject} is not available for ${profile?.grade || 'your current grade'}.`);
      return;
    }
    if (checked && !selectedSubjects.includes(candidate.subject)) {
      if (currentSubjects.length + selectedSubjects.length >= subjectLimit) {
        setStatus(`Your subscription includes up to ${subjectLimit} subjects. Remove a current subject before adding another.`);
        return;
      }
      setSelectedSubjects((current) => [...current, candidate.subject]);
    }
    setSelectedHistoryIds((current) => checked
      ? [...new Set([...current, candidate.episodeId])]
      : current.filter((id) => id !== candidate.episodeId));
  };

  const handleAddStudentSubjects = async (event) => {
    event.preventDefault();
    if (!selectedSubjects.length) {
      setStatus('Choose at least one subject to add.');
      return;
    }
    if (selectedSubjects.some((subject) => !isSubjectAvailableForGrade(subject, profile?.grade))) {
      setStatus(`Choose only subjects available for ${profile?.grade || 'your current grade'}.`);
      return;
    }
    if (!subscriptionState?.paymentCompleted || currentSubjects.length + selectedSubjects.length > subjectLimit) {
      setStatus(`Your active subscription allows up to ${subjectLimit} subjects. Remove a current subject or update your subscription first.`);
      return;
    }

    try {
      setSaving(true);
      setStatus('Adding subjects...');
      await runOperation({ operationName: 'Adding subjects', successMessage: 'Your subjects were updated.' }, async () => {
        await addStudentSubjects({ studentId: profile.uid, subjects: selectedSubjects, restoreSubjectInstanceIds: selectedHistoryIds });
        await loadStudentSubjects();
        await refreshProfile(profile.uid);
        if (onboarding) await completeStudentOnboarding();
      });
      setStatus(onboarding ? 'Your profile is complete.' : `${selectedSubjects.join(', ')} added to your subjects.`);
      setSelectedSubjects([]);
      setSelectedHistoryIds([]);
    } catch (error) {
      setStatus(error.message || 'Could not add subjects.');
    } finally {
      setSaving(false);
    }
  };

  const handleTutorUpload = async (event) => {
    event.preventDefault();
    if (!file) {
      setStatus('Please choose a marks document first.');
      return;
    }

    const temporaryDocument = {
      id: `local-${Date.now()}`,
      fileName: file.name,
      status: 'processing',
      createdAt: new Date().toISOString(),
      addedSubjects: [],
      extractedMarks: [],
    };

    try {
      setSaving(true);
      setStatus('Uploading and checking marks...');
      setDocuments((current) => [temporaryDocument, ...current]);
      const uploadResult = await runOperation({ operationName: onboarding ? 'Checking your results document' : 'Uploading and processing tutor marks', successMessage: onboarding ? 'Your results document was checked.' : 'The marks document was processed.' }, () => uploadTutorMarksDocument({ file, tutor: profile, onProgress: showTutorProgress }));
      setResult(uploadResult);
      await refreshProfile(profile.uid);
      await loadTutorDocuments();
      setStatus(onboarding
        ? (uploadResult.addedSubjects.length ? 'Your eligible subject was saved.' : 'No new eligible subject was found. Upload a results document with a listed subject at 60% or above.')
        : uploadResult.addedSubjects.length ? `Added: ${uploadResult.addedSubjects.join(', ')}.` : 'No new eligible subjects were found at 60% or above.');
      tutorUploadFormRef.current?.reset();
      setFile(null);
    } catch (error) {
      setDocuments((current) => current.map((item) => item.id === temporaryDocument.id ? { ...item, status: 'failed', errorMessage: error.message } : item));
      setStatus(onboarding ? 'We could not read an eligible subject and result from that document. Please upload a clearer file or try again.' : error.message || 'Could not process marks document.');
      await loadTutorDocuments();
    } finally {
      setSaving(false);
    }
  };

  const handleRetry = async (documentRecord) => {
    try {
      setActiveDocumentId(documentRecord.id);
      setStatus(`Retrying ${documentRecord.fileName}...`);
      setDocuments((current) => current.map((item) => item.id === documentRecord.id ? { ...item, status: 'processing', errorMessage: '' } : item));
      const retryResult = await runOperation({ operationName: onboarding ? 'Checking your results document' : `Reprocessing ${documentRecord.fileName}`, successMessage: onboarding ? 'Your results document was checked.' : 'The marks document was processed.' }, () => retryTutorMarksDocument({ documentRecord, tutor: profile, onProgress: showTutorProgress }));
      setResult(retryResult);
      await refreshProfile(profile.uid);
      await loadTutorDocuments();
      setStatus(onboarding
        ? (retryResult.addedSubjects.length ? 'Your eligible subject was saved.' : 'No new eligible subject was found. Upload a results document with a listed subject at 60% or above.')
        : retryResult.addedSubjects.length ? `Added: ${retryResult.addedSubjects.join(', ')}.` : 'Retry complete. No new eligible subjects were found.');
    } catch (error) {
      setStatus(onboarding ? 'We could not read an eligible subject and result from that document. Please upload a clearer file or try again.' : error.message || 'Retry failed.');
      await loadTutorDocuments();
    } finally {
      setActiveDocumentId('');
    }
  };

  const handleDelete = async (documentRecord) => {
    const shouldDelete = window.confirm(`Delete ${documentRecord.fileName}?`);
    if (!shouldDelete) return;

    try {
      setActiveDocumentId(documentRecord.id);
      setStatus(`Deleting ${documentRecord.fileName}...`);
      await runOperation({ operationName: 'Deleting uploaded marks document', successMessage: 'The document and its uploaded file were deleted.' }, () => deleteTutorMarksDocument(documentRecord));
      setDocuments((current) => current.filter((item) => item.id !== documentRecord.id));
      setStatus('Document deleted.');
    } catch (error) {
      setStatus(error.message || 'Could not delete document.');
    } finally {
      setActiveDocumentId('');
    }
  };

  const handleRemoveSubject = async (subject) => {
    const shouldRemove = window.confirm(`Remove ${subject} from your profile?`);
    if (!shouldRemove) return;

    try {
      setSaving(true);
      setStatus(`Removing ${subject}...`);
      await runOperation({ operationName: `Removing ${subject}`, successMessage: 'The subject was removed.' }, async () => {
        await removeUserSubject({ uid: profile.uid, subject });
        await loadStudentSubjects();
        await refreshProfile(profile.uid);
      });
      setStatus(`${subject} removed from your profile.`);
    } catch (error) {
      setStatus(error.message || 'Could not remove subject.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStudentAvailability = async (subject) => {
    const nextAvailability = subjectAvailability[subject] === false;

    try {
      setSaving(true);
      setStatus(`${nextAvailability ? 'Activating' : 'Pausing'} ${subject}...`);
      await runOperation({ operationName: `${nextAvailability ? 'Activating' : 'Pausing'} ${subject}`, successMessage: 'Subject availability was updated.' }, async () => {
        await updateUserSubjectAvailability({ uid: profile.uid, subject, available: nextAvailability });
        await refreshProfile(profile.uid);
      });
      setStatus(`${subject} is now ${nextAvailability ? 'active' : 'paused'}.`);
    } catch (error) {
      setStatus(error.message || 'Could not update subject availability.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveWhatsAppGroup = async (subject, remove = false) => {
    try {
      const groupLink = remove ? '' : normalizeWhatsAppGroupInviteLink(whatsappGroupDrafts[subject] || '');
      setSaving(true);
      setStatus(`${remove ? 'Removing' : 'Saving'} ${subject} WhatsApp group link...`);
      const result = await runOperation({ operationName: `${remove ? 'Removing' : 'Saving'} ${subject} group link`, successMessage: 'The lesson group link was updated.' }, () => saveTutorWhatsAppGroupLink({ subject, groupLink }));
      setWhatsAppGroupLinks((current) => ({ ...current, [subject]: result.groupLink || '' }));
      setWhatsAppGroupDrafts((current) => ({ ...current, [subject]: result.groupLink || '' }));
      setStatus(result.groupLink ? `${subject} WhatsApp group link saved.` : `${subject} WhatsApp group link removed.`);
    } catch (error) {
      setStatus(error.message || 'Could not save the WhatsApp group link.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell title={onboarding ? 'Complete your profile' : 'Subjects'} subtitle={onboarding
      ? (isTutorRole ? 'Add a results document showing at least one catalogue subject at 60% or higher.' : 'Choose at least one subject included in your verified subscription.')
      : 'Manage the subjects connected to your Examifying account.'} role={role} user={profile} onLogout={logout}>
      {onboarding && profile?.onboardingStatusCheckFailed ? (
        <div className="panel flex flex-col gap-3 p-4 text-sm text-amber-100 sm:flex-row sm:items-center sm:justify-between" role="status">
          <span>We could not verify your profile status. Retry the check to continue.</span>
          <button type="button" className="btn-secondary" onClick={() => retryProfileCompletionCheck().catch(() => {})}>Retry check</button>
        </div>
      ) : null}
      {onboardingNotice ? <div className="panel border border-lime-300/30 p-4 text-sm text-lime-100" role="status">{onboardingNotice}</div> : null}
      <section className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-950">{onboarding && isTutorRole ? 'Eligible subjects' : 'Current subjects'}</p>
          {role === ROLES.STUDENT && subscriptionState?.paymentCompleted ? <p className="text-xs font-medium text-slate-500">{currentSubjects.length} of {subjectLimit} included subjects selected</p> : null}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {activeStudentSubjectsLoading ? <LoadingState className="sm:col-span-2 lg:col-span-3" label="Loading selected subjects…" /> : currentSubjects.length ? currentSubjects.map((subject) => {
            const isStudentSubjectActive = subjectAvailability[subject] !== false;

            return (
              <div key={subject} className="rounded-2xl bg-brand-50 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-brand-700">
                      {subject}
                      {isTutorRole && tutorMarkBySubject.has(subject) ? (
                        <span className="ml-2 rounded-full border border-lime-300 bg-lime-200 px-2 py-0.5 text-xs font-semibold text-slate-900">{tutorMarkBySubject.get(subject)}%</span>
                      ) : null}
                    </p>
                    {role === ROLES.STUDENT ? (
                      <p className={`mt-1 text-xs font-medium ${isStudentSubjectActive ? 'text-emerald-700' : 'text-slate-500'}`}>
                        {isStudentSubjectActive ? 'Active' : 'Paused'}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveSubject(subject)}
                    className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-white text-base font-bold leading-none text-rose-600 shadow-sm transition hover:bg-rose-50"
                    disabled={saving || onboarding}
                    aria-label={`Remove ${subject}`}
                    title={`Remove ${subject}`}
                  >
                    ×
                  </button>
                </div>

                {role === ROLES.STUDENT ? (
                  <button
                    type="button"
                    onClick={() => handleToggleStudentAvailability(subject)}
                    disabled={saving}
                    className={`hidden mt-3 flex w-full items-center justify-between rounded-full p-1 text-xs font-semibold transition ${isStudentSubjectActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}
                  >
                    <span className="px-3">{isStudentSubjectActive ? 'Available' : 'Unavailable'}</span>
                    <span className={`h-6 w-6 rounded-full bg-white shadow-sm transition ${isStudentSubjectActive ? 'translate-x-0' : ''}`} />
                  </button>
                ) : null}

                {isTutorRole && !onboarding ? (
                  <div className="mt-4 border-t border-lime-900/10 pt-3">
                    <label className="grid gap-2 text-xs font-semibold text-slate-800">
                      WhatsApp group invite link
                      <input
                        type="url"
                        className="input bg-white text-slate-900 placeholder:text-slate-500"
                        value={whatsappGroupDrafts[subject] || ''}
                        onChange={(event) => setWhatsAppGroupDrafts((current) => ({ ...current, [subject]: event.target.value }))}
                        placeholder={whatsappSettingsLoading ? 'Loading saved link…' : 'https://chat.whatsapp.com/...'}
                        disabled={saving || whatsappSettingsLoading}
                        aria-label={`${subject} WhatsApp group invite link`}
                      />
                    </label>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" className="btn-secondary h-9 px-3 text-xs" onClick={() => handleSaveWhatsAppGroup(subject)} disabled={saving || whatsappSettingsLoading || !whatsappGroupDrafts[subject]?.trim()}>
                        Save group link
                      </button>
                      {whatsappGroupLinks[subject] ? <button type="button" className="h-9 rounded-full border border-rose-300 px-3 text-xs font-semibold text-rose-700 transition hover:bg-rose-50" onClick={() => handleSaveWhatsAppGroup(subject, true)} disabled={saving || whatsappSettingsLoading}>
                        Remove
                      </button> : null}
                    </div>
                    <p className="mt-2 text-xs text-slate-600">Only students assigned to you for this subject can receive the invite in an upcoming online group lesson.</p>
                  </div>
                ) : null}
              </div>
            );
          }) : <span className="rounded-full bg-amber-50 px-3 py-1 text-sm font-semibold text-amber-700">No subjects added yet</span>}
        </div>
      </section>

      {role === ROLES.STUDENT && subscriptionState?.paymentCompleted ? (
        <form onSubmit={handleAddStudentSubjects} className="panel space-y-4 p-5">
          <div>
            <p className="text-sm font-semibold text-slate-950">Add subjects</p>
            <p className="mt-1 text-sm text-slate-500">Your plan allows {subjectLimit} registered {subjectLimit === 1 ? 'subject' : 'subjects'}. Remove a current subject to make room for a replacement.</p>
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-semibold text-slate-700" htmlFor="student-subject-multi-select">Choose subjects</label>
            <MultiSelectDropdown
              id="student-subject-multi-select"
              choices={availableSubjects}
              selectedValues={selectedSubjects}
              onChange={handleSubjectSelectionChange}
              maxSelections={Math.max(0, subjectLimit - currentSubjects.length)}
              placeholder={globalSubjectsLoading ? 'Loading subjects…' : !profile?.grade ? 'Set your grade to see eligible subjects' : 'Select one or more subjects'}
              emptyMessage={globalSubjectsLoading ? 'Loading subjects…' : `No additional subjects available for ${profile?.grade || 'your grade'}`}
              ariaLabel="Choose subjects to add"
              disabled={globalSubjectsLoading || !profile?.grade || currentSubjects.length >= subjectLimit}
            />
            {selectedSubjects.length ? <p className="text-xs text-slate-500">Selected subjects are added to the list below immediately. Choose Done to close this menu.</p> : null}
          </div>
          {globalSubjectsLoading ? <LoadingState className="min-h-12 p-3" label="Loading available subjects…" /> : null}
          {restorableHistoryCandidates.length || historyCandidatesLoading ? <fieldset className="space-y-2 rounded-2xl border border-lime-500/30 bg-transparent p-4">
            <legend className="px-1 text-xs font-semibold uppercase tracking-[0.15em] text-lime-300">Recent subject history (optional)</legend>
            <p className="text-xs text-slate-300">Choose a subject below if needed, then opt in to restore its previous topics and understanding scores. Staff and lessons are not copied.</p>
            <div className="space-y-2">
              {historyCandidatesLoading ? <LoadingState label="Loading eligible subject history…" /> : null}
              {restorableHistoryCandidates.map((candidate) => (
                <label key={candidate.episodeId} className="flex items-start gap-3 rounded-xl border border-slate-700 bg-transparent p-3 text-sm text-slate-200">
                  <input type="checkbox" className="mt-0.5" checked={selectedHistoryIds.includes(candidate.episodeId)} onChange={(event) => handleRestoreHistoryChoice(candidate, event.target.checked)} disabled={historyCapacity === 0 || !selectedSubjects.includes(candidate.subject) && remainingSubjectSlots === 0} />
                  <span><span className="font-semibold text-slate-100">{candidate.subject}</span><span className="block text-xs text-slate-400">Restore subject history from {new Date(candidate.cancelledAt).toLocaleDateString()} (capacity: {historyCapacity})</span></span>
                </label>
              ))}
            </div>
          </fieldset> : null}
          <div className="min-h-16 rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Selected subjects</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {selectedSubjects.length ? selectedSubjects.map((subject) => (
                <button
                  key={subject}
                  type="button"
                  onClick={() => handleRemoveSelectedSubject(subject)}
                  className="rounded-full border border-lime-500/50 bg-transparent px-3 py-1 text-sm font-semibold text-slate-900 shadow-sm transition hover:border-lime-300 hover:bg-lime-300 hover:text-slate-950"
                  title="Remove subject"
                >
                  {subject} ×
                </button>
              )) : <span className="text-sm text-slate-500">No subjects selected yet.</span>}
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <button className="btn-primary w-full md:w-auto" disabled={saving || !selectedSubjects.length || selectedSubjects.length > subjectLimit - currentSubjects.length}>Save subjects</button>
            {onboarding && currentSubjects.length > 0 && !selectedSubjects.length ? (
              <button type="button" className="btn-secondary w-full md:w-auto" disabled={saving} onClick={async () => {
                try {
                  setSaving(true);
                  await runOperation({ operationName: 'Completing your profile', successMessage: 'Your profile is complete.' }, completeStudentOnboarding);
                } catch (error) {
                  setStatus(error.message || 'Could not complete your profile. Please try again.');
                } finally {
                  setSaving(false);
                }
              }}>Continue to Examifying</button>
            ) : null}
          </div>
        </form>
      ) : role === ROLES.STUDENT ? (
          <div className="panel p-5 text-sm text-slate-200">Choose a subscription to manage registered subjects.</div>
      ) : null}

      {isTutorRole ? (
        <>
          <form ref={tutorUploadFormRef} onSubmit={handleTutorUpload} className="panel space-y-4 p-5">
            <div>
                <p className="text-sm font-semibold text-slate-950">{onboarding ? 'Add a results document' : 'Add more tutor subjects'}</p>
              <p className="mt-1 text-sm text-slate-600">Upload a PDF or image showing your results. Listed subjects with a result of 60% or higher can be added to your profile.</p>
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <input type="file" className="input" accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.heif" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              <button className="btn-primary" disabled={saving}>{saving ? 'Checking...' : 'Upload marks proof'}</button>
            </div>
          </form>

          <section className="panel p-5">
            <p className="text-sm font-semibold text-slate-950">{onboarding ? 'Document status' : 'Uploaded marks documents'}</p>
            <div className="mt-4 space-y-3">
              {documentsLoading ? <LoadingState label="Loading uploaded documents…" /> : null}
              {documents.map((documentRecord) => (
                <div key={documentRecord.id} className="rounded-2xl bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-900">{documentRecord.fileName}</p>
                      {!onboarding ? <p className="mt-1 text-xs text-slate-500">Uploaded {formatDate(documentRecord.createdAt)}</p> : null}
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyles[documentRecord.status] ?? 'bg-slate-100 text-slate-600'}`}>
                      {onboarding
                        ? documentRecord.status === 'done' ? 'Checked' : documentRecord.status === 'failed' ? 'Try again' : 'Checking'
                        : documentRecord.status ?? 'processing'}
                    </span>
                  </div>
                  {documentRecord.progressMessage && !onboarding ? <p className="mt-3 text-sm text-slate-600">{documentRecord.progressMessage}</p> : null}
                  {documentRecord.errorMessage ? <p className="mt-3 text-sm text-rose-700">{onboarding ? 'This file could not be checked. Please upload a clearer document or retry.' : documentRecord.errorMessage}</p> : null}
                  {documentRecord.addedSubjects?.length ? <p className="mt-3 text-sm text-emerald-700">Added: {documentRecord.addedSubjects.join(', ')}</p> : null}
                  {documentRecord.extractedMarks?.length ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {documentRecord.extractedMarks.map((item) => (
                        <span key={`${documentRecord.id}-${item.subject}-${item.mark}`} className="rounded-full border border-lime-500/40 bg-transparent px-3 py-1 text-xs font-medium text-slate-800">
                          {item.subject}: {item.mark}%
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button type="button" className="btn-secondary px-4 py-2" onClick={() => handleRetry(documentRecord)} disabled={activeDocumentId === documentRecord.id || documentRecord.status === 'processing'}>
                      Retry
                    </button>
                    {!onboarding ? <button type="button" className="rounded-full bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-600 transition hover:bg-rose-100" onClick={() => handleDelete(documentRecord)} disabled={activeDocumentId === documentRecord.id || documentRecord.status === 'processing'}>
                      Delete
                    </button> : null}
                  </div>
                </div>
              ))}
              {!documentsLoading && !documents.length ? <p className="text-sm text-slate-500">No marks documents have been uploaded yet.</p> : null}
            </div>
          </section>
        </>
      ) : null}

      {status ? <div className="panel p-5 text-sm text-slate-600">{status}</div> : null}
      {result?.extractedMarks?.length ? (
        <section className="panel p-5">
          <p className="text-sm font-semibold text-slate-950">Last extracted marks</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {result.extractedMarks.map((item) => (
              <div key={`${item.subject}-${item.mark}`} className="rounded-xl bg-slate-50 px-3 py-2 text-sm">
                <p className="font-semibold text-slate-900">{item.subject}</p>
                <p className={Number(item.mark) >= 60 ? 'text-emerald-600' : 'text-slate-500'}>{item.mark}%</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </AppShell>
  );
};
