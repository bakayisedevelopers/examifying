import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_SEARCH_ORIGIN,
  buildPublicPaperSitemapXml,
  buildPublicPaperStructuredData,
  buildPublicSitemapIndexXml,
  buildPublicSitemapXml,
  getPublicPaperPayload,
  getPublicPaperSeo,
  getPublicSeoOriginForHost,
  getStorageObjectDetails,
  isPublicQuestionPaperRecord,
  renderPublicPaperCatalogContent,
  renderPublicPaperContent,
  renderPublicSeoHtml,
} from './publicSeoCore.js';

const bucket = 'examifying.firebasestorage.app';
const storageUrl = (path) => `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=public-token`;
const examplePaper = {
  subject: 'Life Sciences',
  grade: 'Grade 10',
  year: 2025,
  month: 'June',
  region: 'Cape Learning Centre',
  paperNumber: '1',
  paperUrl: storageUrl('questionPapers/public/life-sciences-paper.pdf'),
  memoUrl: storageUrl('questionPapers/public/life-sciences-memo.pdf'),
  analysisStatus: 'private-analysis-metadata',
  sourceFolder: 'private-import-folder',
};

test('public paper record requires a questionPapers object in the configured bucket', () => {
  assert.equal(isPublicQuestionPaperRecord(examplePaper, bucket), true);
  assert.equal(isPublicQuestionPaperRecord({ ...examplePaper, paperUrl: 'https://example.com/questionPapers/paper.pdf' }, bucket), false);
  assert.equal(isPublicQuestionPaperRecord({ ...examplePaper, paperUrl: storageUrl('users/student/private.pdf') }, bucket), false);
  assert.equal(isPublicQuestionPaperRecord(examplePaper, 'another-bucket'), false);
  assert.equal(isPublicQuestionPaperRecord({ ...examplePaper, status: 'deleted' }, bucket), false);
  assert.equal(isPublicQuestionPaperRecord({ ...examplePaper, visibility: 'private' }, bucket), false);
});

test('storage URL parsing decodes object names and rejects malformed/non-HTTPS values', () => {
  assert.deepEqual(getStorageObjectDetails(examplePaper.paperUrl), {
    bucket,
    path: 'questionPapers/public/life-sciences-paper.pdf',
  });
  assert.equal(getStorageObjectDetails('http://firebasestorage.googleapis.com/a'), null);
  assert.equal(getStorageObjectDetails('not a URL'), null);
});

test('public SEO accepts the four portal hosts and rejects admin or unrecognized hosts', () => {
  assert.equal(getPublicSeoOriginForHost('examifying.bakayise.com'), PUBLIC_SEARCH_ORIGIN);
  assert.equal(getPublicSeoOriginForHost('parents.examifying.bakayise.com'), 'https://parents.examifying.bakayise.com');
  assert.equal(getPublicSeoOriginForHost('tutors.examifying.bakayise.com'), 'https://tutors.examifying.bakayise.com');
  assert.equal(getPublicSeoOriginForHost('teachers.examifying.bakayise.com'), 'https://teachers.examifying.bakayise.com');
  assert.equal(getPublicSeoOriginForHost('parents.examifying.bakayise.com:443'), 'https://parents.examifying.bakayise.com');
  assert.equal(getPublicSeoOriginForHost('parents.examifying.bakayise.com, proxy.internal'), 'https://parents.examifying.bakayise.com');
  assert.equal(getPublicSeoOriginForHost('admin.examifying.bakayise.com'), null);
  assert.equal(getPublicSeoOriginForHost('attacker.example'), null);
});

test('public paper SEO uses arbitrary region text and exposes only display metadata', () => {
  const seo = getPublicPaperSeo(examplePaper, 'paper-1', PUBLIC_SEARCH_ORIGIN, bucket);
  assert.match(seo.title, /Cape Learning Centre/);
  assert.match(seo.description, /A memorandum is available/);
  assert.equal(seo.url, `${PUBLIC_SEARCH_ORIGIN}/papers/paper-1`);
  const payload = getPublicPaperPayload(examplePaper, 'paper-1', bucket);
  assert.deepEqual(Object.keys(payload).sort(), [
    'displayName', 'grade', 'id', 'memoAvailable', 'memoUrl', 'month', 'paperNumber', 'paperUrl', 'region', 'subject', 'year',
  ].sort());
  assert.equal('analysisStatus' in payload, false);
  assert.equal('sourceFolder' in payload, false);
});

test('public page HTML contains canonical metadata, escaped content, and valid structured data', () => {
  const seo = getPublicPaperSeo({ ...examplePaper, subject: '<script>alert(1)</script>' }, 'paper-2', PUBLIC_SEARCH_ORIGIN, bucket);
  const structuredData = buildPublicPaperStructuredData(seo);
  const html = renderPublicSeoHtml({
    shell: '<html><head><title>old</title><meta name="description"><meta name="robots"><meta property="og:title"><link rel="canonical" href="old"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
    seo,
    structuredData,
    content: renderPublicPaperContent(seo),
  });
  assert.match(html, /<link rel="canonical" href="https:\/\/examifying\.bakayise\.com\/papers\/paper-2"/);
  assert.match(html, /<meta name="robots" content="index,follow/);
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<h1><script>/);
  const encodedJsonLd = html.match(/<script id="seo-structured-data" type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
  const parsedJsonLd = JSON.parse(encodedJsonLd.replaceAll('\\u003c', '<'));
  assert.equal(parsedJsonLd['@graph'][1]['@type'], 'LearningResource');
  assert.equal(parsedJsonLd['@graph'][2]['@type'], 'BreadcrumbList');
});

test('catalog has crawlable paper links and dynamic sitemap outputs include only provided public pages', () => {
  const seo = getPublicPaperSeo(examplePaper, 'paper-3', PUBLIC_SEARCH_ORIGIN, bucket);
  const catalog = renderPublicPaperCatalogContent([{ id: 'paper-3', seo }]);
  assert.match(catalog, /href="https:\/\/examifying\.bakayise\.com\/papers\/paper-3"/);
  const sitemapIndex = buildPublicSitemapIndexXml(20_001, 20_000);
  assert.match(sitemapIndex, /sitemap-papers-2\.xml/);
  const sitemap = buildPublicSitemapXml([{ id: 'paper-3', seo }], new Date('2026-10-14T00:00:00Z'));
  assert.match(sitemap, /<loc>https:\/\/examifying\.bakayise\.com\/papers\/paper-3<\/loc>/);
  assert.doesNotMatch(sitemap, /private-analysis-metadata|public-token/);
  const shard = buildPublicPaperSitemapXml([{ id: 'paper-3', seo }]);
  assert.match(shard, /<url>/);
  assert.doesNotMatch(shard, /public-token/);
});

test('portal paper URLs, schema and sitemap entries use the requested public host', () => {
  const parentOrigin = 'https://parents.examifying.bakayise.com';
  const seo = getPublicPaperSeo(examplePaper, 'paper-parent', parentOrigin, bucket);
  const schema = buildPublicPaperStructuredData(seo, parentOrigin);
  assert.equal(seo.url, `${parentOrigin}/papers/paper-parent`);
  assert.equal(schema['@graph'][0].url, `${parentOrigin}/`);
  assert.equal(schema['@graph'][2].itemListElement[1].item, `${parentOrigin}/papers`);
  const sitemap = buildPublicSitemapXml([{ id: 'paper-parent', seo }], new Date('2026-10-14T00:00:00Z'), parentOrigin);
  assert.match(sitemap, /https:\/\/parents\.examifying\.bakayise\.com\/papers\/paper-parent/);
  assert.match(buildPublicSitemapIndexXml(1, 20_000, parentOrigin), /https:\/\/parents\.examifying\.bakayise\.com\/sitemap-core\.xml/);
});
