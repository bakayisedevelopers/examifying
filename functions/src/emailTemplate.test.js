import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBrandedEmail } from './emailTemplate.js';

const portalUrls = {
  student: 'https://examifying.bakayise.com',
  admin: 'https://admin.examifying.bakayise.com',
  tutor: 'https://tutors.examifying.bakayise.com',
  teacher: 'https://teachers.examifying.bakayise.com',
  parent: 'https://parents.examifying.bakayise.com',
};

test('email links and logo use the recipient role custom domain', () => {
  for (const [role, portalUrl] of Object.entries(portalUrls)) {
    const route = `/${role}`;
    const { html, text } = renderBrandedEmail({
      profile: { role },
      name: 'Examifying User',
      heading: 'Welcome',
      paragraphs: ['Your account is ready.'],
      actionLabel: 'Open Examifying',
      actionUrl: route,
    });

    assert.ok(html.includes(`src="${portalUrl}/logo.png"`));
    assert.ok(html.includes(`href="${portalUrl}${route}"`));
    assert.ok(html.includes(`href="${portalUrl}/"`));
    assert.ok(text.includes(`${portalUrl}${route}`));
    assert.ok(!`${html}\n${text}`.includes('.web.app'));
  }
});

test('legacy Firebase Hosting action links are rewritten before rendering', () => {
  const { html, text } = renderBrandedEmail({
    profile: { role: 'tutor' },
    heading: 'Tutor update',
    actionLabel: 'Open tutor dashboard',
    actionUrl: 'https://examifying-tutors.web.app/tutor',
  });

  assert.ok(html.includes('href="https://tutors.examifying.bakayise.com/tutor"'));
  assert.ok(text.includes('https://tutors.examifying.bakayise.com/tutor'));
  assert.ok(!`${html}\n${text}`.includes('.web.app'));
});

test('teacher email branding respects teacher profiles stored as tutors', () => {
  const { html, text } = renderBrandedEmail({
    profile: { role: 'tutor', isTeacher: true },
    heading: 'Teacher update',
    actionLabel: 'Open teacher dashboard',
    actionUrl: '/teacher',
  });

  assert.ok(html.includes('src="https://teachers.examifying.bakayise.com/logo.png"'));
  assert.ok(text.includes('https://teachers.examifying.bakayise.com/teacher'));
});
