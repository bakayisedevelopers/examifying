import { PUBLIC_SEARCH_ORIGIN } from '../config/seo';

const publicPaperRequests = new Map();
let publicCatalogRequest;

export const getPublicQuestionPaperById = (paperId) => {
  if (!paperId) return Promise.resolve(null);
  const cached = publicPaperRequests.get(paperId);
  if (cached?.expiresAt > Date.now()) return cached.promise;
  publicPaperRequests.delete(paperId);

  const request = fetch(`${PUBLIC_SEARCH_ORIGIN}/public-paper-data/${encodeURIComponent(paperId)}`, {
    headers: { Accept: 'application/json' },
  }).then(async (response) => {
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Public paper information could not be loaded.');
    return response.json();
  }).catch((error) => {
    publicPaperRequests.delete(paperId);
    throw error;
  });

  publicPaperRequests.set(paperId, { promise: request, expiresAt: Date.now() + 60_000 });
  return request;
};

export const getPublicQuestionPapers = () => {
  if (publicCatalogRequest?.expiresAt > Date.now()) return publicCatalogRequest.promise;
  let cursor = '';
  const seenCursors = new Set();
  const request = (async () => {
    const papers = [];
    do {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const response = await fetch(`${PUBLIC_SEARCH_ORIGIN}/public-paper-catalog${query}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Public past papers could not be loaded.');
      const page = await response.json();
      papers.push(...(Array.isArray(page.papers) ? page.papers : []));
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : '';
      if (cursor && seenCursors.has(cursor)) throw new Error('The public paper catalog returned a repeated page cursor.');
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return papers;
  })().catch((error) => {
    publicCatalogRequest = null;
    throw error;
  });
  publicCatalogRequest = { promise: request, expiresAt: Date.now() + 60_000 };
  return request;
};
