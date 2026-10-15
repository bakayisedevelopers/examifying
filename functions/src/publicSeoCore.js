export const PUBLIC_SEARCH_ORIGIN = 'https://examifying.bakayise.com';
export const PUBLIC_SEO_ORIGINS = Object.freeze({
  student: PUBLIC_SEARCH_ORIGIN,
  parent: 'https://parents.examifying.bakayise.com',
  tutor: 'https://tutors.examifying.bakayise.com',
  teacher: 'https://teachers.examifying.bakayise.com',
});
const PUBLIC_SEO_ORIGINS_BY_HOST = new Map(Object.values(PUBLIC_SEO_ORIGINS).map((origin) => [new URL(origin).hostname, origin]));

export const getPublicSeoOriginForHost = (hostname) => {
  const normalizedHostname = String(hostname ?? '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return PUBLIC_SEO_ORIGINS_BY_HOST.get(normalizedHostname) || null;
};
export const PUBLIC_SEARCH_PROPERTY = `${PUBLIC_SEARCH_ORIGIN}/`;

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');
const escapeXml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');
const encodeJsonLd = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');

export const getStorageObjectDetails = (value) => {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:') return null;
    if (url.hostname === 'firebasestorage.googleapis.com') {
      const encoded = url.pathname.split('/o/')[1] ?? '';
      const bucketMatch = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\//);
      return {
        bucket: bucketMatch ? decodeURIComponent(bucketMatch[1]) : '',
        path: decodeURIComponent(encoded),
      };
    }
    if (url.hostname === 'storage.googleapis.com') {
      const [, ...segments] = url.pathname.split('/');
      return {
        bucket: decodeURIComponent(segments.shift() ?? ''),
        path: decodeURIComponent(segments.join('/')),
      };
    }
  } catch { return null; }
  return null;
};

const isQuestionPaperObjectUrl = (value, expectedBucket = '') => {
  const details = getStorageObjectDetails(value);
  const safeObjectPath = details?.path.startsWith('questionPapers/')
    && !details.path.split('/').some((segment) => !segment || segment === '.' || segment === '..');
  return Boolean(safeObjectPath
    && (!expectedBucket || details.bucket === expectedBucket));
};

export const isPublicQuestionPaperRecord = (paper = {}, expectedBucket = '') => {
  if (paper.isPublic === false || paper.public === false || paper.publiclyAvailable === false
    || String(paper.visibility ?? '').toLowerCase() === 'private'
    || String(paper.status ?? '').toLowerCase() === 'deleted') return false;
  return isQuestionPaperObjectUrl(paper.paperUrl, expectedBucket);
};

export const isPublicMemoUrl = (memoUrl, expectedBucket = '') => isQuestionPaperObjectUrl(memoUrl, expectedBucket);

const paperFields = (paper = {}) => {
  const metadata = paper.paperMetadata && typeof paper.paperMetadata === 'object' ? paper.paperMetadata : {};
  const subject = clean(paper.subject || metadata.subject) || 'Past examination paper';
  const grade = clean(paper.grade || metadata.grade);
  const year = clean(paper.year || metadata.year);
  const month = clean(paper.month || metadata.month);
  const region = clean(paper.region || paper.province || metadata.region || metadata.province);
  const rawPaperNumber = clean(paper.paperNumber || metadata.paperNumber);
  const paperNumber = rawPaperNumber && !/^paper\b/i.test(rawPaperNumber) ? `Paper ${rawPaperNumber}` : rawPaperNumber;
  return { subject, grade, year, month, region, paperNumber };
};

const paperDisplayParts = (fields) => [fields.subject, fields.grade, fields.month, fields.year, fields.region, fields.paperNumber]
  .filter(Boolean);

export const getPublicPaperSeo = (paper, paperId, origin = PUBLIC_SEARCH_ORIGIN, expectedBucket = '') => {
  if (!paperId || !isPublicQuestionPaperRecord(paper, expectedBucket)) return null;
  const fields = paperFields(paper);
  const title = `${paperDisplayParts(fields).join(' · ')} Past Paper | Examifying`;
  const memoAvailable = isPublicMemoUrl(paper.memoUrl, expectedBucket);
  const description = `${fields.subject}${fields.grade ? ` ${fields.grade}` : ''}${fields.year ? ` ${fields.year}` : ''}${fields.month ? ` ${fields.month}` : ''}${fields.region ? ` · ${fields.region}` : ''}${fields.paperNumber ? ` · ${fields.paperNumber}` : ''} South African past exam paper. ${memoAvailable ? 'A memorandum is available.' : 'No memorandum is currently listed.'}`;
  const url = `${origin.replace(/\/$/, '')}/papers/${encodeURIComponent(paperId)}`;
  return {
    ...fields,
    title,
    description,
    url,
    memoAvailable,
    robots: 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1',
    lastModified: paper.updatedAt?.toDate?.() ?? paper.createdAt?.toDate?.() ?? null,
  };
};

export const getPublicPaperPayload = (paper, paperId, expectedBucket = '') => {
  const seo = getPublicPaperSeo(paper, paperId, PUBLIC_SEARCH_ORIGIN, expectedBucket);
  if (!seo) return null;
  return {
    id: paperId,
    displayName: clean(paper.displayName || paper.paperTitle || seo.title.replace(/\s*\|\s*Examifying$/, '')),
    subject: seo.subject,
    grade: seo.grade,
    year: seo.year,
    month: seo.month,
    region: seo.region,
    paperNumber: seo.paperNumber,
    paperUrl: paper.paperUrl,
    memoUrl: seo.memoAvailable ? paper.memoUrl : '',
    memoAvailable: seo.memoAvailable,
  };
};

export const buildPublicPaperStructuredData = (seo, origin = PUBLIC_SEARCH_ORIGIN) => ({
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
});

export const buildPublicPaperCatalogStructuredData = (papers = [], origin = PUBLIC_SEARCH_ORIGIN) => ({
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  name: 'South African Past Exam Papers | Examifying',
  description: 'Browse public South African past exam papers by subject, grade, year, region, and paper number.',
  url: `${origin}/papers`,
  inLanguage: 'en-ZA',
  mainEntity: {
    '@type': 'ItemList',
    itemListElement: papers.map((paper, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: paper.seo.title,
      url: paper.seo.url,
    })),
  },
});

const sitemapUrl = (loc, lastmod) => `  <url>\n    <loc>${escapeXml(loc)}</loc>${lastmod ? `\n    <lastmod>${escapeXml(lastmod)}</lastmod>` : ''}\n  </url>`;
const getSitemapPaperUrl = (paper, origin) => paper.id
  ? `${origin}/papers/${encodeURIComponent(paper.id)}`
  : paper.seo.url;

export const buildPublicSitemapXml = (papers = [], now = new Date(), origin = PUBLIC_SEARCH_ORIGIN) => {
  const lastmod = now.toISOString().slice(0, 10);
  const entries = [
    sitemapUrl(`${origin}/`, lastmod),
    sitemapUrl(`${origin}/policies`, lastmod),
    sitemapUrl(`${origin}/papers`, lastmod),
    ...papers.filter((paper) => paper.seo).map((paper) => sitemapUrl(getSitemapPaperUrl(paper, origin),
      paper.seo.lastModified instanceof Date && !Number.isNaN(paper.seo.lastModified.valueOf())
        ? paper.seo.lastModified.toISOString().slice(0, 10) : lastmod)),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
};

export const buildPublicPaperSitemapXml = (papers = [], now = new Date(), origin = PUBLIC_SEARCH_ORIGIN) => {
  const lastmod = now.toISOString().slice(0, 10);
  const entries = papers.filter((paper) => paper.seo).map((paper) => sitemapUrl(getSitemapPaperUrl(paper, origin),
    paper.seo.lastModified instanceof Date && !Number.isNaN(paper.seo.lastModified.valueOf())
      ? paper.seo.lastModified.toISOString().slice(0, 10) : lastmod));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
};

export const buildPublicSitemapIndexXml = (paperCount, chunkSize = 20_000, origin = PUBLIC_SEARCH_ORIGIN) => {
  const sitemapUrls = [`${origin}/sitemap-core.xml`];
  for (let page = 0; page < Math.ceil(paperCount / chunkSize); page += 1) {
    sitemapUrls.push(`${origin}/sitemap-papers-${page + 1}.xml`);
  }
  const entries = sitemapUrls.map((loc) => `  <sitemap>\n    <loc>${escapeXml(loc)}</loc>\n  </sitemap>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</sitemapindex>\n`;
};

const replaceHeadTag = (html, selector, content) => {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`<meta\\b(?=[^>]*(?:name|property)=["']${escapedSelector}["'])[^>]*>`, 'i');
  const escapedContent = escapeHtml(content);
  if (expression.test(html)) {
    return html.replace(expression, (tag) => /\bcontent=["'][^"']*["']/i.test(tag)
      ? tag.replace(/\bcontent=(["'])[^"']*\1/i, `content="${escapedContent}"`)
      : tag.replace(/\s*\/?\s*>$/, ` content="${escapedContent}">`));
  }
  const attribute = selector.startsWith('og:') ? 'property' : 'name';
  return html.replace('</head>', `  <meta ${attribute}="${escapeHtml(selector)}" content="${escapedContent}">\n</head>`);
};

export const renderPublicSeoHtml = ({ shell, seo, structuredData, content }) => {
  let html = String(shell ?? '');
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(seo.title)}</title>`);
  html = replaceHeadTag(html, 'description', seo.description);
  html = replaceHeadTag(html, 'robots', seo.robots || 'index,follow');
  html = replaceHeadTag(html, 'keywords', `${seo.subject || 'South African past papers'}, ${seo.grade || ''}, ${seo.year || ''}, exam paper, memorandum, Examifying`);
  html = replaceHeadTag(html, 'og:title', seo.title);
  html = replaceHeadTag(html, 'og:description', seo.description);
  html = replaceHeadTag(html, 'og:url', seo.url);
  html = replaceHeadTag(html, 'og:type', seo.ogType || 'article');
  html = replaceHeadTag(html, 'twitter:title', seo.title);
  html = replaceHeadTag(html, 'twitter:description', seo.description);
  const canonical = `<link rel="canonical" href="${escapeHtml(seo.url)}" />`;
  html = /<link\b[^>]*rel=["']canonical["'][^>]*>/i.test(html)
    ? html.replace(/<link\b[^>]*rel=["']canonical["'][^>]*>/i, canonical)
    : html.replace('</head>', `  ${canonical}\n</head>`);
  const script = `<script id="seo-structured-data" type="application/ld+json">${encodeJsonLd(structuredData)}</script>`;
  html = /<script\b[^>]*id=["']seo-structured-data["'][^>]*>[\s\S]*?<\/script>/i.test(html)
    ? html.replace(/<script\b[^>]*id=["']seo-structured-data["'][^>]*>[\s\S]*?<\/script>/i, script)
    : html.replace('</head>', `  ${script}\n</head>`);
  const rootMarkup = `<div id="root">${content}</div>`;
  html = html.replace(/<div\s+id=["']root["']\s*>\s*<\/div>/i, rootMarkup);
  return html;
};

export const renderPublicPaperContent = (seo) => `
  <main class="public-seo-content" aria-label="Past examination paper details">
    <nav aria-label="Breadcrumb"><a href="/">Home</a> / <a href="/papers">Past papers</a></nav>
    <article>
      <h1>${escapeHtml(seo.title.replace(/\s*\|\s*Examifying$/, ''))}</h1>
      <p>${escapeHtml(seo.description)}</p>
      <dl>
        <dt>Subject</dt><dd>${escapeHtml(seo.subject)}</dd>
        <dt>Grade</dt><dd>${escapeHtml(seo.grade || 'Not listed')}</dd>
        <dt>Year</dt><dd>${escapeHtml(seo.year || 'Not listed')}</dd>
        <dt>Month</dt><dd>${escapeHtml(seo.month || 'Not listed')}</dd>
        <dt>Province or region</dt><dd>${escapeHtml(seo.region || 'Not listed')}</dd>
        <dt>Paper number</dt><dd>${escapeHtml(seo.paperNumber || 'Not listed')}</dd>
        <dt>Memo availability</dt><dd>${seo.memoAvailable ? 'Memo available' : 'Memo not listed'}</dd>
      </dl>
      <p><a href="/papers">Browse all public past papers</a></p>
    </article>
  </main>`;

export const renderPublicPaperCatalogContent = (papers = []) => `
  <main class="public-seo-content" aria-label="Public past-paper catalogue">
    <nav aria-label="Breadcrumb"><a href="/">Home</a> / Past papers</nav>
    <h1>South African Past Exam Papers</h1>
    <p>Browse public question papers by subject, grade, year, month, province or region, and paper number. Open the paper page to view memo availability.</p>
    <ul>${papers.map(({ seo }) => `<li><a href="${escapeHtml(seo.url)}">${escapeHtml(seo.title.replace(/\s*\|\s*Examifying$/, ''))}</a> · ${seo.memoAvailable ? 'Memo available' : 'Memo not listed'}</li>`).join('\n')}</ul>
  </main>`;

export const renderPublicPaperCoreContent = () => `
  <main class="public-seo-content" aria-label="Examifying public pages">
    <h1>Examifying past papers and learning support</h1>
    <p>Browse public South African past examination papers or learn about Examifying.</p>
    <ul><li><a href="/papers">Browse past papers</a></li><li><a href="/policies">Policies</a></li></ul>
  </main>`;

export const escapePublicHtml = escapeHtml;
