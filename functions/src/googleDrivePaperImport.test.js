import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  comparePaperMetadata,
  createDrivePaperImportRunner,
  destroyPdfLoadingTaskSafely,
  DRIVE_PAPER_IMPORT_SCHEDULE,
  getDriveFileFingerprint,
  isDrivePaperImportActive,
  listDrivePdfsRecursively,
  parseGoogleDrivePaperMetadata,
  paperFileIdentityKey,
  paperIdentityKey,
  sha256Buffer,
  summarizeDriveFolderPapers,
} from './googleDrivePaperImportCore.js';
import {
  DRIVE_PAPER_SUBJECT_QUERY_VALUES,
  DRIVE_PAPER_SUBJECTS,
} from './drivePaperSubjects.js';
import { PAPER_MONTHS } from '../../src/lib/constants.js';
import { detectUploaderPaperMonth } from '../../src/utils/paperMonth.js';

const pdfBuffer = Buffer.from('%PDF-1.7\nfixture pdf bytes');
const paperFile = (id = 'drive-paper-1', name = 'Mathematics - Grade 12 - National - November - 2024 - Paper 1.pdf') => ({
  id,
  name,
  mimeType: 'application/pdf',
  modifiedTime: '2025-01-01T00:00:00.000Z',
  version: '1',
  size: String(pdfBuffer.length),
  md5Checksum: `md5-${id}`,
  folderPath: ['Past Papers'],
});

const createHarness = ({
  files = [paperFile()],
  existingPapers = [],
  priorTrackingByFileId = {},
  inspectPdf = async () => ({}),
  recheckWaitingAnalysis = async () => ({ requeued: false }),
  downloadFile = async () => pdfBuffer,
  onDownload = async () => {},
  downloadExisting = async () => pdfBuffer,
  inspectExistingStorage = async () => null,
} = {}) => {
  const tracking = new Map(Object.entries(priorTrackingByFileId));
  const calls = { upload: [], create: [], attachMemo: [], syncMetadata: [], analysisChecks: [], logs: [] };
  const runner = createDrivePaperImportRunner({
    rootFolderId: 'configured-past-papers-folder',
    acquireLease: async () => ({ acquired: true, owner: 'lease-test' }),
    releaseLease: async () => {},
    listFiles: async () => files,
    readTracking: async (id) => tracking.get(id) ?? null,
    writeTracking: async (id, fields) => tracking.set(id, { ...(tracking.get(id) ?? {}), ...fields }),
    loadExistingPapers: async () => existingPapers,
    loadPaperForDriveFile: async ({ item }) => existingPapers.filter((paper) => (
      paper.driveFileId === item.file.id
      || paper.driveImport?.paperDriveFileId === item.file.id
      || paper.driveImport?.memoDriveFileId === item.file.id
      || paper.id === tracking.get(item.file.id)?.targetPaperId
      || paper.id === tracking.get(item.file.id)?.duplicateTargetPaperId
    )),
    syncPaperMetadataFromDrive: async ({ paper, metadata, file, paperType }) => {
      const displayName = [metadata.subject, metadata.grade, metadata.region, metadata.month, metadata.year, metadata.paperNumber].join(' • ');
      const patch = {
        subject: metadata.subject,
        grade: metadata.grade,
        region: metadata.region,
        province: metadata.region,
        month: metadata.month,
        year: metadata.year,
        paperNumber: metadata.paperNumber,
        language: metadata.language ?? '',
        examSession: metadata.examSession ?? '',
        session: metadata.examSession ?? '',
        displayName,
        paperTitle: displayName,
        paperMetadata: { ...(paper.paperMetadata ?? {}), ...metadata },
        ...(paperType === 'memo' ? { memoFileName: file.name } : { paperFileName: file.name }),
      };
      calls.syncMetadata.push({ paperId: paper.id, patch });
      Object.assign(paper, patch);
      return patch;
    },
    downloadFile: async (file, maxBytes) => {
      await onDownload({ file, tracking, calls });
      return downloadFile(file, maxBytes);
    },
    downloadExisting,
    inspectExistingStorage,
    inspectPdf,
    uploadPdf: async ({ file, fileType, contentSha256 }) => {
      calls.upload.push({ driveFileId: file.id, fileType, contentSha256 });
      return { path: `questionPapers/google-drive/${fileType}/${file.id}.pdf`, url: `https://storage.example/${fileType}/${file.id}` };
    },
    createPaperIfAbsent: async ({ paperId, paperRecord }) => {
      calls.create.push({ paperId, paperRecord });
      existingPapers.push({ id: paperId, ...paperRecord });
      return { created: true };
    },
    attachMemoIfMissing: async ({ paperId, memo, uploaded }) => {
      calls.attachMemo.push({ paperId, driveFileId: memo.file.id, uploaded });
      return { attached: true };
    },
    recheckWaitingAnalysis: async (input) => {
      calls.analysisChecks.push(input);
      return recheckWaitingAnalysis(input);
    },
    logger: {
      info: (...args) => calls.logs.push(args),
      warn: (...args) => calls.logs.push(args),
      error: (...args) => calls.logs.push(args),
    },
  });
  return { runner, tracking, calls };
};

test('parses question-paper and memo names with the exam month in the filename', () => {
  const question = parseGoogleDrivePaperMetadata({
    fileName: 'Mathematics - Grade 8 - Gauteng - November - 2020 - Paper 1.pdf',
  });
  const memo = parseGoogleDrivePaperMetadata({
    fileName: 'Maths - Grade 8 - GP - Nov - 2020 - Paper 1 - Memo.pdf',
  });

  assert.equal(question.ok, true);
  assert.deepEqual(question.metadata, {
    subject: 'Mathematics',
    grade: 'Grade 8',
    region: 'Gauteng',
    month: 'November',
    year: 2020,
    paperNumber: 'Paper 1',
    paperType: 'question',
  });
  assert.equal(memo.ok, true);
  assert.deepEqual(memo.metadata, question.metadata && {
    ...question.metadata,
    region: 'GP',
    paperType: 'memo',
  });
  assert.equal(paperIdentityKey(question.metadata), paperIdentityKey(memo.metadata));
});

test('accepts a free-form school or district in the region filename segment', () => {
  const parsed = parseGoogleDrivePaperMetadata({
    fileName: 'Mathematics - Grade 12 - Central High School, District 4 - November - 2024 - Paper 1.pdf',
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.metadata.region, 'Central High School, District 4');
});

test('parses Accounting question papers and memos using the established metadata fields', () => {
  const question = parseGoogleDrivePaperMetadata({
    fileName: 'Accounting - Grade 10 - Gauteng - June - 2022 - Paper 1.pdf',
  });
  const memo = parseGoogleDrivePaperMetadata({
    fileName: 'Accounting - Grade 10 - KwaZulu-Natal - March - 2022 - Paper 1 - Memo.pdf',
  });

  assert.equal(question.ok, true);
  assert.equal(question.metadata.subject, 'Accounting');
  assert.equal(question.metadata.paperType, 'question');
  assert.equal(memo.ok, true);
  assert.equal(memo.metadata.subject, 'Accounting');
  assert.equal(memo.metadata.paperType, 'memo');
});

test('recognizes the importer subject catalogue, including South African language levels', () => {
  for (const subject of DRIVE_PAPER_SUBJECTS) {
    const parsed = parseGoogleDrivePaperMetadata({
      fileName: `${subject} - Grade 10 - National - November - 2024 - Paper 1.pdf`,
    });
    assert.equal(parsed.ok, true, `${subject} should be recognized`);
    assert.equal(parsed.metadata.subject, subject);
  }

  assert.equal(parseGoogleDrivePaperMetadata({
    fileName: 'isiNdebele FAL - Grade 10 - National - November - 2024 - Paper 1.pdf',
  }).metadata.subject, 'isiNdebele First Additional Language');
  assert.equal(parseGoogleDrivePaperMetadata({
    fileName: 'Tshivenda Home Language - Grade 12 - Limpopo - November - 2024 - Paper 1.pdf',
  }).metadata.subject, 'Tshivenda Home Language');
  assert.ok(DRIVE_PAPER_SUBJECT_QUERY_VALUES.includes('Accounting'));
  assert.ok(DRIVE_PAPER_SUBJECT_QUERY_VALUES.includes('isiNdebele FAL'));
});

test('a language filename without its language level is held for review as ambiguous', () => {
  const parsed = parseGoogleDrivePaperMetadata({
    fileName: 'English - Grade 10 - National - November - 2024 - Paper 1.pdf',
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /subject is ambiguous/i);
});

test('recovers archived Drive names from their subject and grade folders', () => {
  const cases = [
    {
      fileName: 'English FAL P2 May-June 2024 MG.doc.pdf',
      folderPath: ['Past Papers', 'English First Additional Language', 'Grade 12'],
      expected: {
        subject: 'English First Additional Language', grade: 'Grade 12', month: 'June', year: 2024,
        paperNumber: 'Paper 2', paperType: 'memo', language: 'English',
      },
    },
    {
      fileName: 'LIFE SC P1 QP GR10 NOV 2018_English.pdf',
      folderPath: ['Past Papers', 'Life Sciences', 'Grade 10'],
      expected: {
        subject: 'Life Sciences', grade: 'Grade 10', month: 'November', year: 2018,
        paperNumber: 'Paper 1', paperType: 'question', language: 'English',
      },
    },
    {
      fileName: 'Mathematics P1 Grade 10 Nov 2015 Memo Eng & Afr.pdf',
      folderPath: ['Past Papers', 'Mathematics', 'Grade 10'],
      expected: {
        subject: 'Mathematics', grade: 'Grade 10', month: 'November', year: 2015,
        paperNumber: 'Paper 1', paperType: 'memo', language: 'Afrikaans & English',
      },
    },
    {
      fileName: 'Life Sciences P1 GR 10 Exemplar Memo Eng.pdf',
      folderPath: ['Past Papers', 'Life Sciences', 'Grade 10'],
      expected: {
        subject: 'Life Sciences', grade: 'Grade 10', month: '', year: null,
        paperNumber: 'Examplar', paperType: 'memo', language: 'English',
      },
    },
  ];

  for (const { fileName, folderPath, expected } of cases) {
    const parsed = parseGoogleDrivePaperMetadata({ fileName, folderPath });
    assert.equal(parsed.ok, true, `${fileName}: ${parsed.reason ?? ''}`);
    assert.deepEqual(parsed.metadata, { region: '', ...expected });
  }
});

test('folder preview pairs a legacy question paper with its bilingual memo', () => {
  const [group] = summarizeDriveFolderPapers({ files: [
    {
      id: 'legacy-memo',
      name: 'Mathematics P1 Grade 10 Nov 2015 Memo Eng & Afr.pdf',
      mimeType: 'application/pdf',
      folderPath: ['Past Papers', 'Mathematics', 'Grade 10'],
    },
    {
      id: 'legacy-paper',
      name: 'Mathematics P1 Grade 10 Nov 2015 Eng.pdf',
      mimeType: 'application/pdf',
      folderPath: ['Past Papers', 'Mathematics', 'Grade 10'],
    },
  ] });

  assert.equal(group.questionFiles.length, 1);
  assert.equal(group.memoFiles.length, 1);
  assert.deepEqual(group.importFileIds.sort(), ['legacy-memo', 'legacy-paper']);
});

test('accepts and normalizes all valid calendar months, including November', () => {
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  monthNames.forEach((month) => {
    const parsed = parseGoogleDrivePaperMetadata({
      fileName: `Mathematics - Grade 8 - National - ${month} - 2020 - Paper 1.pdf`,
    });
    assert.equal(parsed.ok, true, `${month} should parse`);
    assert.equal(parsed.metadata.month, month);
  });
  assert.equal(parseGoogleDrivePaperMetadata({
    fileName: 'Mathematics - Grade 8 - National - Nov - 2020 - Paper 1.pdf',
  }).metadata.month, 'November');
});

test('missing, misplaced, malformed, or ambiguous months are review cases and never use folder names', () => {
  const cases = [
    {
      fileName: 'Mathematics - Grade 8 - Gauteng - 2020 - Paper 1.pdf',
      folderPath: ['Past Papers', 'November'],
    },
    { fileName: 'Mathematics - Grade 8 - Gauteng - Noveber - 2020 - Paper 1.pdf' },
    { fileName: 'Mathematics - Grade 8 - Gauteng - November December - 2020 - Paper 1.pdf' },
    { fileName: 'Mathematics - Grade 8 - Gauteng - 2020 - November - Paper 1.pdf' },
  ];

  cases.forEach(({ fileName, folderPath }) => {
    const parsed = parseGoogleDrivePaperMetadata({ fileName, folderPath });
    assert.equal(parsed.ok, false, fileName);
    assert.match(parsed.reason, /exam month/i);
  });
});

test('file identity includes paper versus memo while the shared paper identity pairs them', () => {
  const question = {
    subject: 'Mathematics', grade: 'Grade 8', region: 'Gauteng', month: 'November', year: 2020,
    paperNumber: 'Paper 1', paperType: 'question',
  };
  const memo = { ...question, paperType: 'memo' };
  const schoolPaper = { ...question, region: 'Central High School' };

  assert.equal(paperIdentityKey(question), paperIdentityKey(memo));
  assert.notEqual(paperFileIdentityKey(question), paperFileIdentityKey(memo));
  assert.notEqual(paperIdentityKey(question), paperIdentityKey(schoolPaper));
});

test('a missing filename month is logged and skipped for review without uploading', async () => {
  const file = paperFile('drive-no-month', 'Mathematics - Grade 12 - National - 2024 - Paper 1.pdf');
  const { runner, calls, tracking } = createHarness({ files: [file] });
  const result = await runner();

  assert.equal(result.reviewFiles, 1);
  assert.equal(calls.upload.length, 0);
  assert.equal(tracking.get(file.id).importStatus, 'review');
  assert.match(tracking.get(file.id).reviewReason, /exam month/i);
  assert.ok(calls.logs.some(([message, details]) => (
    message.includes('filename could not be parsed') && /exam month/i.test(details?.error ?? '')
  )));
});

test('the importer records a visible importing stage before the Drive download begins', async () => {
  const file = paperFile();
  const { runner, tracking } = createHarness({
    files: [file],
    onDownload: async ({ file: downloadingFile }) => {
      const current = tracking.get(downloadingFile.id);
      assert.equal(current.importStatus, 'importing');
      assert.equal(current.importStage, 'downloading');
    },
  });

  const result = await runner();
  assert.equal(result.importedFiles, 1);
  assert.equal(tracking.get(file.id).importStatus, 'imported');
  assert.equal(tracking.get(file.id).importStage, '');
});

test('a recent importing status prevents another attempt while stale progress can retry', () => {
  const now = new Date('2026-10-08T12:00:00.000Z');
  assert.equal(isDrivePaperImportActive({ importStatus: 'importing', updatedAt: new Date('2026-10-08T11:59:00.000Z') }, now), true);
  assert.equal(isDrivePaperImportActive({ importStatus: 'importing', updatedAt: new Date('2026-10-08T11:40:00.000Z') }, now), false);
  assert.equal(isDrivePaperImportActive({ importStatus: 'failed', updatedAt: now }, now), false);
});

test('a runner skips a Drive file whose progress says an import is already active', async () => {
  const file = paperFile('drive-already-importing');
  const { runner, calls } = createHarness({
    files: [file],
    priorTrackingByFileId: {
      [file.id]: {
        importStatus: 'importing',
        importStage: 'uploading_question_paper',
        driveFingerprint: getDriveFileFingerprint(file),
        updatedAt: new Date(),
      },
    },
  });
  const result = await runner();

  assert.equal(result.skippedFiles, 1);
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.create.length, 0);
});

test('a new PDF is stored and creates one paper record that activates the existing analysis trigger', async () => {
  const { runner, calls, tracking } = createHarness();
  const result = await runner();

  assert.equal(result.importedFiles, 1);
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].paperRecord.source, 'google_drive');
  assert.equal(calls.create[0].paperRecord.driveFileId, 'drive-paper-1');
  assert.equal(calls.create[0].paperRecord.analysisStatus, 'Analyzing');
  assert.equal(calls.create[0].paperRecord.month, 'November');
  assert.equal(tracking.get('drive-paper-1').importStatus, 'imported');
});

test('a later run skips the same imported Drive file without a second upload or analysis handoff', async () => {
  const { runner, calls } = createHarness();
  await runner();
  const secondRun = await runner();

  assert.equal(secondRun.skippedFiles, 1);
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.create.length, 1);
});

test('a matching front-end paper is recorded as a duplicate without upload or relabeling', async () => {
  const existing = {
    id: 'frontend-paper-123',
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: 'Nov',
    paperNumber: 'Paper 1',
    paperUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fuser%2Fpaper',
    memoUrl: '',
  };
  const { runner, calls, tracking } = createHarness({ existingPapers: [existing] });
  const result = await runner();

  assert.equal(result.duplicateFiles, 1);
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(tracking.get('drive-paper-1').duplicateTargetPaperId, 'frontend-paper-123');
  assert.equal(existing.source, undefined);
});

test('duplicate checks use matching Firebase Storage metadata even for a front-end record', async () => {
  const existing = {
    id: 'frontend-paper-storage-metadata',
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: 'November',
    paperNumber: 'Paper 1',
    paperUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fuser%2Fpaper%2Fpaper.pdf',
    memoUrl: '',
  };
  const { runner, calls, tracking } = createHarness({
    existingPapers: [existing],
    inspectExistingStorage: async () => ({
      objectPath: 'questionPapers/user/paper/paper.pdf',
      metadata: { contentSha256: sha256Buffer(pdfBuffer), fileType: 'question' },
      }),
    downloadExisting: async () => { throw new Error('Storage metadata should provide the comparison hash.'); },
  });
  const result = await runner();

  assert.equal(result.duplicateFiles, 1);
  assert.equal(calls.upload.length, 0);
  assert.equal(tracking.get('drive-paper-1').duplicateTargetPaperId, existing.id);
});

test('a memo duplicate is compared against the memo Storage slot, not the question-paper slot', async () => {
  const memo = paperFile('drive-existing-memo', 'Mathematics - Grade 12 - National - November - 2024 - Paper 1 - Memo.pdf');
  const existing = {
    id: 'frontend-paper-with-memo',
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: 'November',
    paperNumber: 'Paper 1',
    paperUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fuser%2Fpaper%2Fpaper.pdf',
    memoUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fuser%2Fmemo%2Fmemo.pdf',
    paperSha256: sha256Buffer(Buffer.from('question paper bytes')),
  };
  const { runner, calls, tracking } = createHarness({
    files: [memo],
    existingPapers: [existing],
    inspectExistingStorage: async () => ({
      objectPath: 'questionPapers/user/memo/memo.pdf',
      metadata: { contentSha256: sha256Buffer(pdfBuffer), fileType: 'memo' },
    }),
    downloadExisting: async () => { throw new Error('The memo Storage hash should provide the comparison.'); },
  });
  const result = await runner();

  assert.equal(result.duplicateFiles, 1);
  assert.equal(calls.upload.length, 0);
  assert.equal(tracking.get(memo.id).duplicateTargetPaperId, existing.id);
});

test('the same metadata with a different month is not a duplicate', async () => {
  const existing = {
    id: 'frontend-paper-other-month',
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: 'October',
    paperNumber: 'Paper 1',
    paperUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fuser%2Fpaper',
    memoUrl: '',
  };
  const { runner, calls } = createHarness({ existingPapers: [existing] });
  const result = await runner();

  assert.equal(result.importedFiles, 1);
  assert.equal(result.duplicateFiles, 0);
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].paperRecord.month, 'November');
});

test('an existing record with no month is uncertain rather than treated as an identity match', () => {
  const incoming = parseGoogleDrivePaperMetadata({
    fileName: 'Mathematics - Grade 12 - National - November - 2024 - Paper 1.pdf',
  }).metadata;
  assert.deepEqual(comparePaperMetadata(incoming, {
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: '',
    paperNumber: 'Paper 1',
  }), { status: 'uncertain', fields: ['month'] });
});

test('region labels are descriptive and do not block a structurally matching record', () => {
  const incoming = parseGoogleDrivePaperMetadata({
    fileName: 'Mathematics - Grade 12 - Central High School - November - 2024 - Paper 1.pdf',
  }).metadata;
  assert.deepEqual(comparePaperMetadata(incoming, {
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'Gauteng',
    year: 2024,
    month: 'November',
    paperNumber: 'Paper 1',
  }), { status: 'match' });

  assert.deepEqual(comparePaperMetadata({ ...incoming, region: 'GP' }, {
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'Gauteng',
    year: 2024,
    month: 'November',
    paperNumber: 'Paper 1',
  }), { status: 'match' });
});

test('imports a school paper separately from a National paper with the same year and paper number', async () => {
  const file = paperFile('drive-school-specific-paper', 'Natural Sciences - Grade 7 - Laerskool Dalview - November - 2021 - Paper 1.pdf');
  const nationalPaper = {
    id: 'existing-national-paper',
    source: 'google_drive',
    subject: 'Natural Sciences',
    grade: 'Grade 7',
    region: 'National',
    year: 2021,
    month: 'November',
    paperNumber: 'Paper 1',
    paperFileName: 'Natural Sciences - Grade 7 - National - November - 2021 - Paper 1.pdf',
    paperUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fnational-paper',
    paperSha256: sha256Buffer(Buffer.from('national paper contents')),
  };
  const { runner, calls } = createHarness({
    files: [file],
    existingPapers: [nationalPaper],
    downloadExisting: async () => Buffer.from('national paper contents'),
  });

  const result = await runner();

  assert.equal(result.importedFiles, 1);
  assert.equal(result.reviewFiles, 0);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].paperRecord.region, 'Laerskool Dalview');
});

test('a linked Drive file updates stale Firestore identity from its current filename', async () => {
  const file = paperFile('drive-renamed-paper', 'Mathematics - Grade 11 - Central High School - June - 2023 - Paper 2.pdf');
  const existing = {
    id: 'google-drive-linked-paper',
    source: 'google_drive',
    driveFileId: file.id,
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'Gauteng',
    year: 2024,
    month: 'November',
    paperNumber: 'Paper 1',
    paperFileName: 'Mathematics - Grade 12 - Gauteng - November - 2024 - Paper 1.pdf',
    paperUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fuser%2Fpaper',
    paperSha256: sha256Buffer(pdfBuffer),
    memoUrl: '',
  };
  const { runner, calls } = createHarness({ files: [file], existingPapers: [existing] });
  const result = await runner();

  assert.equal(result.importedFiles, 1);
  assert.equal(existing.grade, 'Grade 11');
  assert.equal(existing.region, 'Central High School');
  assert.equal(existing.year, 2023);
  assert.equal(existing.month, 'June');
  assert.equal(existing.paperNumber, 'Paper 2');
  assert.equal(existing.paperFileName, file.name);
  assert.equal(calls.syncMetadata.length, 1);
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.create.length, 0);
});

test('the importer retries a previously reviewed filename when folder-aware parsing now recognizes it', async () => {
  const file = paperFile('drive-recovered-parser', 'LIFE SC P1 QP GR10 NOV 2018_English.pdf');
  file.folderPath = ['Past Papers', 'Life Sciences', 'Grade 10'];
  const { runner, calls, tracking } = createHarness({
    files: [file],
    priorTrackingByFileId: {
      [file.id]: {
        importStatus: 'review',
        driveFingerprint: getDriveFileFingerprint(file),
        sourceFilename: file.name,
        parsedMetadata: null,
        reviewReason: 'The subject and grade are missing from their expected filename positions.',
      },
    },
  });

  const result = await runner();

  assert.equal(result.recoveredParserReviewRetries, 1);
  assert.equal(result.importedFiles, 1);
  assert.equal(tracking.get(file.id).importStatus, 'imported');
  assert.equal(calls.create[0].paperRecord.subject, 'Life Sciences');
  assert.equal(calls.create[0].paperRecord.grade, 'Grade 10');
});

test('terminal importer tracking reimports a Drive file whose Firestore target was deleted', async () => {
  const file = paperFile('drive-missing-firestore-target');
  const { runner, calls, tracking } = createHarness({
    files: [file],
    priorTrackingByFileId: {
      [file.id]: {
        importStatus: 'imported',
        driveFingerprint: getDriveFileFingerprint(file),
        sourceFilename: file.name,
        targetPaperId: 'deleted-paper-record',
        parsedMetadata: parseGoogleDrivePaperMetadata({ fileName: file.name }).metadata,
      },
    },
  });

  const result = await runner();

  assert.equal(result.importedFiles, 1);
  assert.equal(calls.create.length, 1);
  assert.equal(tracking.get(file.id).targetPaperId, calls.create[0].paperId);
});

test('a review tracking row does not block reimport when its Firestore target was deleted', async () => {
  const file = paperFile('drive-reviewed-missing-target');
  const { runner, calls, tracking } = createHarness({
    files: [file],
    priorTrackingByFileId: {
      [file.id]: {
        importStatus: 'review',
        driveFingerprint: getDriveFileFingerprint(file),
        sourceFilename: file.name,
        targetPaperId: 'deleted-review-target',
        parsedMetadata: parseGoogleDrivePaperMetadata({ fileName: file.name }).metadata,
        reviewReason: 'The target paper could not be loaded during the previous import attempt.',
      },
    },
  });

  const result = await runner();

  assert.equal(result.importedFiles, 1);
  assert.equal(calls.create.length, 1);
  assert.equal(tracking.get(file.id).importStatus, 'imported');
});

test('a completed Drive scan rechecks waiting paper analysis when a sibling JSON appears', async () => {
  const file = paperFile('drive-analysis-json-added');
  const paper = {
    id: 'waiting-drive-paper',
    source: 'google_drive',
    driveFileId: file.id,
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: 'November',
    paperNumber: 'Paper 1',
    paperFileName: file.name,
    paperUrl: 'https://storage.example/paper',
    analysisStatus: 'Waiting for Drive JSON',
  };
  const { runner, calls } = createHarness({
    files: [file],
    existingPapers: [paper],
    priorTrackingByFileId: {
      [file.id]: {
        importStatus: 'imported',
        driveFingerprint: getDriveFileFingerprint(file),
        sourceFilename: file.name,
        targetPaperId: paper.id,
        parsedMetadata: parseGoogleDrivePaperMetadata({ fileName: file.name }).metadata,
      },
    },
    recheckWaitingAnalysis: async () => ({ requeued: true }),
  });

  const result = await runner();

  assert.equal(result.skippedFiles, 1);
  assert.equal(result.requeuedDriveJsonAnalyses, 1);
  assert.equal(calls.analysisChecks.length, 1);
  assert.equal(calls.upload.length, 0);
});

test('a tracked unchanged Drive file still restores stale Firestore metadata without downloading again', async () => {
  const file = paperFile('drive-stable-paper');
  const existing = {
    id: 'google-drive-stable-paper',
    source: 'google_drive',
    driveFileId: file.id,
    subject: 'Mathematics',
    grade: 'Grade 11',
    region: 'Old School',
    year: 2023,
    month: 'June',
    paperNumber: 'Paper 2',
    paperUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fuser%2Fpaper',
  };
  const tracking = {
    importStatus: 'imported',
    driveFingerprint: getDriveFileFingerprint(file),
    sourceFilename: file.name,
    targetPaperId: existing.id,
  };
  const { runner, calls } = createHarness({
    files: [file],
    existingPapers: [existing],
    priorTrackingByFileId: { [file.id]: tracking },
  });
  const result = await runner();

  assert.equal(result.skippedFiles, 1);
  assert.equal(existing.grade, 'Grade 12');
  assert.equal(existing.region, 'National');
  assert.equal(existing.year, 2024);
  assert.equal(existing.month, 'November');
  assert.equal(existing.paperNumber, 'Paper 1');
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.syncMetadata.length, 1);
});

test('a missing memo is attached to the matched paper without creating or reanalyzing a paper record', async () => {
  const memo = paperFile('drive-memo-1', 'Mathematics - Grade 12 - National - November - 2024 - Paper 1 - Memo.pdf');
  const existing = {
    id: 'frontend-paper-456',
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: 'November',
    paperNumber: 'Paper 1',
    paperUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fuser%2Fpaper',
    memoUrl: '',
    analysisStatus: 'Analyzed',
  };
  const { runner, calls } = createHarness({ files: [memo], existingPapers: [existing] });
  const result = await runner();

  assert.equal(result.importedFiles, 1);
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.upload[0].fileType, 'memo');
  assert.equal(calls.attachMemo.length, 1);
  assert.equal(calls.create.length, 0);
  assert.equal(result.duplicateFiles, 0);
  assert.equal(existing.analysisStatus, 'Analyzed');
});

test('a memo seen before its question paper waits and attaches on a later scan', async () => {
  const files = [paperFile('drive-memo-later', 'Mathematics - Grade 12 - National - November - 2024 - Paper 1 - Memo.pdf')];
  const { runner, calls, tracking } = createHarness({ files });
  const firstRun = await runner();
  assert.equal(firstRun.waitingFiles, 1);
  assert.equal(tracking.get('drive-memo-later').importStatus, 'waiting');

  files.unshift(paperFile('drive-question-later'));
  const secondRun = await runner();
  assert.equal(secondRun.importedFiles, 2);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.attachMemo.length, 1);
});

test('ambiguous metadata and combined paper/memo PDFs are held for review', async () => {
  const ambiguous = paperFile('drive-ambiguous', 'Mathematics - Grade 11 and Grade 12 - National - November - 2024 - Paper 1.pdf');
  const combined = paperFile('drive-combined');
  const { runner, calls, tracking } = createHarness({
    files: [ambiguous, combined],
    inspectPdf: async (buffer) => buffer.equals(pdfBuffer)
      ? { combinedPaperAndMemo: true, reason: 'Question and memo pages detected.' }
      : {},
  });
  const result = await runner();

  assert.equal(result.reviewFiles, 2);
  assert.equal(calls.upload.length, 0);
  assert.equal(tracking.get('drive-ambiguous').importStatus, 'review');
  assert.equal(tracking.get('drive-combined').importStatus, 'review');
});

test('reviewed Drive files stay skipped until an administrator explicitly rechecks them', async () => {
  const file = paperFile('drive-review-recheck');
  const { runner, calls, tracking } = createHarness({
    files: [file],
    priorTrackingByFileId: {
      [file.id]: {
        importStatus: 'review',
        driveFingerprint: getDriveFileFingerprint(file),
        reviewReason: 'Previous metadata needs correction.',
      },
    },
  });

  const ordinaryRun = await runner();
  assert.equal(ordinaryRun.reviewSkippedFiles, 1);
  assert.equal(ordinaryRun.importedFiles, 0);
  assert.ok(calls.logs.some(([message]) => message.includes('remains in review')));

  const recheck = await runner({
    requestedBy: 'admin:test',
    folderId: 'selected-folder',
    fileIds: [file.id],
    retryReviewFileIds: [file.id],
  });
  assert.equal(recheck.importedFiles, 1);
  assert.equal(tracking.get(file.id).importStatus, 'imported');
  assert.equal(calls.upload.length, 1);
});

test('automatically retries prior reviews caused only by the removed region filename rule', async () => {
  const file = paperFile('drive-old-region-review', 'Mathematics - Grade 12 - Central High School - November - 2024 - Paper 1.pdf');
  const { runner, calls, tracking } = createHarness({
    files: [file],
    priorTrackingByFileId: {
      [file.id]: {
        importStatus: 'review',
        driveFingerprint: getDriveFileFingerprint(file),
        sourceFilename: file.name,
        reviewReason: 'The province or National designation is missing or invalid in its expected filename position.',
      },
    },
  });

  const result = await runner();

  assert.equal(result.legacyRegionReviewRetries, 1);
  assert.equal(result.importedFiles, 1);
  assert.equal(tracking.get(file.id).importStatus, 'imported');
  assert.ok(calls.logs.some(([message]) => message.includes('obsolete region filename rule')));
  assert.equal(calls.upload.length, 1);
});

test('prior region reviews still stay skipped when the current parser rejects the filename structure', async () => {
  const file = paperFile('drive-old-region-invalid', 'Mathematics - Grade 12 - Central High School - 2024 - Paper 1.pdf');
  const { runner, calls } = createHarness({
    files: [file],
    priorTrackingByFileId: {
      [file.id]: {
        importStatus: 'review',
        driveFingerprint: getDriveFileFingerprint(file),
        sourceFilename: file.name,
        reviewReason: 'The province or National designation is missing or invalid in its expected filename position.',
      },
    },
  });

  const result = await runner();

  assert.equal(result.legacyRegionReviewRetries, 0);
  assert.equal(result.reviewSkippedFiles, 1);
  assert.equal(result.importedFiles, 0);
  assert.equal(calls.upload.length, 0);
});

test('retries a prior region-only review and lets matching Drive contents update Firestore metadata', async () => {
  const file = paperFile('drive-school-region-conflict', 'Natural Sciences - Grade 7 - Laerskool Dalview - November - 2021 - Paper 1.pdf');
  const nationalPaper = {
    id: 'existing-national-paper',
    subject: 'Natural Sciences',
    grade: 'Grade 7',
    region: 'National',
    year: 2021,
    month: 'November',
    paperNumber: 'Paper 1',
    paperFileName: 'Natural Sciences - Grade 7 - National - November - 2021 - Paper 1.pdf',
    paperUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fnational-paper',
  };
  const { runner, calls, tracking } = createHarness({
    files: [file],
    existingPapers: [nationalPaper],
    priorTrackingByFileId: {
      [file.id]: {
        importStatus: 'review',
        driveFingerprint: getDriveFileFingerprint(file),
        sourceFilename: file.name,
        reviewReason: 'Paper metadata matches an existing record, but the PDF contents differ. The existing record was left unchanged.',
      },
    },
  });

  const result = await runner();

  assert.equal(result.regionIdentityReviewRetries, 1);
  assert.equal(result.duplicateFiles, 1);
  assert.equal(result.importedFiles, 0);
  assert.equal(result.reviewFiles, 0);
  assert.equal(tracking.get(file.id).importStatus, 'duplicate');
  assert.equal(nationalPaper.region, 'Laerskool Dalview');
  assert.equal(calls.create.length, 0);
});

test('keeps same-region content conflicts in review without retrying every scan', async () => {
  const file = paperFile('drive-same-region-content-conflict');
  const existingPaper = {
    id: 'existing-national-paper',
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: 'November',
    paperNumber: 'Paper 1',
    paperFileName: file.name,
    paperUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fexisting-paper',
  };
  const { runner, calls } = createHarness({
    files: [file],
    existingPapers: [existingPaper],
    priorTrackingByFileId: {
      [file.id]: {
        importStatus: 'review',
        driveFingerprint: getDriveFileFingerprint(file),
        sourceFilename: file.name,
        reviewReason: 'Paper metadata matches an existing record, but the PDF contents differ. The existing record was left unchanged.',
      },
    },
  });

  const result = await runner();

  assert.equal(result.regionIdentityReviewRetries, 0);
  assert.equal(result.reviewSkippedFiles, 1);
  assert.equal(result.importedFiles, 0);
  assert.equal(calls.upload.length, 0);
});

test('one failed file does not block a later valid file in the same scan', async () => {
  const files = [paperFile('drive-fails'), paperFile('drive-succeeds', 'Mathematics - Grade 11 - Gauteng - October - 2023 - Paper 2.pdf')];
  const { runner, calls, tracking } = createHarness({
    files,
    downloadFile: async (file) => {
      if (file.id === 'drive-fails') throw new Error('temporary download failure');
      return pdfBuffer;
    },
  });
  const result = await runner();

  assert.equal(result.failedFiles, 1);
  assert.equal(result.importedFiles, 1);
  assert.equal(tracking.get('drive-fails').importStatus, 'failed');
  assert.equal(tracking.get('drive-succeeds').importStatus, 'imported');
  assert.equal(calls.create.length, 1);
});

test('a retry after Storage succeeds but Firestore creation fails reuses one object and creates one paper record', async () => {
  const file = paperFile('drive-partial-failure');
  const tracking = new Map();
  const storedObjects = new Set();
  let createAttempts = 0;
  const runner = createDrivePaperImportRunner({
    rootFolderId: 'configured-past-papers-folder',
    acquireLease: async () => ({ acquired: true, owner: 'lease-test' }),
    releaseLease: async () => {},
    listFiles: async () => [file],
    readTracking: async (id) => tracking.get(id) ?? null,
    writeTracking: async (id, fields) => tracking.set(id, { ...(tracking.get(id) ?? {}), ...fields }),
    loadExistingPapers: async () => [],
    downloadFile: async () => pdfBuffer,
    downloadExisting: async () => pdfBuffer,
    inspectPdf: async () => ({}),
    uploadPdf: async ({ file: sourceFile, fileType }) => {
      storedObjects.add(`${sourceFile.id}:${fileType}`);
      return { path: `questionPapers/google-drive/${fileType}/${sourceFile.id}.pdf`, url: `https://storage.example/${sourceFile.id}` };
    },
    createPaperIfAbsent: async () => {
      createAttempts += 1;
      if (createAttempts === 1) throw new Error('temporary Firestore failure');
      return { created: true };
    },
    attachMemoIfMissing: async () => ({ attached: true }),
  });

  const firstRun = await runner();
  const retry = await runner();

  assert.equal(firstRun.failedFiles, 1);
  assert.equal(retry.importedFiles, 1);
  assert.equal(storedObjects.size, 1);
  assert.equal(createAttempts, 2);
  assert.equal(tracking.get(file.id).importStatus, 'imported');
});

test('an overlapping run exits while another scan owns the lease', async () => {
  let leaseHeld = false;
  let notifyListing;
  const listingStarted = new Promise((resolve) => { notifyListing = resolve; });
  let releaseListing;
  const listingGate = new Promise((resolve) => { releaseListing = resolve; });
  const harness = createHarness();
  const overlapRunner = createDrivePaperImportRunner({
    rootFolderId: 'configured-past-papers-folder',
    acquireLease: async () => {
      if (leaseHeld) return { acquired: false };
      leaseHeld = true;
      return { acquired: true, owner: 'shared' };
    },
    releaseLease: async () => { leaseHeld = false; },
    listFiles: async () => { notifyListing(); await listingGate; return []; },
    readTracking: async () => null,
    writeTracking: async () => {},
    loadExistingPapers: async () => [],
    downloadFile: async () => pdfBuffer,
    downloadExisting: async () => pdfBuffer,
    inspectPdf: async () => ({}),
    uploadPdf: async () => ({}),
    createPaperIfAbsent: async () => ({ created: true }),
    attachMemoIfMissing: async () => ({ attached: true }),
  });
  const firstRun = overlapRunner();
  await listingStarted;
  const concurrentRun = await overlapRunner();
  releaseListing();
  await firstRun;

  assert.equal(concurrentRun.skipped, true);
  assert.equal(harness.calls.create.length, 0);
});

test('manual imports are constrained to the selected direct folder files', async () => {
  const files = [paperFile('folder-paper-1'), paperFile('folder-paper-2', 'Mathematics - Grade 11 - Gauteng - October - 2023 - Paper 2.pdf')];
  const { runner, calls } = createHarness({ files });
  const result = await runner({ requestedBy: 'admin:test', folderId: 'selected-folder', fileIds: ['folder-paper-2'] });

  assert.equal(result.importedFiles, 1);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].paperRecord.driveFileId, 'folder-paper-2');
});

test('folder preview groups paper and memo and reports their Firebase storage state', () => {
  const question = paperFile();
  const memo = paperFile('drive-memo-preview', 'Mathematics - Grade 12 - National - November - 2024 - Paper 1 - Memo.pdf');
  const existing = {
    id: 'frontend-paper-preview',
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: 'November',
    paperNumber: 'Paper 1',
    paperUrl: 'https://storage.example/paper',
    memoUrl: '',
  };
  const [group] = summarizeDriveFolderPapers({ files: [question, memo], existingPapers: [existing] });

  assert.equal(group.paperStatus, 'uploaded');
  assert.equal(group.memoStatus, 'missing');
  assert.deepEqual(group.importFileIds, ['drive-memo-preview']);
  assert.equal(group.targetPaperId, 'frontend-paper-preview');
});

test('folder preview exposes importing and analysis states from tracking and Firestore', () => {
  const question = paperFile('drive-in-progress');
  const [importing] = summarizeDriveFolderPapers({
    files: [question],
    trackingByFileId: { [question.id]: { importStatus: 'importing', importStage: 'downloading', updatedAt: new Date() } },
  });
  assert.equal(importing.paperStatus, 'importing');
  assert.deepEqual(importing.importFileIds, []);

  const [stalled] = summarizeDriveFolderPapers({
    files: [question],
    trackingByFileId: { [question.id]: { importStatus: 'importing', updatedAt: new Date(Date.now() - 11 * 60 * 1000) } },
  });
  assert.equal(stalled.paperStatus, 'stalled');
  assert.deepEqual(stalled.importFileIds, [question.id]);

  const [analyzing] = summarizeDriveFolderPapers({
    files: [question],
    existingPapers: [{
      id: 'paper-created', subject: 'Mathematics', grade: 'Grade 12', region: 'National', year: 2024,
      month: 'November', paperNumber: 'Paper 1', paperUrl: 'https://storage.example/paper', analysisStatus: 'Analyzing',
    }],
  });
  assert.equal(analyzing.paperStatus, 'analyzing');
});

test('schedule runs every two hours in South African time', () => {
  assert.deepEqual(DRIVE_PAPER_IMPORT_SCHEDULE, {
    schedule: '0 */2 * * *',
    timeZone: 'Africa/Johannesburg',
  });
});

test('the scheduled root scan includes PDFs in every nested subject folder and paginates without subject filters', async () => {
  const pages = {
    root: {
      first: {
        files: [
          { id: 'math-folder', name: 'Mathematics', mimeType: 'application/vnd.google-apps.folder' },
          { id: 'accounting-folder', name: 'Accounting', mimeType: 'application/vnd.google-apps.folder' },
          { id: 'root-pdf', name: 'General Paper.pdf', mimeType: 'application/pdf' },
          { id: 'trashed-pdf', name: 'old.pdf', mimeType: 'application/pdf', trashed: true },
          { id: 'not-pdf', name: 'notes.txt', mimeType: 'text/plain' },
        ],
        nextPageToken: 'root-next',
      },
      rootNext: { files: [{ id: 'root-second-pdf', name: 'Language Paper.pdf', mimeType: 'application/pdf' }] },
    },
    'math-folder': { first: { files: [{ id: 'math-pdf', name: 'Mathematics - Grade 10 - National - November - 2024 - Paper 1.pdf', mimeType: 'application/pdf' }] } },
    'accounting-folder': { first: { files: [{ id: 'accounting-pdf', name: 'Accounting - Grade 10 - Gauteng - June - 2022 - Paper 1.pdf', mimeType: 'application/pdf' }] } },
  };
  const requests = [];
  const files = await listDrivePdfsRecursively({
    root: { id: 'root', name: 'Past Papers' },
    listFolderPage: async (folderId, pageToken = '') => {
      requests.push([folderId, pageToken]);
      return pages[folderId][pageToken === 'root-next' ? 'rootNext' : 'first'];
    },
  });

  assert.deepEqual(files.map(({ id }) => id).sort(), [
    'accounting-pdf', 'math-pdf', 'root-pdf', 'root-second-pdf',
  ]);
  assert.ok(requests.some(([folderId]) => folderId === 'accounting-folder'));
  assert.ok(files.find(({ id }) => id === 'accounting-pdf').folderPath.includes('Accounting'));
});

test('PDF loading-task cleanup is safe when supported cleanup is missing or fails', async () => {
  let destroyed = false;
  await destroyPdfLoadingTaskSafely({ destroy: async () => { destroyed = true; } });
  assert.equal(destroyed, true);
  await destroyPdfLoadingTaskSafely({});
  await destroyPdfLoadingTaskSafely({ destroy: async () => { throw new Error('cleanup failed'); } });
});

test('the existing front-end upload and save path remains in place', async () => {
  const storageSource = await readFile(new URL('../../src/services/storageService.js', import.meta.url), 'utf8');
  const papersPageSource = await readFile(new URL('../../src/pages/PastExamPapersPage.jsx', import.meta.url), 'utf8');
  const firestoreSource = await readFile(new URL('../../src/services/firestoreService.js', import.meta.url), 'utf8');
  const analysisSource = await readFile(new URL('./questionPaperAnalysis.js', import.meta.url), 'utf8');

  assert.deepEqual(PAPER_MONTHS, ['March', 'June', 'September', 'November']);
  assert.equal(detectUploaderPaperMonth('Mathematics November 2020 Paper 1.pdf'), 'November');
  assert.equal(detectUploaderPaperMonth('Mathematics December 2020 Paper 1.pdf'), 'November');
  assert.equal(detectUploaderPaperMonth('Mathematics Paper 1.pdf'), 'March');
  assert.match(papersPageSource, /detectUploaderPaperMonth\(name\)/);
  assert.match(papersPageSource, /value\.month && !PAPER_MONTHS\.includes\(value\.month\)/);
  assert.match(storageSource, /questionPapers\/\$\{uploaderId\}\/paper/);
  assert.match(storageSource, /questionPapers\/\$\{uploaderId\}\/memo/);
  assert.match(papersPageSource, /uploadQuestionPaperDocuments/);
  assert.match(papersPageSource, /saveQuestionPaper\(/);
  assert.match(firestoreSource, /analysisRequestedAt: serverTimestamp\(\)/);
  assert.match(analysisSource, /document: 'questionPapers\/\{paperId\}'/);
  assert.match(analysisSource, /PAPER_QUEUE_COLLECTION = 'questionPaperAnalysisQueue'/);
});
