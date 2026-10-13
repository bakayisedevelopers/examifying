import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDeletionDate, getScheduledAccountDeletionDate, removeUserFromStaffEpisode, scrubUserReferences } from './accountDeletionCore.js';

test('schedules deletion at the first South African midnight after the full 30-day grace period', () => {
  const scheduledFor = getScheduledAccountDeletionDate(new Date('2026-10-13T10:30:00.000Z'));
  assert.equal(scheduledFor.toISOString(), '2026-11-12T22:00:00.000Z');
  assert.equal(formatDeletionDate(scheduledFor), '13 November 2026');
});

test('removes matching account IDs from nested fields, maps and arrays while retaining other data', () => {
  const createdAt = new Date('2026-10-13T00:00:00.000Z');
  const { value, changed } = scrubUserReferences({
    parentId: 'delete-me',
    activeIds: ['keep-me', 'delete-me'],
    staff: { 'delete-me': 'marker', other: { grantedBy: 'delete-me', uid: 'keep-me' } },
    createdAt,
  }, 'delete-me');

  assert.equal(changed, true);
  assert.deepEqual(value, {
    activeIds: ['keep-me'],
    staff: { other: { uid: 'keep-me' } },
    createdAt,
  });
});

test('removes a deleted tutor from every staff assignment and keeps unrelated tutors', () => {
  const cleaned = removeUserFromStaffEpisode({
    primaryTutorId: 'delete-me',
    activeStaffIds: ['delete-me', 'keep-me'],
    historicalStaffIds: ['delete-me', 'keep-me'],
    staffByUid: { 'delete-me': 'co-owner', 'keep-me': 'marker' },
    staffMemberships: [
      { uid: 'delete-me', grantedBy: 'admin' },
      { uid: 'keep-me', grantedBy: 'delete-me' },
    ],
  }, 'delete-me');

  assert.equal(cleaned.primaryTutorId, '');
  assert.deepEqual(cleaned.activeStaffIds, ['keep-me']);
  assert.deepEqual(cleaned.historicalStaffIds, ['keep-me']);
  assert.deepEqual(cleaned.staffByUid, { 'keep-me': 'marker' });
  assert.deepEqual(cleaned.staffMemberships, [{ uid: 'keep-me' }]);
});
