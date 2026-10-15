import { createSign } from 'node:crypto';

export const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters';
export const SEARCH_CONSOLE_SITES = Object.freeze({
  student: 'https://examifying.bakayise.com/',
  parent: 'https://parents.examifying.bakayise.com/',
  tutor: 'https://tutors.examifying.bakayise.com/',
  teacher: 'https://teachers.examifying.bakayise.com/',
});
export const SEARCH_CONSOLE_SITE = SEARCH_CONSOLE_SITES.student;
export const SEARCH_CONSOLE_SITEMAP = `${SEARCH_CONSOLE_SITE}sitemap.xml`;
const SEARCH_CONSOLE_HOSTS = new Map(Object.values(SEARCH_CONSOLE_SITES).map((siteUrl) => [new URL(siteUrl).hostname, siteUrl]));
export const SEARCH_CONSOLE_INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
export const SEARCH_CONSOLE_WEBMASTERS_API = 'https://www.googleapis.com/webmasters/v3';

const base64Url = (value) => Buffer.from(value).toString('base64url');

export const buildServiceAccountAssertion = ({ credentials, now = Date.now() }) => {
  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error('Service-account JSON must contain client_email and private_key.');
  }
  const issuedAt = Math.floor(now / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: SEARCH_CONSOLE_SCOPE,
    aud: credentials.token_uri || 'https://oauth2.googleapis.com/token',
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(credentials.private_key).toString('base64url')}`;
};

const getSiteForUrl = (parsedUrl) => SEARCH_CONSOLE_HOSTS.get(parsedUrl.hostname) || null;

export const buildSitemapSubmissionUrl = ({ siteUrl, sitemapUrl = SEARCH_CONSOLE_SITEMAP } = {}) => {
  const parsedSitemapUrl = new URL(sitemapUrl);
  const inferredSite = getSiteForUrl(parsedSitemapUrl);
  if (parsedSitemapUrl.protocol !== 'https:' || !inferredSite || parsedSitemapUrl.pathname !== '/sitemap.xml') {
    throw new Error('Submit only /sitemap.xml URLs hosted on a public Examifying site.');
  }
  if (siteUrl && siteUrl !== inferredSite) throw new Error('The sitemap host must match its Search Console property.');
  return `${SEARCH_CONSOLE_WEBMASTERS_API}/sites/${encodeURIComponent(siteUrl || inferredSite)}/sitemaps/${encodeURIComponent(parsedSitemapUrl.href)}`;
};

export const buildUrlInspectionRequest = ({ inspectionUrl, siteUrl, languageCode = 'en-ZA' }) => {
  const parsedUrl = new URL(inspectionUrl);
  const inferredSite = getSiteForUrl(parsedUrl);
  if (parsedUrl.protocol !== 'https:' || !inferredSite) {
    throw new Error('Inspect only https URLs hosted on a public Examifying site.');
  }
  if (siteUrl && siteUrl !== inferredSite) throw new Error('The inspected URL host must match its Search Console property.');
  return {
    url: SEARCH_CONSOLE_INSPECTION_ENDPOINT,
    body: { inspectionUrl: parsedUrl.href, siteUrl: siteUrl || inferredSite, languageCode },
  };
};
