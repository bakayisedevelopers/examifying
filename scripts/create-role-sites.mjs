import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildStructuredData, getRouteSeo, PORTAL_SEO } from '../src/config/seo.js';
import { getPortalSiteUrl } from '../src/utils/portal.js';

const rootDirectory = process.cwd();
const buildDirectory = resolve(rootDirectory, 'dist');
const hostingDirectory = resolve(rootDirectory, 'dist-sites');
const portals = ['student', 'tutor', 'teacher', 'parent', 'admin'];
const googleSiteVerification = '<meta name="google-site-verification" content="3tze_yj1w1JxsI3INjvBjITm0Aicss1GhGZGMrrph9M" />';

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

const setMetaContent = (html, name, content) => {
  const marker = new RegExp(`<meta\\b(?=[^>]*name=["']${name}["'])[^>]*>`, 'i');
  const escaped = escapeHtml(content);
  return html.replace(marker, (tag) => tag.replace(/\bcontent=(["'])[^"']*\1/i, `content="${escaped}"`));
};

const portalHomeFallback = (portal, seo) => {
  const portalSpecificCopy = {
    student: 'Explore daily study support, public past examination papers, and learning tools for South African students.',
    parent: 'Follow your children’s learning and find public past examination papers for home study.',
    tutor: 'Support learners with tutor tools, progress information, lessons, and public past examination papers.',
    teacher: 'Support classroom learning with progress tools, lessons, and public past examination papers.',
    admin: 'Authorised Examifying administrators can sign in to the secure administration workspace.',
  }[portal];
  return `<main class="mx-auto max-w-6xl px-5 py-12 text-slate-100"><h1 class="text-4xl font-bold">${escapeHtml(seo.title)}</h1><p class="mt-4 max-w-3xl text-lg leading-8 text-slate-300">${escapeHtml(seo.description)}</p><p class="mt-4 max-w-3xl leading-7 text-slate-300">${escapeHtml(portalSpecificCopy)}</p>${portal === 'admin' ? '' : '<p class="mt-6"><a class="font-semibold text-lime-300 underline" href="/papers">Browse public past exam papers</a></p>'}</main>`;
};

const setRootContent = (html, markup) => html.replace(/<div\s+id=["']root["']\s*>\s*<\/div>/i, `<div id="root">${markup}</div>`);

const setRouteMetadata = (html, seo) => {
  let result = html
    .replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(seo.title)}</title>`)
    .replaceAll('__SEO_TITLE__', escapeHtml(seo.title))
    .replaceAll('__SEO_DESCRIPTION__', escapeHtml(seo.description))
    .replaceAll('__SEO_KEYWORDS__', escapeHtml(seo.keywords || 'Examifying'))
    .replaceAll('__SEO_URL__', escapeHtml(seo.url || ''))
    .replaceAll('__SEO_ROBOTS__', escapeHtml(seo.robots || 'index,follow'))
    .replace(/<script id="seo-structured-data" type="application\/ld\+json">__SEO_STRUCTURED_DATA__<\/script>/i,
      seo.structuredData ? `<script id="seo-structured-data" type="application/ld+json">${JSON.stringify(seo.structuredData).replaceAll('<', '\\u003c')}</script>` : '');
  result = setMetaContent(result, 'description', seo.description);
  result = setMetaContent(result, 'robots', seo.robots || 'index,follow');
  if (!seo.indexable) result = result.replace(/\s*<link rel="canonical" href="[^"]*"\s*\/?\s*>/i, '');
  else result = result.replace(/<link rel="canonical" href="[^"]*"\s*\/?\s*>/i, `<link rel="canonical" href="${escapeHtml(seo.url)}" />`);
  return result;
};

for (const portal of portals) {
  const siteDirectory = resolve(hostingDirectory, portal);
  const origin = getPortalSiteUrl(portal).replace(/\/$/, '');
  const landingSeo = getRouteSeo('/', portal);

  await rm(siteDirectory, { recursive: true, force: true });
  await mkdir(siteDirectory, { recursive: true });
  await cp(buildDirectory, siteDirectory, { recursive: true });

  let html = await readFile(resolve(siteDirectory, 'index.html'), 'utf8');
  html = html.replaceAll('__SEO_ORIGIN__', escapeHtml(origin));
  const homeSeo = {
    ...landingSeo,
    keywords: PORTAL_SEO[portal].keywords,
    structuredData: buildStructuredData(portal, '/'),
  };
  html = setRouteMetadata(html, homeSeo);

  if (portal !== 'admin') {
    html = html.replace('</head>', `    ${googleSiteVerification}\n  </head>`);
  }

  const rootHtml = setRootContent(html, portalHomeFallback(portal, landingSeo));
  await writeFile(resolve(siteDirectory, 'index.html'), rootHtml);

  const appHtml = setRouteMetadata(setRootContent(html, ''), {
    title: `${PORTAL_SEO[portal].title.split('|')[0].trim()} Private Workspace`,
    description: 'Private Examifying account workspace.',
    robots: 'noindex,nofollow',
    indexable: false,
  }).replace(/<script id="seo-structured-data" type="application\/ld\+json">[\s\S]*?<\/script>/i, '');
  await writeFile(resolve(siteDirectory, 'app.html'), appHtml);

  const policySeo = getRouteSeo('/policies', portal);
  const policiesFallback = '<main class="mx-auto max-w-4xl px-5 py-12 text-slate-100"><nav><a href="/">Home</a> / Policies</nav><h1 class="mt-5 text-3xl font-bold">Examifying policies</h1><p class="mt-4 leading-7 text-slate-300">Read the current Examifying terms of use, privacy policy, payment and refund terms, and contact information.</p></main>';
  const policiesHtml = setRootContent(setRouteMetadata(html, {
    ...policySeo,
    keywords: 'Examifying terms of use, privacy policy, refunds, contact',
    structuredData: buildStructuredData(portal, '/policies'),
  }), policiesFallback);
  await writeFile(resolve(siteDirectory, 'policies.html'), policiesHtml);

  await rm(resolve(siteDirectory, 'sitemap.xml'), { force: true });

  const disallowedPaths = portal === 'admin'
    ? ['Disallow: /']
    : [
      'Disallow: /login', 'Disallow: /signup',
      'Disallow: /student', 'Disallow: /student/',
      'Disallow: /parent', 'Disallow: /parent/',
      'Disallow: /tutor', 'Disallow: /tutor/',
      'Disallow: /teacher', 'Disallow: /teacher/',
      'Disallow: /admin', 'Disallow: /admin/',
    ];
  const sitemapDirective = portal === 'admin' ? '' : `Sitemap: ${origin}/sitemap.xml\n`;
  await writeFile(resolve(siteDirectory, 'robots.txt'), `User-agent: *\n${portal === 'admin' ? '' : 'Allow: /\n'}${disallowedPaths.join('\n')}\n${sitemapDirective}`);
}
