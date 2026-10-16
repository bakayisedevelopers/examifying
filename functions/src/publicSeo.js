import { FieldPath } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onRequest } from 'firebase-functions/v2/https';
import { getDb, storage } from './admin.js';
import {
  PUBLIC_SEARCH_ORIGIN,
  buildPublicPaperCatalogStructuredData,
  buildPublicPaperSitemapXml,
  buildPublicPaperStructuredData,
  buildPublicSitemapIndexXml,
  buildPublicSitemapXml,
  getPublicPaperPayload,
  getPublicPaperSeo,
  getPublicPaperIdFromPathSegment,
  getPublicSeoOriginForHost,
  isPublicQuestionPaperRecord,
  renderPublicPaperCatalogContent,
  renderPublicPaperContent,
  renderPublicSeoHtml,
} from './publicSeoCore.js';

const PUBLIC_PAPER_FIELDS = [
  'subject', 'grade', 'year', 'month', 'region', 'province', 'paperNumber', 'paperUrl', 'memoUrl',
  'displayName', 'paperTitle',
  'paperMetadata.subject', 'paperMetadata.grade', 'paperMetadata.year', 'paperMetadata.month',
  'paperMetadata.region', 'paperMetadata.province', 'paperMetadata.paperNumber',
  'isPublic', 'public', 'publiclyAvailable', 'visibility', 'status', 'updatedAt', 'createdAt',
];
const PAGE_SIZE = 1000;
const MAX_PUBLIC_PAPERS = 1_000_000;
const SITEMAP_CHUNK_SIZE = 20_000;
const MAX_CATALOG_LINKS = 2_000;
const SHELL_URL = `${PUBLIC_SEARCH_ORIGIN}/app.html`;
const PUBLIC_FUNCTION_OPTIONS = Object.freeze({
  invoker: 'public',
  region: 'us-central1',
  memory: '256MiB',
  timeoutSeconds: 60,
  maxInstances: 3,
});

let shellPromise;
const publicPaperListCache = new Map();

const getRequestPublicOrigin = (request) => [
  request.hostname,
  request.get?.('host'),
  request.get?.('x-forwarded-host'),
].map(getPublicSeoOriginForHost).find(Boolean) || null;
const getApplicationShell = async () => {
  if (!shellPromise) {
    shellPromise = fetch(SHELL_URL, { headers: { Accept: 'text/html' } }).then(async (response) => {
      if (!response.ok) throw new Error(`Could not load the public app shell (HTTP ${response.status}).`);
      const html = await response.text();
      if (!html.includes('id="root"')) throw new Error('The public app shell has no application root.');
      return html;
    }).catch((error) => {
      shellPromise = null;
      throw error;
    });
  }
  return shellPromise;
};

export const listPublicQuestionPapers = async ({ maxCount = MAX_PUBLIC_PAPERS } = {}) => {
  const db = getDb();
  const papers = [];
  let cursor = null;
  while (papers.length < maxCount) {
    const queryLimit = Math.min(PAGE_SIZE, maxCount - papers.length);
    let query = db.collection('questionPapers')
      .select(...PUBLIC_PAPER_FIELDS)
      .orderBy(FieldPath.documentId())
      .limit(queryLimit);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    snapshot.docs.forEach((document) => {
      const data = document.data();
      if (!isPublicQuestionPaperRecord(data, storage.bucket().name)) return;
      const seo = getPublicPaperSeo(data, document.id, PUBLIC_SEARCH_ORIGIN, storage.bucket().name);
      if (seo) papers.push({ id: document.id, seo });
    });
    cursor = snapshot.docs.at(-1);
    if (snapshot.size < queryLimit) break;
  }
  return papers;
};

const getCachedPublicQuestionPapers = ({ maxCount, origin = PUBLIC_SEARCH_ORIGIN }) => {
  const cached = publicPaperListCache.get(maxCount);
  if (cached?.expiresAt > Date.now()) return cached.promise.then((papers) => papers.map((paper) => ({
    ...paper,
    seo: { ...paper.seo, url: `${origin}/papers/${encodeURIComponent(paper.id)}` },
  })));
  const promise = listPublicQuestionPapers({ maxCount }).catch((error) => {
    publicPaperListCache.delete(maxCount);
    throw error;
  });
  publicPaperListCache.set(maxCount, { promise, expiresAt: Date.now() + 60_000 });
  return promise.then((papers) => papers.map((paper) => ({
    ...paper,
    seo: { ...paper.seo, url: `${origin}/papers/${encodeURIComponent(paper.id)}` },
  })));
};

const setPublicResponseHeaders = (response, contentType) => {
  response.set('Content-Type', contentType);
  response.set('Cache-Control', 'public, max-age=60, s-maxage=300');
  response.set('X-Content-Type-Options', 'nosniff');
};

export const servePublicSitemap = onRequest(PUBLIC_FUNCTION_OPTIONS, async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.set('Allow', 'GET, HEAD').status(405).send('Method not allowed');
    return;
  }
  try {
    const origin = getRequestPublicOrigin(request);
    if (!origin) {
      response.set('X-Robots-Tag', 'noindex').status(404).send('Sitemap not found.');
      return;
    }
    const path = String(request.path ?? '/sitemap.xml');
    let xml;
    if (path === '/sitemap-core.xml') {
      xml = buildPublicSitemapXml([], new Date(), origin);
    } else {
      const papers = await getCachedPublicQuestionPapers({ maxCount: MAX_PUBLIC_PAPERS, origin });
      const shardMatch = path.match(/^\/sitemap-papers-(\d+)\.xml$/);
      if (shardMatch) {
        const page = Number(shardMatch[1]);
        if (!Number.isSafeInteger(page) || page < 1) {
          response.set('X-Robots-Tag', 'noindex').status(404).send('Sitemap not found.');
          return;
        }
        const start = (page - 1) * SITEMAP_CHUNK_SIZE;
        if (start >= papers.length) {
          response.set('X-Robots-Tag', 'noindex').status(404).send('Sitemap not found.');
          return;
        }
        xml = buildPublicPaperSitemapXml(papers.slice(start, start + SITEMAP_CHUNK_SIZE));
      } else if (path === '/sitemap.xml') {
        xml = buildPublicSitemapIndexXml(papers.length, SITEMAP_CHUNK_SIZE, origin);
      } else {
        response.set('X-Robots-Tag', 'noindex').status(404).send('Sitemap not found.');
        return;
      }
      if (papers.length >= MAX_PUBLIC_PAPERS) {
        logger.warn('Public SEO sitemap paper limit reached', { limit: MAX_PUBLIC_PAPERS });
      }
    }
    setPublicResponseHeaders(response, 'application/xml; charset=utf-8');
    response.set('X-Robots-Tag', 'noindex');
    response.status(200).send(request.method === 'HEAD' ? '' : xml);
  } catch (error) {
    logger.error('Public SEO sitemap generation failed', { code: String(error?.code || error?.name || 'sitemap_error') });
    response.status(500).type('text/plain').send('Sitemap temporarily unavailable.');
  }
});

export const servePublicPaperData = onRequest(PUBLIC_FUNCTION_OPTIONS, async (request, response) => {
  response.set('Access-Control-Allow-Origin', '*');
  response.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  response.set('Access-Control-Allow-Headers', 'Content-Type');
  response.set('Vary', 'Origin');
  if (request.method === 'OPTIONS') {
    response.status(204).send('');
    return;
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.set('Allow', 'GET, HEAD, OPTIONS').status(405).send('Method not allowed');
    return;
  }
  const path = String(request.path ?? '').replace(/\/+$/, '');
  const match = path.match(/^\/public-paper-data\/([A-Za-z0-9_-]{1,260})$/);
  if (!match) {
    response.status(404).json({ error: 'Public paper not found.' });
    return;
  }
  try {
    const paperId = getPublicPaperIdFromPathSegment(match[1]);
    if (!paperId) {
      response.status(404).json({ error: 'Public paper not found.' });
      return;
    }
    const snapshot = await getDb().collection('questionPapers')
      .where(FieldPath.documentId(), '==', paperId)
      .select(...PUBLIC_PAPER_FIELDS)
      .limit(1)
      .get();
    const paper = snapshot.empty ? null : getPublicPaperPayload(snapshot.docs[0].data(), paperId, storage.bucket().name);
    if (!paper) {
      response.set('Cache-Control', 'public, max-age=60, s-maxage=300');
      response.status(404).json({ error: 'Public paper not found.' });
      return;
    }
    response.set('Cache-Control', 'public, max-age=60, s-maxage=300');
    response.set('X-Content-Type-Options', 'nosniff');
    if (request.method === 'HEAD') response.status(200).end();
    else response.status(200).json(paper);
  } catch (error) {
    logger.error('Public paper data request failed', { code: String(error?.code || error?.name || 'paper_data_error') });
    response.set('Cache-Control', 'no-store');
    response.status(503).json({ error: 'Public paper information is temporarily unavailable.' });
  }
});

export const servePublicPaperCatalogData = onRequest(PUBLIC_FUNCTION_OPTIONS, async (request, response) => {
  response.set('Access-Control-Allow-Origin', '*');
  response.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  response.set('Access-Control-Allow-Headers', 'Content-Type');
  response.set('Vary', 'Origin');
  if (request.method === 'OPTIONS') {
    response.status(204).send('');
    return;
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.set('Allow', 'GET, HEAD, OPTIONS').status(405).send('Method not allowed');
    return;
  }
  const pageSize = 500;
  const cursor = String(request.query?.cursor ?? '');
  if (cursor && !/^[A-Za-z0-9_-]{1,150}$/.test(cursor)) {
    response.status(400).json({ error: 'Invalid catalog cursor.' });
    return;
  }
  try {
    const bucketName = storage.bucket().name;
    let query = getDb().collection('questionPapers')
      .select(...PUBLIC_PAPER_FIELDS)
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    const papers = snapshot.docs.flatMap((document) => {
      const paper = getPublicPaperPayload(document.data(), document.id, bucketName);
      if (!paper) return [];
      const createdAt = document.get('createdAt');
      return [{
        ...paper,
        createdAt: createdAt?.toDate?.()?.toISOString?.() || '',
      }];
    });
    const nextCursor = snapshot.size === pageSize ? snapshot.docs.at(-1).id : null;
    response.set('Cache-Control', 'public, max-age=60, s-maxage=300');
    response.set('X-Content-Type-Options', 'nosniff');
    if (request.method === 'HEAD') response.status(200).end();
    else response.status(200).json({ papers, nextCursor });
  } catch (error) {
    logger.error('Public paper catalog data request failed', { code: String(error?.code || error?.name || 'catalog_data_error') });
    response.set('Cache-Control', 'no-store');
    response.status(503).json({ error: 'Public paper catalog is temporarily unavailable.' });
  }
});

const seoErrorHtml = ({ title, description, origin = PUBLIC_SEARCH_ORIGIN, robots = 'noindex,follow', canonical = `${origin}/papers` }) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="${description}"><meta name="robots" content="${robots}"><link rel="canonical" href="${canonical}"></head><body><main><h1>${title}</h1><p>${description}</p><a href="/papers">Browse past papers</a></main></body></html>`;

export const servePublicPaperSeo = onRequest(PUBLIC_FUNCTION_OPTIONS, async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.set('Allow', 'GET, HEAD').status(405).send('Method not allowed');
    return;
  }
  const path = String(request.path ?? '').replace(/\/+$/, '') || '/';
  const origin = getRequestPublicOrigin(request);
  if (!origin) {
    response.set('X-Robots-Tag', 'noindex').status(404).type('text/html').send(seoErrorHtml({
      title: 'Page not found | Examifying',
      description: 'This public Examifying page is not available.',
    }));
    return;
  }
  try {
    const shell = await getApplicationShell();
    if (path === '/papers') {
      const papers = await getCachedPublicQuestionPapers({ maxCount: MAX_CATALOG_LINKS, origin });
      const seo = {
        title: 'South African Past Exam Papers | Examifying',
        description: 'Browse public South African past examination question papers by subject, grade, year, month, province or region, and paper number. Check whether each paper has a memo.',
        subject: 'South African past exam papers',
        grade: '',
        year: '',
        url: `${origin}/papers`,
        robots: 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1',
        ogType: 'website',
      };
      const html = renderPublicSeoHtml({
        shell,
        seo,
        structuredData: buildPublicPaperCatalogStructuredData(papers, origin),
        content: renderPublicPaperCatalogContent(papers),
      });
      setPublicResponseHeaders(response, 'text/html; charset=utf-8');
      response.set('X-Robots-Tag', seo.robots);
      response.status(200).send(request.method === 'HEAD' ? '' : html);
      return;
    }

    const match = path.match(/^\/papers\/([A-Za-z0-9_-]{1,260})$/);
    if (!match) {
      response.set('X-Robots-Tag', 'noindex,follow');
      response.status(404).type('text/html').send(seoErrorHtml({
        title: 'Past paper not found | Examifying',
        description: 'This public past-paper page is not available.',
        origin,
      }));
      return;
    }
    const paperId = getPublicPaperIdFromPathSegment(match[1]);
    if (!paperId) {
      response.set('X-Robots-Tag', 'noindex,follow');
      response.status(404).type('text/html').send(seoErrorHtml({
        title: 'Past paper not found | Examifying',
        description: 'This public past-paper page is not available.',
        origin,
      }));
      return;
    }
    const snapshot = await getDb().collection('questionPapers')
      .where(FieldPath.documentId(), '==', paperId)
      .select(...PUBLIC_PAPER_FIELDS)
      .limit(1)
      .get();
    const data = snapshot.empty ? null : snapshot.docs[0].data();
    const seo = getPublicPaperSeo(data, paperId, origin, storage.bucket().name);
    if (!seo) {
      response.set('X-Robots-Tag', 'noindex,follow');
      response.status(404).type('text/html').send(seoErrorHtml({
        title: 'Past paper not found | Examifying',
        description: 'This public past-paper page is not available.',
        origin,
      }));
      return;
    }

    const html = renderPublicSeoHtml({
      shell,
      seo,
      structuredData: buildPublicPaperStructuredData(seo, origin),
      content: renderPublicPaperContent(seo),
    });
    setPublicResponseHeaders(response, 'text/html; charset=utf-8');
    response.set('X-Robots-Tag', seo.robots);
    response.status(200).send(request.method === 'HEAD' ? '' : html);
  } catch (error) {
    logger.error('Public paper SEO page failed', {
      route: path === '/papers' ? 'catalog' : 'paper-detail',
      code: String(error?.code || error?.name || 'public_page_error'),
    });
    response.status(503).type('text/html').send(seoErrorHtml({
      title: 'Past papers | Examifying',
      description: 'Public past-paper information is temporarily unavailable. Please try again shortly.',
      origin: origin || PUBLIC_SEARCH_ORIGIN,
      robots: 'noindex,follow',
    }));
  }
});

export const resetPublicSeoShellCacheForTests = () => {
  shellPromise = null;
  publicPaperListCache.clear();
};
