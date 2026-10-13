import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getEmailPortal,
  getEmailPortalBaseUrl,
  resolveEmailAppUrl,
  rewriteLegacyEmailPortalLinks,
} from './emailPortalUrls.js';

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

test('repairs already queued email HTML and text using the recipient portal', () => {
  const legacyMessage = {
    html: '<img src="https://examifying.web.app/logo.png"><a href="https://examifying.web.app/student/billing">Pay</a><span>examifying.web.app</span>',
    text: 'Open https://examifying.web.app/student/billing',
  };
  const rewritten = rewriteLegacyEmailPortalLinks(legacyMessage, { role: 'parent' });

  assert.ok(rewritten.html.includes('https://parents.examifying.bakayise.com/logo.png'));
  assert.ok(rewritten.html.includes('https://parents.examifying.bakayise.com/parent'));
  assert.ok(rewritten.html.includes('parents.examifying.bakayise.com</span>'));
  assert.ok(rewritten.text.includes('https://parents.examifying.bakayise.com/parent'));
  assert.ok(!`${rewritten.html}\n${rewritten.text}`.includes('.web.app'));
});

test('infers a legacy email portal from role-specific action routes', () => {
  const rewritten = rewriteLegacyEmailPortalLinks({
    html: '<a href="https://examifying-tutors.web.app/tutor">Open</a><a href="https://examifying.web.app">Home</a>',
    text: 'https://examifying.web.app/tutor',
  });

  assert.ok(rewritten.html.includes('https://tutors.examifying.bakayise.com/tutor'));
  assert.ok(rewritten.html.includes('href="https://tutors.examifying.bakayise.com/"'));
  assert.ok(rewritten.text.includes('https://tutors.examifying.bakayise.com/tutor'));
  assert.ok(!`${rewritten.html}\n${rewritten.text}`.includes('.web.app'));
});
