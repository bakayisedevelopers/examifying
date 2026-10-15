Warning: truncated output (original token count: 36403)
Total output lines: 2314

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, HardDriveDownload, ListChecks, LoaderCircle, Pause, Play, RotateCcw, Save, Search, Sparkles, X } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { AppShell } from '../components/common/AppShell';
import { Logo } from '../components/common/Logo';
import { LoadingState } from '../components/common/LoadingState';
import { SectionHeader } from '../components/common/SectionHeader';
import { useStudentWorkspaceProfile } from '../hooks/useStudentWorkspaceProfile';
import { useOperationStatus } from '../hooks/useOperationStatus';
import { useStudentExercisePaperAccess } from '../hooks/useStudentExercisePaperAccess';
import { DEFAULT_SUBJECT, PAPER_MONTHS, PAPER_NUMBERS, REGIONS, ROLES, SOUTH_AFRICAN_GRADES, SUBJECTS } from '../lib/constants';
import { cancelQuestionPaperAnalysis, getDriveTopicCatalogAllSyncStatus, getGlobalTopicList, getGoogleDrivePastPaperFolderContents, getGoogleDrivePastPaperImportStatuses, getQuestionPaperAnalysisControl, getTopicResolverMappings, getTopicResolverSourceRecords, initializeGlobalTopicCatalog, previewDriveTopicCatalogSync, queueLegacyDriveJsonAnalyses, resolveTopicsWithGemini, saveQuestionPaper, saveTopicResolverMappings, setQuestionPaperAnalysisPaused, startDriveTopicCatalogAllSync, startGoogleDrivePastPaperImport, startGoogleDrivePastPaperImportAll, subscribeQuestionPapers, syncDriveTopicCatalog, updateQuestionPaper } from '../services/firestoreService';
import { uploadQuestionPaperDocuments } from '../services/storageService';
import { getApprovedTutorSubjects, getUserSubjects } from '../utils/tutorSubjects';
import { buildTopicResolverRows } from '../services/topicResolver';
import { detectUploaderPaperMonth } from '../utils/paperMonth';
import { getPublicQuestionPapers } from '../services/publicQuestionPaperService';

const paperStatusStyles = {
  Analyzing: 'bg-amber-400/15 text-amber-300 border border-amber-400/30',
  Analyzed: 'bg-lime-400/15 text-lime-300 border border-lime-400/30',
  Failed: 'bg-rose-400/15 text-rose-300 border border-rose-400/30',
  'Waiting for Drive JSON': 'bg-amber-400/15 text-amber-200 border border-amber-400/30',
  'Drive JSON review required': 'bg-orange-400/15 text-orange-200 border border-orange-400/30',
  Cancelled: 'bg-slate-800 text-slate-400 border border-slate-700',
};

const defaultPaperForm = (profile) => ({
  grade: profile?.grade || SOUTH_AFRICAN_GRADES[0],
  region: profile?.province || REGIONS[0],
  subject: DEFAULT_SUBJECT,
  year: new Date().getFullYear(),
  month: PAPER_MONTHS[0],
  paperNumber: PAPER_NUMBERS[0],
  notes: '',
  paperFile: null,
  memoFile: null,
});

const normalizeFileName = (name = '') => String(name).toLowerCase().replace(/\.[^.]+$/, '').replace(/memo|memorandum|marking|guideline|answers|answer|question|paper|qp/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const isMemoFile = (file) => /memo|memorandum|marking|guideline|answers|answer/i.test(file?.name ?? '');
const fileTokens = (file) => new Set(normalizeFileName(file?.name).split(' ').filter((token) => token.length > 1));

const analysisDriveStatus = (value) => value === 'Analyzing'
  ? 'analyzing'
  : value === 'Analyzed'
    ? 'analyzed'
    : ['Failed', 'Cancelled'].includes(value)
      ? 'analysis-failed'
      : '';

const mergeDriveImportStatuses = (contents, statuses = []) => {
  if (!contents) return contents;
  const statusByFileId = new Map(statuses.map((item) => [item.fileId, item]));
  const importingStatuses = new Set(['importing', 'processing']);
  const completedStatuses = new Set(['imported', 'duplicate', 'review']);
  return {
    ...contents,
    papers: contents.papers.map((group) => {
      const mergeFile = (file) => {
        const nextStatus = statusByFileId.get(file.id);
        return nextStatus ? { ...file, ...nextStatus } : file;
      };
      const files = group.files.map(mergeFile);
      const questionFiles = group.questionFiles.map(mergeFile);
      const memoFiles = group.memoFiles.map(mergeFile);
      const importingQuestion = questionFiles.some((file) => importingStatuses.has(file.importStatus));
      const importingMemo = memoFiles.some((file) => importingStatuses.has(file.importStatus));
      const questionStatus = questionFiles[0];
      const memoStatus = memoFiles[0];
      const targetAnalysisStatus = analysisDriveStatus(questionStatus?.analysisStatus);
      const importing = importingQuestion || importingMemo;
      const importFileIds = importing
        ? []
        : group.importFileIds.filter((fileId) => {
          const status = statusByFileId.get(fileId)?.importStatus;
          return !completedStatuses.has(status);
        });
      return {
        ...group,
        files,
        questionFiles,
        memoFiles,
        paperStatus: group.reviewReason
          ? 'review'
          : importingQuestion
            ? 'importing'
            : ['imported', 'duplicate'].includes(questionStatus?.importStatus)
              ? (targetAnalysisStatus || 'uploaded')
              : questionStatus?.importStatus === 'failed'
                ? 'import-failed'
                : group.paperStatus,
        memoStatus: group.reviewReason
          ? 'review'
          : importingMemo
            ? 'importing'
            : memoStatus?.importStatus === 'imported' || memoStatus?.importStatus === 'duplicate'
              ? 'uploaded'
              : memoStatus?.importStatus === 'failed'
                ? 'import-failed'
                : group.memoStatus,
        importFileIds,
      };
    }),
  };
};

const driveImportStageLabels = {
  downloading: 'Downloading from Drive',
  validating: 'Checking PDF',
  checking_existing_records: 'Checking for duplicates',
  uploading_memo: 'Uploading memo to Storage',
  saving_memo_reference: 'Saving memo reference',
  uploading_question_paper: 'Uploading paper to Storage',
  saving_paper_record: 'Saving paper and starting analysis',
};

const openLocalFilePreview = (file) => {
  if (!file) return;
  const url = URL.createObjectURL(file);
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

const overlapScore = (leftFile, rightFile) => {
  const left = fileTokens(leftFile);
  const right = fileTokens(rightFile);
  return [...left].filter((token) => right.has(token)).length;
};

const inferMetadataFromName = (file, profile) => {
  const name = file?.name ?? '';
  const lower = name.toLowerCase();
  const filenameWords = lower.replace(/[^a-z0-9]+/g, ' ');
  const year = Number(lower.match(/\b(20\d{2}|19\d{2})\b/)?.[1]) || new Date().getFullYear();
  const month = detectUploaderPaperMonth(name);
  const examplarDetected = /\b(?:examplar|exemplar)(?=\b|[0-9])/i.test(filenameWords);
  const detectedPaperNumber = PAPER_NUMBERS.find((item) => {
    const number = item.match(/\d/)?.[0];
    return number && new RegExp(`(?:paper|p|paper\\s*)\\s*${number}|${number}[^0-9]*paper`, 'i').test(name);
  });
  const paperNumber = examplarDetected
    ? 'Examplar'
    : detectedPaperNumber ?? PAPER_NUMBERS[0];
  const subject = SUBJECTS.find((item) => lower.includes(item.toLowerCase().replace(/\s+/g, ' '))) ?? DEFAULT_SUBJECT;
  const grade = SOUTH_AFRICAN_GRADES.find((item) => item !== 'Select Grade' && lower.includes(item.toLowerCase())) ?? profile?.grade ?? SOUTH_AFRICAN_GRADES[0];
  const region = REGIONS.find((item) => lower.includes(item.toLowerCase())) ?? profile?.province ?? REGIONS[0];
  return { grade, region, subject, year, month, paperNumber };
};

const makeBulkFileEntry = (file) => ({
  id: `bulk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  file,
});

const pairAvailableBulkMemos = (rows, memoEntries) => {
  const nextRows = rows.map((row) => ({ ...row }));
  const remainingMemos = [];
  memoEntries.forEach((entry) => {
    let bestRowIndex = -1;
    let bestScore = 0;
    nextRows.forEach((row, index) => {
      if (row.memoFile || row.paperFileId === entry.id) return;
      const score = overlapScore(row.paperFile, entry.file);
      if (score > bestScore) {
        bestScore = score;
        bestRowIndex = index;
      }
    });
    if (bestRowIndex >= 0) {
      nextRows[bestRowIndex] = {
        ...nextRows[bestRowIndex],
        memoFile: entry.file,
        memoFileId: entry.id,
      };
    } else {
      remainingMemos.push(entry);
    }
  });
  return { rows: nextRows, memoFiles: remainingMemos };
};

const buildBulkRows = ({ files, profile }) => {
  const allEntries = Array.from(files ?? [], makeBulkFileEntry);
  const memoEntries = allEntries.filter(({ file }) => isMemoFile(file));
  const paperEntries = allEntries.filter(({ file }) => !isMemoFile(file));
  const usedMemoIndexes = new Set();

  const rows = paperEntries.map((paperEntry, index) => {
    let bestMemoIndex = -1;
    let bestScore = 0;
    memoEntries.forEach((memoEntry, memoIndex) => {
      if (usedMemoIndexes.has(memoIndex)) return;
      const score = overlapScore(paperEntry.file, memoEntry.file);
      if (score > bestScore) {
        bestScore = score;
        bestMemoIndex = memoIndex;
      }
    });
    const memoEntry = bestScore > 0 && bestMemoIndex >= 0 ? memoEntries[bestMemoIndex] : null;
    if (bestMemoIndex >= 0) usedMemoIndexes.add(bestMemoIndex);
    return {
      id: paperEntry.id || `bulk-row-${Date.now()}-${index}`,
      paperFileId: paperEntry.id,
      paperFile: paperEntry.file,
      memoFileId: memoEntry?.id ?? '',
      memoFile: memoEntry?.file ?? null,
      ...inferMetadataFromName(paperEntry.file, profile),
      notes: '',
    };
  });
  return {
    rows,
    memoFiles: memoEntries.filter((_, index) => !usedMemoIndexes.has(index)),
  };
};

const PaperAnalysisStatus = ({ paper }) => {
  const status = paper.driveAnalysisJsonStatus === 'review_required' && !['Analyzed', 'Analyzing'].includes(paper.analysisStatus)
    ? 'Drive JSON review required'
    : paper.analysisStatus ?? (paper.availableForGeneration ? 'Analyzed' : 'Analyzing');
  const current = Number(paper.analysisProgressCurrent ?? 0);
  const total = Math.max(1, Number(paper.analysisProgressTotal ?? 1));
  const percentage = status === 'Analyzed' ? 100 : Math.max(0, Math.min(100, Math.round((current / total) * 100)));
  const sourceLabel = paper.analysisSource === 'google_drive_json'
    ? 'Drive JSON'
    : paper.analysisSource === 'firebase_ai'
      ? 'AI analysis'
      : paper.analysisSource === 'checking_drive_json'
        ? 'Checking Drive JSON'
        : '';

  return (
    <div className="mt-4 rounded-2xl bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-3 text-xs font-semibold">
        <span className={`rounded-full px-3 py-1 ${paperStatusStyles[status] ?? 'bg-slate-100 text-slate-600'}`}>{status}</span>
        <span className="flex items-center gap-2 text-slate-500">
          {sourceLabel ? <span className="rounded-full bg-lime-100 px-2 py-0.5 text-[10px] font-semibold text-lime-900">{sourceLabel}</span> : null}
          {percentage}%
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200">
        <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${percentage}%` }} />
      </div>
      <p className="mt-2 text-xs text-slate-500">{status === 'Drive JSON review required'
        ? 'A matching Drive JSON was found but failed validation.'
        : paper.analysisProgressMessage ?? (status === 'Analyzed' ? `${paper.questionCount ?? 0} questions indexed` : 'Waiting for analysis')}</p>
      {paper.driveAnalysisJsonStatus === 'review_required' && paper.driveAnalysisJsonReviewReason ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">Drive analysis JSON needs review: {paper.driveAnalysisJsonReviewReason}</p>
      ) : null}
      {status === 'Failed' && paper.analysisError ? (
        <p className="mt-2 rounded-lg border border-rose-300 bg-rose-50 p-2 text-xs text-rose-900"><span className="font-semibold">Failure reason:</span> {paper.analysisError}</p>
      ) : null}
    </div>
  );
};

const canQueuePaperAnalysis = (paper) => paper?.analysisStatus !== 'Analyzing';
const reanalysisButtonLabel = (paper) => paper?.analysisStatus === 'Failed' ? 'Retry analysis' : 'Run analysis again';
const canManagePaperAnalysis = (role) => role === ROLES.ADMIN || role === ROLES.TUTOR;
const canUploadPapers = (role) => role === ROLES.ADMIN;
const canStopPaperAnalysis = (paper) =>
  paper?.analysisStatus === 'Analyzing' || Boolean(paper?.activeAnalysisRunId || paper?.queuedAnalysisRunId);
const makeAnalysisRetryPatch = () => ({
  analysisStatus: 'Analyzing',
  availableForGeneration: false,
  analysisSource: 'checking_drive_json',
  analysisProgressMessage: 'Queued to check for matching Google Drive analysis JSON',
  analysisProgressCurrent: 0,
  analysisProgressTotal: 1,
  analysisError: '',
  driveAnalysisJsonStatus: 'pending',
  driveAnalysisJsonReviewReason: '',
  analysisRevision: Date.now(),
  questions: [],
  topics: [],
  questionCount: 0,
  paperMetadata: {},
  paperAnalysisSummary: '',
  paperDocumentAnalysis: '',
  paperDocumentAnalysisModel: '',
  analysisVisionModels: [],
  analysisBatchOutputs: [],
});
const getPaperTitle = (paper) => paper.title || paper.paperName || paper.paperFileName?.replace(/\.[^.]+$/, '') ||
  paper.paperTitle || paper.paperMetadata?.paperTitle || paper.displayName || `${paper.subject || 'Question paper'} • ${paper.grade || ''}`;
const getPaperDateValue = (value) => value?.toMillis?.() ?? new Date(value?.toDate?.() ?? value ?? 0).getTime();
const getPaperField = (paper, field) => paper?.[field] ?? paper?.paperMetadata?.[field] ?? '';
const getPaperNumberSortValue = (paper) => {
  const paperNumber = String(getPaperField(paper, 'paperNumber')).match(/\d+/)?.[0];
  return paperNumber ? Number(paperNumber) : Number.MAX_SAFE_INTEGER;
};
const getPaperSubject = (paper) => String(getPaperField(paper, 'subject') ?? '').trim().replace(/\s+/g, ' ');
const normalizePaperSubject = (subject) => String(subject ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const getPaperSearchText = (paper) => [
  paper.displayName,
  paper.title,
  paper.paperName,
  paper.paperTitle,
  paper.paperFileName,
  paper.memoFileName,
  paper.subject,
  paper.grade,
  paper.region,
  paper.examBoard,
  paper.province,
  paper.month,
  paper.year,
  paper.paperNumber,
  paper.notes,
  ...Object.entries(paper).filter(([, value]) => typeof value === 'string' || typeof value === 'number').map(([, value]) => value),
  ...Object.values(paper.paperMetadata ?? {}),
].filter(Boolean).join(' ').toLowerCase();

const PublicPaperShell = ({ children }) => (
  <div className="min-h-screen bg-slate-950 text-slate-100">
    <header className="sticky top-0 z-30 border-b border-lime-500/20 bg-slate-950/90 shadow-[0_4px_25px_rgba(0,0,0,0.4)] backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link to="/" aria-label="Examifying home" className="rounded-xl transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-300">
          <Logo />
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          <Link to="/login" className="rounded-full border border-white/10 px-4 py-2 text-xs font-semibold text-slate-300 transition hover:border-lime-300/40 hover:text-white sm:text-sm">Sign in</Link>
          <Link to="/signup" className="rounded-full bg-gradient-to-r from-lime-300 to-emerald-300 px-4 py-2 text-xs font-bold text-slate-950 shadow-[0_0_18px_rgba(163,230,53,0.18)] transition hover:brightness-110 sm:text-sm">Create account</Link>
        </div>
      </div>
    </header>
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-7 sm:px-6 sm:py-9">{children}</main>
  </div>
);

export const PastExamPapersPage = () => {
  const { profile, user, logout, isParentWorkspace, toStudentPath } = useStudentWorkspaceProfile();
  const location = useLocation();
  const isPublicCatalog = location.pathname === '/papers';
  const { runOperation } = useOperationStatus();
  const [papers, setPapers] = useState([]);
  const [isLoadingPapers, setIsLoadingPapers] = useState(true);
  const [status, setStatus] = useState('');
  const [driveImportRunning, setDriveImportRunning] = useState(false);
  const [driveFullImportRunning, setDriveFullImportRunning] = useState(false);
  const [driveImportMessage, setDriveImportMessage] = useState('');
  const [driveExplorerOpen, setDriveExplorerOpen] = useState(false);
  const [driveFolderContents, setDriveFolderContents] = useState(null);
  const [driveFolderTrail, setDriveFolderTrail] = useState([]);
  const [driveFolderLoading, setDriveFolderLoading] = useState(false);
  const [analysisQueuePaused, setAnalysisQueuePaused] = useState(false);
  const [analysisQueueActivePaperId, setAnalysisQueueActivePaperId] = useState('');
  const [analysisQueueControlReady, setAnalysisQueueControlReady] = useState(false);
  const [analysisQueueControlFailed, setAnalysisQueueControlFailed] = useState(false);
  const [analysisQueueControlSaving, setAnalysisQueueControlSaving] = useState(false);
  const [analysisQueueMessage, setAnalysisQueueMessage] = useState('');
  const [driveTopicAllSyncJob, setDriveTopicAllSyncJob] = useState(null);
  const [driveTopicAllSyncStarting, setDriveTopicAllSyncStarting] = useState(false);
  const [driveTopicAllSyncError, setDriveTopicAllSyncError] = useState('');
  const [failedRetryAllLoading, setFailedRetryAllLoading] = useState(false);
  const [waitingRetryAllLoading, setWaitingRetryAllLoading] = useState(false);
  const [uploadTab, setUploadTab] = useState('single');
  const [singleForm, setSingleForm] = useState(defaultPaperForm(profile));
  const [bulkRows, setBulkRows] = useState([]);
  const [bulkMemoFiles, setBulkMemoFiles] = useState([]);
  const bulkAdditionalInputRef = useRef(null);
  const [filters, setFilters] = useState({ subject: 'all', year: 'all' });
  const [adminPaperFilters, setAdminPaperFilters] = useState({
    analyzing: { search: '', subject: 'all', year: 'all' },
    analyzed: { search: '', subject: 'all', year: 'all' },
    failed: { search: '', subject: 'all', year: 'all' },
    waiting: { search: '', subject: 'all', year: 'all' },
    review: { search: '', subject: 'all', year: 'all' },
  });
  const [studentFilterOverrides, setStudentFilterOverrides] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const [downloadingDocument, setDownloadingDocument] = useState('');
  const [downloadStatus, setDownloadStatus] = useState('');
  const [editingPaper, setEditingPaper] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [topicResolverOpen, setTopicResolverOpen] = useState(false);
  const [topicResolverSubject, setTopicResolverSubject] = useState('');
  const [topicResolverGrade, setTopicResolverGrade] = useState('');
  const [topicResolverRows, setTopicResolverRows] = useState([]);
  const [topicResolverCatalog, setTopicResolverCatalog] = useState([]);
  const [topicResolverCorrections, setTopicResolverCorrections] = useState({});
  const [topicResolverMethods, setTopicResolverMethods] = useState({});
  const [topicResolverReviewed, setTopicResolverReviewed] = useState(false);
  const [topicResolverSearch, setTopicResolverSearch] = useState('');
  const [topicResolverStatus, setTopicResolverStatus] = useState('');
  const [topicResolverLoading, setTopicResolverLoading] = useState(false);
  const [topicResolverGeminiLoading, setTopicResolverGeminiLoading] = useState(false);
  const [topicResolverSaveLoading, setTopicResolverSaveLoading] = useState(false);
  const [topicResolverCleanupLoading, setTopicResolverCleanupLoading] = useState(false);
  const [driveTopicSyncPreview, setDriveTopicSyncPreview] = useState(null);
  const [driveTopicSyncApplying, setDriveTopicSyncApplying] = useState(false);
  const [legacyDriveAnalysisQueueLoading, setLegacyDriveAnalysisQueueLoading] = useState(false);

  useEffect(() => {
    if (!topicResolverOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [topicResolverOpen]);

  const role = useMemo(() => isPublicCatalog ? ROLES.STUDENT : profile?.role ?? ROLES.STUDENT, [isPublicCatalog, profile]);
  const routeRole = location.pathname.startsWith('/teacher') ? 'teacher' : role;
  const paperPath = (paperId) => isPublicCatalog
    ? `/papers/${paperId}`
    : isParentWorkspace
      ? toStudentPath(`/student/papers/${paperId}`)
      : `/${routeRole}/papers/${paperId}`;
  const memoAccess = useStudentExercisePaperAccess(profile?.uid ?? user?.uid, role === ROLES.STUDENT && !isPublicCatalog);
  useEffect(() => {
    if (role !== ROLES.ADMIN) return undefined;
    let active = true;
    setAnalysisQueueControlReady(false);
    setAnalysisQueueControlFailed(false);
    getQuestionPaperAnalysisControl().then((control) => {
      if (!active) return;
      setAnalysisQueuePaused(control.paused === true);
      setAnalysisQueueActivePaperId(String(control.activePaperId ?? ''));
      setAnalysisQueueControlReady(true);
      setAnalysisQueueControlFailed(false);
      setAnalysisQueueMessage('');
    }).catch((error) => {
      if (!active) return;
      setAnalysisQueueControlFailed(true);
      setAnalysisQueueMessage(error.message || 'Could not load the analysis queue status. Refresh the page and try again.');
    });
    return () => { active = false; };
  }, [role]);
  useEffect(() => {
    if (role !== ROLES.ADMIN) return undefined;
    let active = true;
    getDriveTopicCatalogAllSyncStatus().then((job) => {
      if (active && job?.jobId) setDriveTopicAllSyncJob(job);
    }).catch((error) => {
      if (active) setDriveTopicAllSyncError(error.message || 'Could not load the latest topic-sync status.');
    });
    return () => { active = false; };
  }, [role]);
  useEffect(() => {
    if (role !== ROLES.ADMIN || driveTopicAllSyncJob?.status !== 'running' || !driveTopicAllSyncJob?.jobId) return undefined;
    let active = true;
    const interval = setInterval(() => {
      getDriveTopicCatalogAllSyncStatus({ jobId: driveTopicAllSyncJob.jobId }).then((job) => {
        if (active) setDriveTopicAllSyncJob(job);
      }).catch((error) => {
        if (active) setDriveTopicAllSyncError(error.message || 'Could not refresh the topic-sync status.');
      });
    }, 10000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [role, driveTopicAllSyncJob?.jobId, driveTopicAllSyncJob?.status]);
  const allowedSubjects = useMemo(() => {
    if (role === ROLES.ADMIN) return SUBJECTS;
    if (role === ROLES.TUTOR) return getApprovedTutorSubjects(profile);
    return getUserSubjects(profile);
  }, [profile, role]);
  const visibleSubjects = allowedSubjects.length ? allowedSubjects : SUBJECTS;
  const usesStudentCatalog = isPublicCatalog || [ROLES.STUDENT, ROLES.PARENT, ROLES.TUTOR, 'teacher'].includes(role);
  const isStudentExploring = Boolean(searchTerm.trim()) || Object.keys(studentFilterOverrides).length > 0;
  const studentFilterValues = { subject: 'all', grade: 'all', year: 'all', region: 'all', month: 'all', paperNumber: 'all', ...studentFilterOverrides };

  const handleToggleAnalysisQueue = async () => {
    if (!analysisQueueControlReady || analysisQueueControlSaving) return;
    const paused = !analysisQueuePaused;
    setAnalysisQueueControlSaving(true);
    setAnalysisQueueMessage('');
    try {
      const result = await setQuestionPaperAnalysisPaused(paused);
      setAnalysisQueuePaused(result.paused === true);
      setAnalysisQueueActivePaperId(String(result.activePaperId ?? ''));
      setAnalysisQueueMessage(paused
        ? 'The queue …24403 tokens truncated…vent) => addBulkMemoFile(row.id, event)} />
                              </label>
                              <button type="button" className="btn-secondary text-xs" onClick={() => convertBulkMemoToPaper(row.id)} disabled={!row.memoFile}>Convert memo to paper</button>
                              <button type="button" className="btn-secondary text-xs" onClick={() => removeBulkRow(row.id)}>Remove paper</button>
                            </div>
                          </td>
                        </tr>
                      ); })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
            <input ref={bulkAdditionalInputRef} type="file" className="sr-only" multiple accept=".pdf,application/pdf" onChange={handleAddMoreBulkFiles} />
            <button type="button" className="btn-secondary w-full" onClick={() => bulkAdditionalInputRef.current?.click()}>Add more papers or memos</button>
            {bulkRows.length ? <button type="button" className="btn-primary w-full" onClick={handleBulkSubmit}>Upload reviewed papers</button> : null}
          </div>
        )}
        {status ? <p className="text-sm text-slate-600">{status}</p> : null}
      </section> : null}

      {canManagePaperAnalysis(role) && editingPaper && editForm ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/50 p-4">
          <form onSubmit={handleEditSubmit} className="panel max-h-[90dvh] w-full max-w-4xl overflow-y-auto p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.25em] text-brand-700">Edit paper</p>
                <h2 className="mt-2 text-2xl font-bold text-slate-950">{editingPaper.displayName || editingPaper.paperFileName || 'Question paper'}</h2>
                <p className="mt-1 text-sm text-slate-500">Replacing the question-paper file queues it for analysis again. Memo and metadata changes save without re-analysis.</p>
              </div>
              <button type="button" className="btn-secondary" onClick={closeEditPaper}>Close</button>
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <UploadFields value={editForm} onChange={(patch) => setEditForm((current) => ({ ...current, ...patch }))} subjects={visibleSubjects} />
              {canUploadPapers(role) ? <>
                <label className="md:col-span-2"><span className="label">Replace question paper optional</span><input type="file" className="input" accept=".pdf,application/pdf" onChange={(event) => setEditForm((current) => ({ ...current, paperFile: event.target.files?.[0] ?? null }))} /><span className="mt-1 block text-xs text-slate-500">PDF only. Current: {editingPaper.paperFileName || 'No paper file name stored'}</span></label>
                <label className="md:col-span-2"><span className="label">Replace memorandum optional</span><input type="file" className="input" accept=".pdf,application/pdf" onChange={(event) => setEditForm((current) => ({ ...current, memoFile: event.target.files?.[0] ?? null, removeMemo: false }))} /><span className="mt-1 block text-xs text-slate-500">PDF only. Current: {editingPaper.memoFileName || 'No memo uploaded'}</span></label>
                {editingPaper.memoUrl ? <label className="md:col-span-2 flex items-center gap-3 text-sm font-semibold text-slate-700"><input type="checkbox" checked={editForm.removeMemo} onChange={(event) => setEditForm((current) => ({ ...current, removeMemo: event.target.checked, memoFile: event.target.checked ? null : current.memoFile }))} /> Remove current memorandum</label> : null}
              </> : null}
              <div className="flex flex-wrap gap-3 md:col-span-2">
                <button type="submit" className="btn-primary">Save metadata changes</button>
                {canManagePaperAnalysis(role) && canQueuePaperAnalysis(editingPaper) ? <button type="button" className="btn-secondary" onClick={() => queuePaperReanalysis(editingPaper).then(closeEditPaper).catch((error) => setStatus(error.message || 'Could not retry analysis.'))}>{reanalysisButtonLabel(editingPaper)}</button> : null}
              </div>
            </div>
          </form>
        </div>
      ) : null}
      {role === ROLES.ADMIN && topicResolverOpen ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto overscroll-contain bg-slate-950/70 p-3 md:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !topicResolverLoading && !topicResolverGeminiLoading && !topicResolverSaveLoading && !topicResolverCleanupLoading && !driveTopicSyncApplying && !legacyDriveAnalysisQueueLoading) setTopicResolverOpen(false); }}>
          <section className="panel flex h-[calc(100dvh-1.5rem)] max-h-[calc(100dvh-1.5rem)] min-h-0 w-full max-w-7xl flex-col overflow-hidden border-slate-700 bg-slate-900 p-4 md:h-[calc(100dvh-3rem)] md:max-h-[calc(100dvh-3rem)] md:p-6" role="dialog" aria-modal="true" aria-labelledby="topic-resolver-title">
            <div className="flex shrink-0 items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-lime-400">Admin review</p>
                <h2 id="topic-resolver-title" className="mt-2 text-xl font-bold text-white md:text-2xl">Topic resolver preview</h2>
                <p className="mt-2 max-w-3xl text-sm text-slate-300">Review Firestore topic matches and Google Gemini suggestions for one subject and grade. Saving reviewed mappings also copies each distinct resolved Child | Parent label into that grade’s global topic list. Duplicate labels are skipped; analyzed paper records are not changed.</p>
              </div>
              <button type="button" className="btn-secondary h-10 w-10 flex-none p-0" aria-label="Close topic resolver" title="Close" onClick={() => setTopicResolverOpen(false)} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading || topicResolverCleanupLoading || driveTopicSyncApplying || legacyDriveAnalysisQueueLoading}><X className="mx-auto h-4 w-4" /></button>
            </div>

            <div className="topic-resolver-scroll mt-5 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2" aria-label="Topic resolver results and controls" tabIndex={0}>
            <div className="grid shrink-0 gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_auto_auto]">
              <label className="grid gap-2 text-sm font-semibold text-slate-200">Subject
                  <select className="input" value={topicResolverSubject} onChange={(event) => { setTopicResolverSubject(event.target.value); setTopicResolverRows([]); setTopicResolverCatalog([]); setTopicResolverCorrections({}); setTopicResolverMethods({}); setTopicResolverReviewed(false); setDriveTopicSyncPreview(null); }} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading || topicResolverCleanupLoading || driveTopicSyncApplying || legacyDriveAnalysisQueueLoading}>
                  <option value="">Choose subject</option>
                  {SUBJECTS.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
                </select>
              </label>
              <label className="grid gap-2 text-sm font-semibold text-slate-200">Grade
                  <select className="input" value={topicResolverGrade} onChange={(event) => { setTopicResolverGrade(event.target.value); setTopicResolverRows([]); setTopicResolverCatalog([]); setTopicResolverCorrections({}); setTopicResolverMethods({}); setTopicResolverReviewed(false); setDriveTopicSyncPreview(null); }} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading || topicResolverCleanupLoading || driveTopicSyncApplying || legacyDriveAnalysisQueueLoading}>
                  <option value="">Choose grade</option>
                  {SOUTH_AFRICAN_GRADES.filter((grade) => grade !== 'Select Grade').map((grade) => <option key={grade} value={grade}>{grade}</option>)}
                </select>
              </label>
              <button type="button" className="btn-primary inline-flex items-center justify-center gap-2 self-end" onClick={searchTopicResolver} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading || topicResolverCleanupLoading || driveTopicSyncApplying || legacyDriveAnalysisQueueLoading || !topicResolverSubject || !topicResolverGrade}>
                {topicResolverLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Search Firestore
              </button>
              <button type="button" className="btn-secondary inline-flex items-center justify-center gap-2 self-end" onClick={checkGlobalTopicCatalog} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading || topicResolverCleanupLoading || driveTopicSyncApplying || legacyDriveAnalysisQueueLoading || !topicResolverSubject || !topicResolverGrade}>
                {topicResolverCleanupLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ListChecks className="h-4 w-4" />}
                Preview topic sync
              </button>
            </div>

            {driveTopicSyncPreview ? (
              <section className="mt-4 rounded-xl border border-lime-300/30 bg-lime-300/5 p-4" aria-label="Drive topic sync preview">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="font-semibold text-white">Firestore and Drive preview</h3>
                    <p className="mt-1 text-sm text-slate-300">{driveTopicSyncPreview.analyzedTopicCount} topics from {driveTopicSyncPreview.analyzedPaperCount} analyzed papers • {driveTopicSyncPreview.currentTopicCount} currently in Firestore • {driveTopicSyncPreview.topicsFileExists ? 'topics.json will be updated' : 'topics.json will be created'} in “{driveTopicSyncPreview.driveFolderName}”.</p>
                    <p className="mt-2 text-xs text-amber-200">Applying this preview replaces the selected grade’s global topic list with topics referenced by analyzed questions. Existing student topic history is not changed.</p>
                  </div>
                  <button type="button" className="btn-primary inline-flex shrink-0 items-center justify-center gap-2" onClick={applyDriveTopicCatalogSync} disabled={driveTopicSyncApplying || topicResolverCleanupLoading || !driveTopicSyncPreview.previewToken}>
                    {driveTopicSyncApplying ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {driveTopicSyncApplying ? 'Syncing…' : 'Apply Firestore + Drive sync'}
                  </button>
                </div>
                {driveTopicSyncPreview.removedTopics?.length ? <p className="mt-3 text-sm text-slate-200"><span className="font-semibold text-rose-200">Will remove:</span> {driveTopicSyncPreview.removedTopics.join(' • ')}</p> : null}
                {driveTopicSyncPreview.addedTopics?.length ? <p className="mt-2 text-sm text-slate-200"><span className="font-semibold text-lime-200">Will add:</span> {driveTopicSyncPreview.addedTopics.join(' • ')}</p> : null}
                {!driveTopicSyncPreview.topics?.length ? <p className="mt-3 rounded-lg bg-amber-400/10 p-3 text-sm text-amber-100">No analyzed question topics were found. Applying will empty the selected grade’s global topic list and topics.json.</p> : null}
              </section>
            ) : null}

            <section className="mt-4 flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-800/40 p-4 sm:flex-row sm:items-center sm:justify-between" aria-label="Legacy Drive analysis JSON check">
              <div>
                <h3 className="font-semibold text-slate-100">Legacy paper JSON backfill</h3>
                <p className="mt-1 text-sm text-slate-300">Finds matching JSON files for unanalyzed papers in this subject and grade, validates their paper metadata, and queues valid matches through the existing pause-aware analysis queue. It queues up to 50 valid matches per run.</p>
              </div>
              <button type="button" className="btn-secondary inline-flex shrink-0 items-center justify-center gap-2" onClick={queueLegacyDriveAnalyses} disabled={legacyDriveAnalysisQueueLoading || topicResolverCleanupLoading || driveTopicSyncApplying || !topicResolverSubject || !topicResolverGrade}>
                {legacyDriveAnalysisQueueLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <HardDriveDownload className="h-4 w-4" />}
                {legacyDriveAnalysisQueueLoading ? 'Checking JSON…' : 'Check legacy papers'}
              </button>
            </section>

            {topicResolverRows.length ? (
              <div className="mt-4 grid shrink-0 gap-3 md:grid-cols-[1fr_auto_auto] md:items-center">
                <label className="relative block">
                  <span className="sr-only">Search topic names in results</span>
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                  <input type="search" className="input pl-10" value={topicResolverSearch} onChange={(event) => setTopicResolverSearch(event.target.value)} placeholder="Search extracted topic names" />
                </label>
                <p className="text-sm text-slate-300">{resolvedTopicRows.length - suggestedTopicRows.length} mapped • {suggestedTopicRows.length} Google Gemini suggestions • {unresolvedTopicRows.length} unresolved</p>
                <button type="button" className="btn-secondary inline-flex items-center justify-center gap-2" onClick={resolveUnmappedTopicsWithGemini} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading || !unresolvedTopicRows.length}>
                  {topicResolverGeminiLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Resolve with Gemini
                </button>
              </div>
            ) : null}

            {topicResolverStatus ? <p className="mt-3 shrink-0 text-sm text-slate-300" role="status">{topicResolverStatus}</p> : null}

            {topicResolverRows.length ? (
              <div className="topic-resolver-table-scroll mt-4 overflow-x-auto rounded-lg border border-slate-700">
                  <table className="min-w-[1050px] border-collapse text-left text-sm">
                    <thead className="sticky top-0 bg-slate-800 text-xs uppercase text-slate-300">
                      <tr>
                        <th className="px-3 py-3">Raw topic</th>
                        <th className="px-3 py-3">Suggested / reviewed topic</th>
                        <th className="px-3 py-3">Match</th>
                        <th className="px-3 py-3">Occurrences</th>
                        <th className="px-3 py-3">Found in</th>
                        <th className="min-w-64 px-3 py-3">Sample records</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700 text-slate-100">
                      {visibleTopicResolverRows.map((row) => {
                        const catalog = topicResolverCatalog;
                        const currentValue = currentResolverValue(row);
                        const wasCorrected = Object.hasOwn(topicResolverCorrections, row.id);
                        const matchMethod = topicResolverMethods[row.id] ?? (wasCorrected ? 'manual' : row.matchType);
                        const isGeminiSuggestion = matchMethod === 'gemini-suggested' || matchMethod === 'saved-suggestion';
                        const matchClass = isGeminiSuggestion
                          ? 'bg-amber-400/15 text-amber-200'
                          : matchMethod === 'gemini'
                            ? 'bg-sky-400/15 text-sky-200'
                            : currentValue
                              ? 'bg-lime-400/15 text-lime-200'
                              : 'bg-amber-400/15 text-amber-200';
                        const matchLabel = matchMethod === 'gemini-suggested'
                          ? 'Google Gemini suggestion — review'
                          : matchMethod === 'saved-suggestion'
                            ? 'Saved Google Gemini suggestion'
                            : matchMethod === 'gemini'
                              ? 'Gemini match'
                              : matchMethod === 'manual'
                                ? 'Admin edit'
                                : currentValue
                                  ? matchMethod
                                  : 'Needs review';
                        return (
                          <tr key={row.id} className="align-top">
                            <td className="max-w-64 px-3 py-3 font-medium">{row.sourceTopic}</td>
                            <td className="px-3 py-3">
                              <select className="input min-w-80" value={currentValue} onChange={(event) => { const isSuggestedValue = event.target.value === currentValue && !catalog.includes(event.target.value); setTopicResolverCorrections((current) => ({ ...current, [row.id]: event.target.value })); setTopicResolverMethods((current) => ({ ...current, [row.id]: isSuggestedValue ? 'gemini-suggested' : 'manual' })); setTopicResolverReviewed(false); }} disabled={topicResolverGeminiLoading || topicResolverSaveLoading}>
                                <option value="">Needs manual mapping</option>
                                {currentValue && !catalog.includes(currentValue) ? <option value={currentValue}>{currentValue} · Google Gemini suggestion</option> : null}
                                {catalog.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
                              </select>
                            </td>
                            <td className="px-3 py-3"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${matchClass}`}>{matchLabel}</span></td>
                            <td className="px-3 py-3 tabular-nums">{row.occurrenceCount}</td>
                            <td className="px-3 py-3">{row.sources.map((source) => <span key={source} className="mr-1 inline-block rounded bg-slate-800 px-2 py-1 text-xs">{source === 'paper' ? 'Papers' : 'Lessons'}</span>)}</td>
                            <td className="px-3 py-3 text-xs text-slate-300">{row.sourceExamples.join(' • ') || '—'}</td>
                          </tr>
                        );
                      })}
                      {!visibleTopicResolverRows.length ? <tr><td colSpan="6" className="px-3 py-8 text-center text-slate-400">No topic names match that search.</td></tr> : null}
                    </tbody>
                  </table>
              </div>
            ) : null}
            </div>
            <div className="mt-4 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-700 pt-4">
              <label className="flex items-start gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={topicResolverReviewed} onChange={(event) => setTopicResolverReviewed(event.target.checked)} disabled={Boolean(unresolvedTopicRows.length) || topicResolverGeminiLoading || topicResolverSaveLoading || driveTopicSyncApplying || legacyDriveAnalysisQueueLoading} />
                <span>{unresolvedTopicRows.length ? `${unresolvedTopicRows.length} topics still need mappings.` : `I reviewed and confirmed every topic mapping${suggestedTopicRows.length ? `, including ${suggestedTopicRows.length} Google Gemini suggestion${suggestedTopicRows.length === 1 ? '' : 's'}` : ''}.`}</span>
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" onClick={() => { setTopicResolverRows([]); setTopicResolverCorrections({}); setTopicResolverMethods({}); setTopicResolverReviewed(false); setTopicResolverSearch(''); setDriveTopicSyncPreview(null); setTopicResolverStatus('Select a subject and grade to search or preview the topic sync.'); }} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading || driveTopicSyncApplying || legacyDriveAnalysisQueueLoading}>Clear results</button>
                <button type="button" className="btn-primary inline-flex items-center justify-center gap-2" onClick={saveReviewedTopicMappings} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading || driveTopicSyncApplying || legacyDriveAnalysisQueueLoading || !topicResolverRows.length || unresolvedTopicRows.length > 0 || !topicResolverReviewed}>
                  {topicResolverSaveLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save mappings & sync topics
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
  if (isPublicCatalog) return <PublicPaperShell>{pageContent}</PublicPaperShell>;
  return (
    <AppShell title="Past exam papers" subtitle={canUploadPapers(role) ? 'Browse, upload, and manage question papers for analysis.' : 'Browse question papers and memoranda across all subjects.'} role={role} user={profile} onLogout={logout}>
      {pageContent}
    </AppShell>
  );
};

const UploadFields = ({ value, onChange, subjects, compact = false }) => (
  <>
    <label className={compact ? '' : ''}><span className="label">Subject</span><select className="input" value={value.subject} onChange={(event) => onChange({ subject: event.target.value })}>{subjects.map((subject) => <option key={subject}>{subject}</option>)}</select></label>
    <label><span className="label">Grade</span><select className="input" value={value.grade} onChange={(event) => onChange({ grade: event.target.value })}>{SOUTH_AFRICAN_GRADES.map((grade) => <option key={grade}>{grade}</option>)}</select></label>
    <label><span className="label">Region</span><select className="input" value={value.region} onChange={(event) => onChange({ region: event.target.value })}>{REGIONS.map((region) => <option key={region}>{region}</option>)}</select></label>
    <label><span className="label">Year</span><input type="number" min="2000" max="2100" className="input" value={value.year} onChange={(event) => onChange({ year: event.target.value })} /></label>
    <label><span className="label">Month</span><select className="input" value={value.month} onChange={(event) => onChange({ month: event.target.value })}>
      {value.month && !PAPER_MONTHS.includes(value.month) ? <option value={value.month}>{value.month} (existing record)</option> : null}
      {PAPER_MONTHS.map((month) => <option key={month}>{month}</option>)}
    </select></label>
    <label><span className="label">Paper number</span><select className="input" value={value.paperNumber} onChange={(event) => onChange({ paperNumber: event.target.value })}>
      {value.paperNumber && !PAPER_NUMBERS.includes(value.paperNumber) ? <option value={value.paperNumber}>{value.paperNumber} (existing record)</option> : null}
      {PAPER_NUMBERS.map((paperNumber) => <option key={paperNumber}>{paperNumber}</option>)}
    </select></label>
    {!compact ? <label className="md:col-span-2"><span className="label">Notes</span><textarea className="input min-h-24" value={value.notes} onChange={(event) => onChange({ notes: event.target.value })} /></label> : <label className="md:col-span-3"><span className="label">Notes</span><input className="input" value={value.notes} onChange={(event) => onChange({ notes: event.target.value })} /></label>}
  </>
);
