import test from 'node:test';
import assert from 'node:assert/strict';
import { isManagedStudentInviteProfileEligible } from './managedStudentAccountsCore.js';

test('a linked student profile remains eligible to resume an invite after partial Auth creation', () => {
  assert.equal(isManagedStudentInviteProfileEligible({
    role: 'student',
    parentId: 'parent-1',
    authUserExists: true,
  }, 'parent-1'), true);
});

test('an invite cannot be used for a different parent or non-student profile', () => {
  assert.equal(isManagedStudentInviteProfileEligible({ role: 'student', parentId: 'parent-2' }, 'parent-1'), false);
  assert.equal(isManagedStudentInviteProfileEligible({ role: 'parent', parentId: 'parent-1' }, 'parent-1'), false);
  assert.equal(isManagedStudentInviteProfileEligible(null, 'parent-1'), false);
});
