import test from 'node:test';
import assert from 'node:assert/strict';
import { getEmailPortal, getEmailPortalBaseUrl, resolveEmailAppUrl } from './emailPortalUrls.js';

test('selects role-specific custom domains, including teacher accounts stored as tutors', () => {
  for (const role of ['student', 'admin', 'tutor', 'teacher', 'parent']) {
    assert.equal(getEmailPortal({ role }), role);
    assert.equal(getEmailPortalBaseUrl({ role }), {
      student: 'https://examifying.bakayise.com',
      admin: 'https://admin.examifying.bakayise.com',
      tutor: 'https://tutors.examifying.bakayise.com',
      teacher: 'https://teachers.examifying.bakayise.com',
      parent: 'https://parents.examifying.bakayise.com',
    }[role]);
  }
  assert.equal(getEmailPortal({ role: 'tutor', isTeacher: true }), 'teacher');
});

test('builds links on the recipient domain and corrects mismatched role dashboard routes', () => {
  assert.equal(resolveEmailAppUrl('/tutor', { role: 'teacher' }), 'https://teachers.examifying.bakayise.com/teacher');
  assert.equal(resolveEmailAppUrl('/student/billing?planId=circle', { role: 'parent' }), 'https://parents.examifying.bakayise.com/parent?planId=circle');
  assert.equal(resolveEmailAppUrl('/student/exercises', { role: 'student' }), 'https://examifying.bakayise.com/student/exercises');
});

test('rewrites legacy Examifying web.app links but preserves unrelated external URLs', () => {
  assert.equal(resolveEmailAppUrl('https://examifying.web.app/student', { role: 'student' }), 'https://examifying.bakayise.com/student');
  assert.equal(resolveEmailAppUrl('https://example.com/help', { role: 'teacher' }), 'https://example.com/help');
});
