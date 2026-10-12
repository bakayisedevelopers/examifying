import assert from 'node:assert/strict';
import test from 'node:test';
import { findVerifiedPaperRegionCorrection, normalizePaperIdentityValue, normalizePaperRegionIdentity } from './paperIdentity.js';

test('paper region identity accepts only explicit South African province aliases', () => {
  const aliases = [
    ['EC', 'Eastern Cape'],
    ['Province of Free State', 'Free State'],
    ['Gauteng Province', 'Gauteng'],
    ['KZN', 'KwaZulu-Natal'],
    ['Limpopo Province', 'Limpopo'],
    ['MP', 'Mpumalanga'],
    ['North West Province', 'North West'],
    ['NC', 'Northern Cape'],
    ['Western Cape Province', 'Western Cape'],
    ['National', 'National'],
  ];

  aliases.forEach(([alias, canonical]) => {
    assert.equal(normalizePaperRegionIdentity(alias), normalizePaperRegionIdentity(canonical));
  });
  assert.notEqual(normalizePaperRegionIdentity('North West'), normalizePaperRegionIdentity('Western Cape'));
  assert.equal(normalizePaperRegionIdentity('Regional'), 'regional');
});

test('paper identity normalization applies province aliases only to region fields', () => {
  assert.equal(normalizePaperIdentityValue('KZN', 'region'), 'kwazulu natal');
  assert.equal(normalizePaperIdentityValue('KZN', 'subject'), 'kzn');
});

test('a region correction is returned only when the stored record, JSON, and filename agree on every other identity field', () => {
  const storedIdentity = {
    subject: 'Mathematics', grade: 'Grade 12', region: 'Gauteng', month: 'November', year: 2024, paperNumber: 'Paper 1',
  };
  const providedIdentity = { ...storedIdentity, region: 'National' };
  const filenameIdentity = { ...storedIdentity, region: 'National' };

  assert.equal(findVerifiedPaperRegionCorrection({ storedIdentity, providedIdentity, filenameIdentity }), 'National');
  assert.equal(findVerifiedPaperRegionCorrection({
    storedIdentity,
    providedIdentity: { ...providedIdentity, region: 'Eastern Cape' },
    filenameIdentity,
  }), '');
  assert.equal(findVerifiedPaperRegionCorrection({
    storedIdentity,
    providedIdentity,
    filenameIdentity: { ...filenameIdentity, grade: 'Grade 11' },
  }), '');
});
