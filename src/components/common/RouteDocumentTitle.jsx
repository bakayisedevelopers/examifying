import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { buildPublicPaperStructuredData, buildStructuredData, getPublicPaperSeo, getRouteSeo } from '../../config/seo';
import { getPortal } from '../../utils/portal';
import { getPublicQuestionPaperById } from '../../services/publicQuestionPaperService';

const roleTitles = {
  admin: 'Admin',
  parent: 'Parent',
  student: 'Student',
  teacher: 'Teacher',
  tutor: 'Tutor',
};

const pageTitles = {
  admin: { users: 'Users', payments: 'Payments', settings: 'Settings', papers: 'Question papers' },
  parent: { 'family-subscription': 'Family Subscription', profile: 'Profile' },
  student: { billing: 'Subscription', exercises: 'Exercises', lessons: 'Lessons', papers: 'Question papers', 'peer-reviews': 'Peer reviews', profile: 'Profile', guide: 'Guide' },
  teacher: { exercises: 'Exercises', guide: 'Guide', lessons: 'Lessons', papers: 'Question papers', profile: 'Profile', reports: 'Reports', students: 'Students' },
  tutor: { exercises: 'Exercises', guide: 'Guide', lessons: 'Lessons', papers: 'Question papers', profile: 'Profile', reports: 'Reports', students: 'Students' },
};

const getPageTitle = (pathname, role) => {
  const parts = pathname.split('/').filter(Boolean);
  const roleSegment = ['admin', 'parent', 'student', 'teacher', 'tutor'].includes(parts[0]) ? parts.shift() : null;
  if (!roleSegment) {
    if (pathname === '/') return 'Home';
    if (pathname === '/login') return 'Sign in';
    if (pathname === '/signup') return 'Create account';
    if (pathname === '/policies') return 'Policies';
    return 'Examifying';
  }
  if (!parts.length) return 'Home';
  const [section, detail] = parts;
  if (section === 'profile') return 'Profile';
  if (section === 'users' && detail) return 'User details';
  if (section === 'students' && detail) return 'Student details';
  if (['exercises', 'lessons', 'papers'].includes(section) && detail) {
    return { exercises: 'Exercise details', lessons: 'Lesson details', papers: 'Question paper' }[section];
  }
  return pageTitles[role]?.[section] || pageTitles[roleSegment]?.[section] || 'Home';
};

export const RouteDocumentTitle = () => {
  const { pathname } = useLocation();
  const { profile } = useAuth();
  const portal = getPortal();

  useEffect(() => {
    let active = true;
    const routeSeo = getRouteSeo(pathname, portal);
    const pathRole = pathname.split('/').filter(Boolean)[0];
    const normalizedRole = profile?.isTeacher || pathRole === 'teacher'
      ? 'teacher'
      : (profile?.role || (roleTitles[pathRole] ? pathRole : null));

    let pageTitle = routeSeo.title;
    if (pathname === '/' || pathname === '/login' || pathname === '/signup' || pathname === '/policies') {
      pageTitle = routeSeo.title;
    } else {
      const roleTitle = roleTitles[normalizedRole];
      const workspaceTitle = getPageTitle(pathname, normalizedRole || pathRole);
      pageTitle = roleTitle ? `${roleTitle} | ${workspaceTitle}` : `Examifying | ${workspaceTitle}`;
    }

    const applySeo = (seo, title, structuredPayload) => {
      if (!active) return;
      document.title = title;
      const setMeta = (selector, attribute, value) => {
        let element = document.head.querySelector(selector);
        if (!value) {
          element?.remove();
          return;
        }
        if (!element) {
          element = document.createElement('meta');
          document.head.appendChild(element);
        }
        element.setAttribute(attribute, value);
      };

      setMeta('meta[name="description"]', 'content', seo.description);
      setMeta('meta[name="keywords"]', 'content', seo.keywords);
      setMeta('meta[name="robots"]', 'content', seo.robots);
      setMeta('meta[property="og:title"]', 'content', title);
      setMeta('meta[property="og:description"]', 'content', seo.description);
      setMeta('meta[property="og:url"]', 'content', seo.url || `${window.location.origin}${pathname}`);
      setMeta('meta[property="og:type"]', 'content', pathname.startsWith('/papers/') ? 'article' : 'website');
      setMeta('meta[property="og:image"]', 'content', `${window.location.origin}/logo.png`);
      setMeta('meta[name="twitter:title"]', 'content', title);
      setMeta('meta[name="twitter:description"]', 'content', seo.description);
      setMeta('meta[name="twitter:image"]', 'content', `${window.location.origin}/logo.png`);

      let canonical = document.head.querySelector('link[rel="canonical"]');
      if (seo.indexable && seo.url) {
        if (!canonical) {
          canonical = document.createElement('link');
          canonical.rel = 'canonical';
          document.head.appendChild(canonical);
        }
        canonical.href = seo.url;
      } else {
        canonical?.remove();
      }

      let structuredData = document.head.querySelector('#seo-structured-data');
      if (structuredPayload) {
        if (!structuredData) {
          structuredData = document.createElement('script');
          structuredData.id = 'seo-structured-data';
          structuredData.type = 'application/ld+json';
          document.head.appendChild(structuredData);
        }
        structuredData.textContent = JSON.stringify(structuredPayload);
      } else {
        structuredData?.remove();
      }
    };

    applySeo(routeSeo, pageTitle, buildStructuredData(portal, pathname));

    const paperMatch = pathname.match(/^\/papers\/([A-Za-z0-9_-]{1,150})\/?$/);
    if (paperMatch && portal !== 'admin') {
      getPublicQuestionPaperById(paperMatch[1]).then((paper) => {
        if (!active) return;
        const paperSeo = getPublicPaperSeo(paper, paperMatch[1], portal);
        if (paperSeo) {
          applySeo(paperSeo, paperSeo.title, buildPublicPaperStructuredData(paperSeo, portal));
        } else {
          applySeo({ ...routeSeo, title: 'Past paper not found | Examifying', robots: 'noindex,follow', indexable: false }, 'Past paper not found | Examifying', null);
        }
        }).catch(() => {
        if (active) applySeo({ ...routeSeo, robots: 'noindex,follow', indexable: false }, 'Past paper | Examifying', null);
      });
    }
    return () => { active = false; };
  }, [pathname, portal, profile?.isTeacher, profile?.role]);

  return null;
};
