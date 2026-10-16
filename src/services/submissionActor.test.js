import assert from 'node:assert/strict';
import test from 'node:test';
import { requireSubmissionActor } from './submissionActor.js';

test('allows a signed-in parent to attempt submission for a linked student', () => {
  assert.doesNotThrow(() => requireSubmissionActor({
    currentUser: { uid: 'parent-uid' },
    studentId: 'student-uid',
  }));
});

test('requires an authenticated user before attempting submission', () => {
  assert.throws(() => requireSubmissionActor({
    currentUser: null,
    studentId: 'student-uid',
  }), /Sign in to your account/);
});
