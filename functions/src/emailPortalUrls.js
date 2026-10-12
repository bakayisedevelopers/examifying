const PORTAL_URLS = Object.freeze({
  student: 'https://examifying.bakayise.com',
  admin: 'https://admin.examifying.bakayise.com',
  tutor: 'https://tutors.examifying.bakayise.com',
  teacher: 'https://teachers.examifying.bakayise.com',
  parent: 'https://parents.examifying.bakayise.com',
});

const PORTAL_PATHS = Object.freeze({
  student: 'student',
  admin: 'admin',
  tutor: 'tutor',
  teacher: 'teacher',
  parent: 'parent',
});

const APP_HOSTS = new Set([
  'examifying.bakayise.com',
  'admin.examifying.bakayise.com',
  'tutors.examifying.bakayise.com',
  'teachers.examifying.bakayise.com',
  'parents.examifying.bakayise.com',
  'examifying.web.app',
  'examifying-admin.web.app',
  'examifying-tutors.web.app',
  'examifying-teachers.web.app',
  'examifying-parents.web.app',
]);

const isTeacherProfile = (profile = {}) => profile.role === 'teacher'
  || profile.isTeacher === true
  || profile.isTeacher === 'true';

export const getEmailPortal = (profile = {}) => {
  if (isTeacherProfile(profile)) return 'teacher';
  return Object.hasOwn(PORTAL_URLS, profile.role) ? profile.role : 'student';
};

export const getEmailPortalBaseUrl = (profile = {}) => PORTAL_URLS[getEmailPortal(profile)];

const routePortalForPath = (pathname = '') => {
  const firstSegment = pathname.split('/').filter(Boolean)[0];
  return Object.hasOwn(PORTAL_PATHS, firstSegment)
    ? firstSegment
    : null;
};

export const resolveEmailAppUrl = (path = '/', profile = {}) => {
  const portal = getEmailPortal(profile);
  const baseUrl = PORTAL_URLS[portal];
  const input = String(path || '/');
  const isAbsoluteUrl = /^https?:\/\//i.test(input);
  const target = isAbsoluteUrl ? new URL(input) : new URL(input.startsWith('/') ? input : `/${input}`, baseUrl);

  if (isAbsoluteUrl && !APP_HOSTS.has(target.hostname.toLowerCase())) return target.toString();

  target.protocol = 'https:';
  target.host = new URL(baseUrl).host;
  const routePortal = routePortalForPath(target.pathname);
  if (routePortal && routePortal !== portal) {
    target.pathname = `/${PORTAL_PATHS[portal]}`;
  }
  return target.toString();
};
