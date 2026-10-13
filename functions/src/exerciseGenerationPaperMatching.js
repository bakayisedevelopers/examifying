import {
  canonicalDrivePaperSubject,
  DRIVE_PAPER_SUBJECT_QUERY_VALUES,
} from './drivePaperSubjects.js';

const normalizeLabel = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

export const normalizeExerciseGenerationSubject = (value) => canonicalDrivePaperSubject(value);

export const getExerciseGenerationSubjectQueryValues = (subject) => {
  const canonicalSubject = normalizeExerciseGenerationSubject(subject);
  if (!canonicalSubject) return [];

  return [...new Set([
    String(subject ?? '').trim(),
    canonicalSubject,
    ...DRIVE_PAPER_SUBJECT_QUERY_VALUES.filter((candidate) => (
      normalizeExerciseGenerationSubject(candidate) === canonicalSubject
    )),
  ].filter(Boolean))];
};

export const normalizeExerciseGenerationGrade = (value) => {
  const label = normalizeLabel(value);
  if (!label) return '';
  const gradeNumber = label.match(/^(?:grade|gr|g)?\s*(\d{1,2})$/)?.[1];
  return gradeNumber ? `grade ${Number(gradeNumber)}` : label;
};

export const isAnalyzedExerciseSourcePaper = (paper) => paper?.analysisStatus === 'Analyzed'
  && paper?.availableForGeneration !== false
  && Array.isArray(paper?.questions)
  && paper.questions.length > 0;

export const matchesExerciseGenerationPaper = (paper, { subject, grade }) => {
  const expectedSubject = normalizeExerciseGenerationSubject(subject);
  const paperSubject = normalizeExerciseGenerationSubject(paper?.subject);
  const expectedGrade = normalizeExerciseGenerationGrade(grade);
  const paperGrade = normalizeExerciseGenerationGrade(paper?.grade);
  return Boolean(expectedSubject && paperSubject === expectedSubject)
    && (!paperGrade || !expectedGrade || paperGrade === expectedGrade);
};

const regionLabel = (value) => normalizeLabel(value).replace(/\s+province$/, '');

export const sortExerciseGenerationPapersByRegionPreference = (papers, preferredRegion) => {
  const preferred = regionLabel(preferredRegion);
  return [...papers].sort((left, right) => {
    const rank = (paper) => {
      const region = regionLabel(paper.region);
      if (preferred && region === preferred) return 0;
      if (region === 'national') return 1;
      return 2;
    };
    return rank(left) - rank(right);
  });
};
