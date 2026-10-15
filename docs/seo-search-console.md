# Examifying SEO and Search Console

## Public search pages

The student, parent, tutor, and teacher sites each serve indexable HTML for `/`, `/papers`, and each public `/papers/{paperId}` route. The public paper catalog and details are rendered before the React bundle runs, with host-specific titles, descriptions, canonical URLs, Open Graph tags, and `CollectionPage` or `LearningResource`/breadcrumb JSON-LD. Each portal has its own dynamic sitemap index and paper URL shards, generated from the current public paper records.

All four sites use the same safe public paper allowlist. Public page and catalog data include only display metadata and public PDF/memo URLs; analysis, import, user, and submission data are not returned. The existing Firestore and Storage rules are unchanged. The admin site remains excluded from indexing, has no sitemap, and disallows crawling.

`robots.txt` allows the public home, policy, and past-paper routes while disallowing authentication and private role workspaces. The SPA fallback for workspace routes uses `app.html` with `noindex,nofollow`. The existing Google verification meta tag is retained on all four public portals.

## Google Search Console API setup

The local CLI supports these URL-prefix properties:

| Portal | Property | Sitemap |
| --- | --- | --- |
| Student | `https://examifying.bakayise.com/` | `https://examifying.bakayise.com/sitemap.xml` |
| Parent | `https://parents.examifying.bakayise.com/` | `https://parents.examifying.bakayise.com/sitemap.xml` |
| Tutor | `https://tutors.examifying.bakayise.com/` | `https://tutors.examifying.bakayise.com/sitemap.xml` |
| Teacher | `https://teachers.examifying.bakayise.com/` | `https://teachers.examifying.bakayise.com/sitemap.xml` |

1. Add/verify each URL-prefix property in Search Console. The existing verification meta tag is emitted in each site's generated HTML.
2. Enable the Search Console API in the Google Cloud project used by the service account.
3. Add the service-account email as an owner of each property it will access.
4. Store its JSON key outside this repository and set `GSC_SERVICE_ACCOUNT_KEY_FILE` to that file.
5. Submit each sitemap after deployment:

   ```sh
   node scripts/search-console.mjs submit-sitemap https://examifying.bakayise.com/sitemap.xml
   node scripts/search-console.mjs submit-sitemap https://parents.examifying.bakayise.com/sitemap.xml
   node scripts/search-console.mjs submit-sitemap https://tutors.examifying.bakayise.com/sitemap.xml
   node scripts/search-console.mjs submit-sitemap https://teachers.examifying.bakayise.com/sitemap.xml
   ```

6. Inspect a page on any supported portal:

   ```sh
   node scripts/search-console.mjs inspect-url https://parents.examifying.bakayise.com/papers/PUBLIC_PAPER_ID
   ```

The sitemap command uses Google's Search Console sitemap submission endpoint. URL inspection reports the indexed-version status; it does not request indexing or run a live URL test. The integration does not call Google's restricted Indexing API.

## Request indexing manually

In Search Console, select the matching portal property, enter its `/`, `/papers`, or public paper URL in **URL inspection**, then choose **Request indexing** if appropriate. Submit each portal's sitemap once after deployment. Google controls crawl and indexing timing; sitemap submission and indexing requests do not guarantee inclusion.

Examifying past-paper pages are not eligible for Google's restricted Indexing API, which is intended for qualifying job posting and livestream pages. This implementation does not use that API.
