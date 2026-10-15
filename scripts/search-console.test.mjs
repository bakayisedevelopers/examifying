import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import {
  SEARCH_CONSOLE_INSPECTION_ENDPOINT,
  SEARCH_CONSOLE_SCOPE,
  SEARCH_CONSOLE_SITE,
  SEARCH_CONSOLE_SITEMAP,
  SEARCH_CONSOLE_SITES,
  buildServiceAccountAssertion,
  buildSitemapSubmissionUrl,
  buildUrlInspectionRequest,
} from './search-console-core.mjs';

test('service account assertion is signed and scoped only for Search Console APIs', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentials = {
    client_email: 'seo-service@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  const assertion = buildServiceAccountAssertion({ credentials, now: 1_800_000_000_000 });
  const [header, claims, signature] = assertion.split('.');
  const validSignature = verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'));
  assert.equal(validSignature, true);
  const parsedClaims = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
  assert.equal(parsedClaims.iss, credentials.client_email);
  assert.equal(parsedClaims.scope, SEARCH_CONSOLE_SCOPE);
  assert.equal(parsedClaims.aud, credentials.token_uri);
  assert.equal(parsedClaims.exp - parsedClaims.iat, 3600);
});

test('sitemap submission uses the authorized Search Console sitemap endpoint and URL-prefix property', () => {
  const submissionUrl = buildSitemapSubmissionUrl();
  assert.ok(submissionUrl.startsWith('https://www.googleapis.com/webmasters/v3/sites/'));
  assert.ok(submissionUrl.includes(encodeURIComponent(SEARCH_CONSOLE_SITE)));
  assert.ok(submissionUrl.endsWith(encodeURIComponent(SEARCH_CONSOLE_SITEMAP)));
  assert.throws(() => buildSitemapSubmissionUrl({ sitemapUrl: 'https://other.example/sitemap.xml' }), /Submit only/);
  for (const siteUrl of Object.values(SEARCH_CONSOLE_SITES)) {
    const sitemapUrl = `${siteUrl}sitemap.xml`;
    const requestUrl = buildSitemapSubmissionUrl({ sitemapUrl });
    assert.ok(requestUrl.includes(encodeURIComponent(siteUrl)));
    assert.ok(requestUrl.endsWith(encodeURIComponent(sitemapUrl)));
  }
  assert.throws(() => buildSitemapSubmissionUrl({
    siteUrl: SEARCH_CONSOLE_SITE,
    sitemapUrl: `${SEARCH_CONSOLE_SITES.parent}sitemap.xml`,
  }), /host must match/);
  assert.throws(() => buildSitemapSubmissionUrl({ sitemapUrl: 'https://admin.examifying.bakayise.com/sitemap.xml' }), /Submit only/);
});

test('URL Inspection builds the indexed-version request and rejects other sites', () => {
  const inspection = buildUrlInspectionRequest({ inspectionUrl: `${SEARCH_CONSOLE_SITE}papers/example-paper` });
  assert.equal(inspection.url, SEARCH_CONSOLE_INSPECTION_ENDPOINT);
  assert.deepEqual(inspection.body, {
    inspectionUrl: `${SEARCH_CONSOLE_SITE}papers/example-paper`,
    siteUrl: SEARCH_CONSOLE_SITE,
    languageCode: 'en-ZA',
  });
  assert.throws(() => buildUrlInspectionRequest({ inspectionUrl: 'https://example.org/' }), /Inspect only/);
  assert.throws(() => buildUrlInspectionRequest({ inspectionUrl: 'http://examifying.bakayise.com/' }), /Inspect only/);
  const tutorInspection = buildUrlInspectionRequest({ inspectionUrl: 'https://tutors.examifying.bakayise.com/papers/example-paper' });
  assert.equal(tutorInspection.body.siteUrl, SEARCH_CONSOLE_SITES.tutor);
  assert.throws(() => buildUrlInspectionRequest({
    inspectionUrl: 'https://parents.examifying.bakayise.com/papers/example-paper',
    siteUrl: SEARCH_CONSOLE_SITE,
  }), /host must match/);
  assert.throws(() => buildUrlInspectionRequest({ inspectionUrl: 'https://admin.examifying.bakayise.com/' }), /Inspect only/);
});
