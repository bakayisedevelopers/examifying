import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  SEARCH_CONSOLE_INSPECTION_ENDPOINT,
  SEARCH_CONSOLE_SITE,
  SEARCH_CONSOLE_SITEMAP,
  buildServiceAccountAssertion,
  buildSitemapSubmissionUrl,
  buildUrlInspectionRequest,
} from './search-console-core.mjs';

const tokenUrl = 'https://oauth2.googleapis.com/token';

const readServiceAccountCredentials = async () => {
  const credentialsPath = process.env.GSC_SERVICE_ACCOUNT_KEY_FILE;
  if (!credentialsPath) {
    throw new Error('Set GSC_SERVICE_ACCOUNT_KEY_FILE to a service-account JSON key path.');
  }
  let credentials;
  try {
    credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
  } catch {
    throw new Error('Could not read valid service-account JSON from GSC_SERVICE_ACCOUNT_KEY_FILE.');
  }
  return credentials;
};

const getAccessToken = async (credentials) => {
  const assertion = buildServiceAccountAssertion({ credentials });
  const response = await fetch(credentials.token_uri || tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.access_token !== 'string') {
    throw new Error(`Google OAuth token request failed (HTTP ${response.status}).`);
  }
  return result.access_token;
};

const requestGoogleApi = async ({ url, method = 'GET', accessToken, body }) => {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = result?.error?.message;
    throw new Error(`Search Console API request failed (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`);
  }
  return result;
};

export const runSearchConsoleCommand = async (args = process.argv.slice(2)) => {
  const [command, value] = args;

  if (command === 'help' || !command) {
    process.stdout.write([
      'Usage:',
      '  node scripts/search-console.mjs submit-sitemap [sitemap-url]',
      '  node scripts/search-console.mjs inspect-url <https://PUBLIC_PORTAL_HOST/path>',
      'Public portal hosts: examifying.bakayise.com, parents.examifying.bakayise.com, tutors.examifying.bakayise.com, teachers.examifying.bakayise.com.',
    ].join('\n') + '\n');
    return;
  }

  if (command === 'submit-sitemap') {
    const credentials = await readServiceAccountCredentials();
    const accessToken = await getAccessToken(credentials);
    const sitemapUrl = value || SEARCH_CONSOLE_SITEMAP;
    const url = buildSitemapSubmissionUrl({ sitemapUrl });
    await requestGoogleApi({ url, method: 'PUT', accessToken });
    process.stdout.write(`Submitted sitemap to Search Console: ${sitemapUrl}\n`);
    return;
  }

  if (command === 'inspect-url' && value) {
    const request = buildUrlInspectionRequest({ inspectionUrl: value });
    const credentials = await readServiceAccountCredentials();
    const accessToken = await getAccessToken(credentials);
    const result = await requestGoogleApi({
      url: SEARCH_CONSOLE_INSPECTION_ENDPOINT,
      method: 'POST',
      accessToken,
      body: request.body,
    });
    const inspection = result.inspectionResult ?? {};
    const indexStatus = inspection.indexStatusResult ?? {};
    process.stdout.write(`${JSON.stringify({
      inspectedUrl: value,
      verdict: indexStatus.verdict,
      coverageState: indexStatus.coverageState,
      indexingState: indexStatus.indexingState,
      robotsTxtState: indexStatus.robotsTxtState,
      pageFetchState: indexStatus.pageFetchState,
      lastCrawlTime: indexStatus.lastCrawlTime,
      googleCanonical: indexStatus.googleCanonical,
      userCanonical: indexStatus.userCanonical,
    }, null, 2)}\n`);
    return;
  }

  throw new Error('Use submit-sitemap or inspect-url.');
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSearchConsoleCommand().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export const SEARCH_CONSOLE_DEFAULTS = Object.freeze({ site: SEARCH_CONSOLE_SITE, sitemap: SEARCH_CONSOLE_SITEMAP });
