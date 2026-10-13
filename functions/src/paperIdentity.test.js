import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePaperIdentityValue, normalizePaperRegionIdentity, resolveDrivePaperIdentity } from './paperIdentity.js';

test('paper region identity accepts arbitrary school, district, province, or national labels', () => {
  assert.equal(normalizePaperRegionIdentity("St. Mary's Secondary"), 'st mary s secondary');
  assert.equal(normalizePaperRegionIdentity('Gauteng'), 'gauteng');
  assert.equal(normalizePaperIdentityValue('National', 'region'), 'national');
});

test('the validated Drive filename overrides Firestore and the analysis JSON identity', () => {
  assert.deepEqual(resolveDrivePaperIdentity({
    analysisIdentity: { subject: 'Mathematics', grade: 'Grade 12', region: 'Central High School' },
    filenameIdentity: { subject: 'Mathematics', grade: 'Grade 12', region: 'Gauteng', month: 'November', year: 2024, paperNumber: 'Paper 1' },
    storedIdentity: { subject: 'Maths', grade: 'Grade 11', region: 'Old School', month: 'June', year: 2023, paperNumber: 'Paper 2' },
  }), {
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'Gauteng',
    month: 'November',
    year: 2024,
    paperNumber: 'Paper 1',
    language: '',
    examSession: '',
  });
});
