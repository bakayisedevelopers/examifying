import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getExerciseGenerationSubjectQueryValues,
  isAnalyzedExerciseSourcePaper,
  matchesExerciseGenerationPaper,
  normalizeExerciseGenerationGrade,
  normalizeExerciseGenerationSubject,
  sortExerciseGenerationPapersByRegionPreference,
} from './exerciseGenerationPaperMatching.js';

test('paper subject aliases match the canonical student subject', () => {
  assert.equal(normalizeExerciseGenerationSubject('Biology'), 'Life Sciences');
  assert.equal(normalizeExerciseGenerationSubject('Life Science'), 'Life Sciences');
  assert.equal(normalizeExerciseGenerationSubject('Physics'), 'Physical Sciences');
  assert.equal(normalizeExerciseGenerationSubject('Maths'), 'Mathematics');

  const lifeScienceQueryValues = getExerciseGenerationSubjectQueryValues('Life Sciences');
  assert.ok(lifeScienceQueryValues.includes('Life Sciences'));
  assert.ok(lifeScienceQueryValues.includes('Life Science'));
  assert.ok(lifeScienceQueryValues.includes('Biology'));
});

test('grade labels with common formats match the same grade', () => {
  assert.equal(normalizeExerciseGenerationGrade('Grade 10'), 'grade 10');
  assert.equal(normalizeExerciseGenerationGrade('G10'), 'grade 10');
  assert.equal(normalizeExerciseGenerationGrade('10'), 'grade 10');
  assert.equal(matchesExerciseGenerationPaper(
    { subject: 'Life Science', grade: 'G10' },
    { subject: 'Life Sciences', grade: 'Grade 10' },
  ), true);
  assert.equal(matchesExerciseGenerationPaper(
    { subject: 'Life Sciences', grade: 'Grade 11' },
    { subject: 'Life Sciences', grade: '10' },
  ), false);
});

test('paper region is a preference and never excludes an otherwise matching paper', () => {
  const papers = [
    { id: 'national', region: 'National' },
    { id: 'ec', region: 'Eastern Cape' },
    { id: 'gauteng', region: 'Gauteng' },
  ];
  const ordered = sortExerciseGenerationPapersByRegionPreference(papers, 'Gauteng Province');
  assert.deepEqual(ordered.map((paper) => paper.id), ['gauteng', 'national', 'ec']);
  assert.equal(ordered.length, papers.length);
});

test('Life Sciences papers in grade-label variants and other provinces meet the two-paper threshold', () => {
  const papers = [
    { id: 'biology-grade-10-national', subject: 'Biology', grade: 'G10', region: 'National', analysisStatus: 'Analyzed', questions: [{ questionReference: '1' }] },
    { id: 'life-science-grade-10-ec', subject: 'Life Science', grade: 'Grade 10', region: 'Eastern Cape', analysisStatus: 'Analyzed', questions: [{ questionReference: '1' }] },
  ];
  const matching = sortExerciseGenerationPapersByRegionPreference(
    papers.filter((paper) => isAnalyzedExerciseSourcePaper(paper)
      && matchesExerciseGenerationPaper(paper, { subject: 'Life Sciences', grade: 'Grade 10' })),
    'Gauteng',
  );

  assert.equal(matching.length, 2);
  assert.deepEqual(matching.map((paper) => paper.id), ['biology-grade-10-national', 'life-science-grade-10-ec']);
});

test('only fully analyzed papers with usable question records qualify', () => {
  const basePaper = { analysisStatus: 'Analyzed', availableForGeneration: true, questions: [{ questionReference: '1' }] };
  assert.equal(isAnalyzedExerciseSourcePaper(basePaper), true);
  assert.equal(isAnalyzedExerciseSourcePaper({ ...basePaper, analysisStatus: 'Waiting' }), false);
  assert.equal(isAnalyzedExerciseSourcePaper({ ...basePaper, availableForGeneration: false }), false);
  assert.equal(isAnalyzedExerciseSourcePaper({ ...basePaper, questions: [] }), false);
});
