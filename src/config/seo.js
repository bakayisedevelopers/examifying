import { getPortalSiteUrl } from '../utils/portal.js';
import { getPublicPaperSlug } from '../utils/publicPaperSlug.js';

export const PORTAL_SEO = {
  student: {
    title: 'Examifying | Online Maths Practice in South Africa',
    description: 'Examifying helps South African students build Mathematics confidence with daily practice, past-paper questions, peer marking, and tutor guidance.',
    keywords: 'Maths tutor South Africa, online maths tutor, maths tutor for students, online maths practice, South African maths exam preparation, daily Mathematics exercises, maths past papers, peer marking, Examifying',
  },
  tutor: {
    title: 'Examifying | Online Maths Tutor Platform in South Africa',
    description: 'An online Maths tutor workspace to manage connected students, review exercise submissions, track topic understanding, and link lessons with daily practice.',
    keywords: 'online maths tutor platform, Maths tutor portal, tutoring students online, tutor student management, maths lesson tracking, tutor exercise review, manage tutoring students online, Examifying tutor',
  },
  teacher: {
    title: 'Examifying | Maths Teacher Tools and Learner Progress',
    description: 'A Maths teacher portal for tracking learner progress, reviewing exercise submissions, following topic understanding, and connecting lessons with daily practice.',
    keywords: 'online maths teacher tools, South African maths teacher portal, Mathematics learner progress, maths lesson management, daily maths practice for learners, teacher exercise review, Examifying teacher',
  },
  parent: {
    title: 'Examifying | Parent Maths Progress Portal in South Africa',
    description: 'Follow your child’s Maths learning with a parent portal for linked learners, available exercise activity, and progress information from Examifying.',
    keywords: 'parent maths portal, child maths progress, maths learning for children, online maths practice for school students, South African Mathematics exam support, parent dashboard, tutor-supported maths learning, Examifying parent portal',
  },
  admin: {
    title: 'Examifying Administration Portal',
    description: 'Secure sign-in for authorised Examifying platform administrators.',
    keywords: 'Examifying administration portal',
  },
};

const PAGE_DESCRIPTIONS = {
  login: 'Sign in to your Examifying account to continue to your role-specific Mathematics learning workspace.',
  signup: 'Create an Examifying account and choose the role-specific Mathematics learning portal that is right for you.',
  policies: 'Read Examifying terms of use, privacy information, refund policy, and contact details.',
  dashboard: 'View your Examifying dashboard and the learning information available to your account.',
  exercises: 'View daily Mathematics exercises and related learning activity in Examifying.',
  lessons: 'View Mathematics lessons and learning activities in Examifying.',
  papers: 'Explore Mathematics past exam papers available in Examifying.',
  students: 'Manage connected learners and review the student information available to your account.',
  profile: 'View your Examifying account profile and preferences.',
};

const getSiteOrigin = (portal) => getPortalSiteUrl(portal).replace(/\/$/, '');
export const PUBLIC_SEARCH_ORIGIN = getSiteOrigin('student');
const publicPaperPath = /^\/papers\/([^/]+)\/?$/;

const getPaperFields = (paper = {}) => {
  const metadata = paper.paperMetadata && typeof paper.paperMetadata === 'object' ? paper.paperMetadata : {};
  const subject = String(paper.subject || metadata.subject || 'Past examination paper').trim();
  const grade = String(paper.grade || metadata.grade || '').trim();
  const year = String(paper.year || metadata.year || '').trim();
  const month = String(paper.month || metadata.month || '').trim();
  const region = String(paper.region || paper.province || metadata.region || metadata.province || '').trim();
  const rawPaperNumber = String(paper.paperNumber || metadata.paperNumber || '').trim();
  const paperNumber = rawPaperNumber && !/^paper\b/i.test(rawPaperNumber) ? `Paper ${rawPaperNumber}` : rawPaperNumber;
  return { subject, grade, year, month, region, paperNumber };
};

const getQuestionPaperObjectPath = (value) => {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:') return '';
    if (url.hostname === 'firebasestorage.googleapis.com') return decodeURIComponent(url.pathname.split('/o/')[1] ?? '');
    if (url.hostname === 'storage.googleapis.com') return decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
  } catch { return ''; }
  return '';
};

export const getPublicPaperSeo = (paper, paperId, portal = 'student') => {
  if (!paperId || !getQuestionPaperObjectPath(paper?.paperUrl).startsWith('questionPapers/') || paper?.isPublic === false
    || paper?.public === false || paper?.publiclyAvailable === false
    || String(paper?.visibility ?? '').toLowerCase() === 'private'
    || String(paper?.status ?? '').toLowerCase() === 'deleted') return null;
  const fields = getPaperFields(paper);
  const origin = getSiteOrigin(portal);
  const title = `${[fields.subject, fields.grade, fields.month, fields.year, fields.region, fields.paperNumber].filter(Boolean).join(' · ')} Past Paper | Examifying`;
  const memoAvailable = getQuestionPaperObjectPath(paper?.memoUrl).startsWith('questionPapers/');
  const description = `${fields.subject}${fields.grade ? ` ${fields.grade}` : ''}${fields.year ? ` ${fields.year}` : ''}${fields.month ? ` ${fields.month}` : ''}${fields.region ? ` · ${fields.region}` : ''}${fields.paperNumber ? ` · ${fields.paperNumber}` : ''} South African past exam paper. ${memoAvailable ? 'A memorandum is available.' : 'No memorandum is currently listed.'}`;
  return {
    ...fields,
    title,
    description,
    memoAvailable,
    slug: getPublicPaperSlug(paper, paperId),
    url: `${origin}/papers/${getPublicPaperSlug(paper, paperId)}`,
    robots: 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1',
    indexable: true,
  };
};

export const buildPublicPaperStructuredData = (seo, portal = 'student') => {
  const origin = getSiteOrigin(portal);
  return {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'EducationalOrganization',
      '@id': `${origin}/#organization`,
      name: 'Examifying',
      url: `${origin}/`,
      logo: { '@type': 'ImageObject', url: `${origin}/logo.png` },
    },
    {
      '@type': 'LearningResource',
      '@id': `${seo.url}#learning-resource`,
      name: seo.title,
      description: seo.description,
      url: seo.url,
      learningResourceType: 'Past examination question paper',
      educationalLevel: seo.grade || undefined,
      about: seo.subject,
      inLanguage: 'en-ZA',
      isAccessibleForFree: true,
      provider: { '@id': `${origin}/#organization` },
      additionalProperty: [
        { '@type': 'PropertyValue', name: 'Year', value: seo.year || 'Not listed' },
        { '@type': 'PropertyValue', name: 'Month', value: seo.month || 'Not listed' },
        { '@type': 'PropertyValue', name: 'Province or region', value: seo.region || 'Not listed' },
        { '@type': 'PropertyValue', name: 'Paper number', value: seo.paperNumber || 'Not listed' },
        { '@type': 'PropertyValue', name: 'Memo available', value: seo.memoAvailable ? 'Yes' : 'No' },
      ],
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${origin}/` },
        { '@type': 'ListItem', position: 2, name: 'Past papers', item: `${origin}/papers` },
        { '@type': 'ListItem', position: 3, name: seo.title, item: seo.url },
      ],
    },
  ],
  };
};

export const getRouteSeo = (pathname, portal) => {
  const portalSeo = PORTAL_SEO[portal] || PORTAL_SEO.student;

  if (pathname === '/papers') {
    return {
      title: 'South African Past Exam Papers | Examifying',
      description: 'Browse public South African past examination question papers by subject, grade, year, month, province or region, and paper number. Check whether each paper has a memo.',
      keywords: 'South African past exam papers, question papers, exam memoranda, subject, grade, province, Examifying',
      url: `${getSiteOrigin(portal)}/papers`,
      robots: portal === 'admin' ? 'noindex,nofollow' : 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1',
      indexable: portal !== 'admin',
    };
  }

  const publicPaperMatch = pathname.match(publicPaperPath);
  if (publicPaperMatch) {
    return {
      title: 'Past Exam Paper | Examifying',
      description: 'Open this public South African past exam paper and check whether a memorandum is available.',
      keywords: 'past exam paper, question paper, memorandum, South Africa, Examifying',
      url: `${getSiteOrigin(portal)}/papers/${encodeURIComponent(decodeURIComponent(publicPaperMatch[1]))}`,
      robots: portal === 'admin' ? 'noindex,nofollow' : 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1',
      indexable: portal !== 'admin',
    };
  }

  if (pathname === '/') {
    return {
      ...portalSeo,
      url: `${getSiteOrigin(portal)}/`,
      robots: portal === 'admin' ? 'noindex,nofollow' : 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1',
      indexable: portal !== 'admin',
    };
  }

  if (pathname === '/policies') {
    return {
      title: 'Policies | Examifying',
      description: PAGE_DESCRIPTIONS.policies,
      keywords: 'Examifying terms, privacy policy, refund policy, contact',
      url: `${getSiteOrigin(portal)}/policies`,
      robots: portal === 'admin' ? 'noindex,nofollow' : 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1',
      indexable: portal !== 'admin',
    };
  }

  if (pathname === '/login' || pathname === '/signup') {
    const isLogin = pathname === '/login';
    return {
      title: `${isLogin ? 'Sign in' : 'Create an account'} | ${portalSeo.title.split('|')[0].trim()}`,
      description: PAGE_DESCRIPTIONS[isLogin ? 'login' : 'signup'],
      keywords: portalSeo.keywords,
      robots: 'noindex,nofollow',
      indexable: false,
    };
  }

  const pageSegment = pathname.split('/').filter(Boolean)[1];
  const section = pageSegment === 'profile'
    ? 'profile'
    : ['exercises', 'lessons', 'papers', 'students'].includes(pageSegment)
      ? pageSegment
      : 'dashboard';

  return {
    title: `${portal[0].toUpperCase()}${portal.slice(1)} | ${section === 'dashboard' ? 'Workspace' : section[0].toUpperCase() + section.slice(1)}`,
    description: PAGE_DESCRIPTIONS[section],
    keywords: portalSeo.keywords,
    robots: 'noindex,nofollow',
    indexable: false,
  };
};

export const buildStructuredData = (portal, pathname = '/') => {
  const routeSeo = getRouteSeo(pathname, portal);
  if (!routeSeo.indexable) return null;

  if (pathname === '/papers') {
    return {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: routeSeo.title,
      description: routeSeo.description,
      url: routeSeo.url,
      inLanguage: 'en-ZA',
    };
  }

  const origin = getSiteOrigin(portal);
  const organizationId = `${origin}/#organization`;
  const websiteId = `${origin}/#website`;
  const pageUrl = routeSeo.url;

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'EducationalOrganization',
        '@id': organizationId,
        name: 'Examifying',
        url: `${origin}/`,
        logo: {
          '@type': 'ImageObject',
          url: `${origin}/logo.png`,
        },
        description: PORTAL_SEO[portal]?.description || PORTAL_SEO.student.description,
      },
      {
        '@type': 'WebSite',
        '@id': websiteId,
        name: 'Examifying',
        url: `${origin}/`,
        publisher: { '@id': organizationId },
        inLanguage: 'en-ZA',
      },
      {
        '@type': 'WebPage',
        '@id': `${pageUrl}#webpage`,
        url: pageUrl,
        name: routeSeo.title,
        description: routeSeo.description,
        isPartOf: { '@id': websiteId },
        about: { '@id': organizationId },
        inLanguage: 'en-ZA',
      },
      ...(pathname === '/' && portal !== 'admin'
        ? [{
          '@type': 'SoftwareApplication',
          name: 'Examifying',
          applicationCategory: 'EducationalApplication',
          operatingSystem: 'Web',
          url: `${origin}/`,
          description: PORTAL_SEO[portal]?.description || PORTAL_SEO.student.description,
        }]
        : []),
    ],
  };
};
