import { createHash } from 'node:crypto';

export const GEMINI_CONTEXT_CACHE_TTL_SECONDS = 300;

const MAX_LOCAL_CACHE_ENTRIES = 64;
const NEGATIVE_CACHE_MS = 60_000;
const localCache = new Map();

const cacheKeyFor = ({ model, submissionType, systemInstruction, sourceParts }) => {
  const digest = createHash('sha256')
    .update(String(model))
    .update('\0')
    .update(String(submissionType))
    .update('\0')
    .update(String(systemInstruction));
  sourceParts.forEach((part) => {
    if (part?.text) digest.update('\0text\0').update(String(part.text));
    const image = part?.inline_data;
    if (image) digest.update('\0image\0').update(String(image.mime_type)).update('\0').update(String(image.data));
  });
  return digest.digest('hex');
};

const trimLocalCache = () => {
  if (localCache.size <= MAX_LOCAL_CACHE_ENTRIES) return;
  const candidates = [...localCache.entries()]
    .filter(([, entry]) => !entry.promise)
    .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
  while (localCache.size > MAX_LOCAL_CACHE_ENTRIES && candidates.length) {
    localCache.delete(candidates.shift()[0]);
  }
};

/**
 * Creates/reuses a short-lived provider-side cache for shared source-paper pages.
 * Answer images are intentionally not accepted by this helper.
 */
export const getGeminiSourceContextCache = async ({
  fetchImpl,
  apiKey,
  baseUrl,
  model,
  submissionType,
  systemInstruction,
  sourceParts,
  now = Date.now(),
}) => {
  if (!Array.isArray(sourceParts) || !sourceParts.some((part) => part?.inline_data)) {
    return { cacheName: '', cacheStatus: 'none', cacheWriteTokens: 0, cacheKey: '' };
  }

  const cacheKey = cacheKeyFor({ model, submissionType, systemInstruction, sourceParts });
  const existing = localCache.get(cacheKey);
  if (existing?.promise) {
    const result = await existing.promise;
    existing.lastUsedAt = Date.now();
    return { ...result, cacheStatus: result.cacheName ? 'hit_after_wait' : 'unavailable', cacheKey };
  }
  if (existing?.cacheName && existing.expiresAt > now + 5_000) {
    existing.lastUsedAt = now;
    return { cacheName: existing.cacheName, cacheStatus: 'hit', cacheWriteTokens: 0, cacheKey };
  }
  if (existing?.negativeUntil > now) {
    existing.lastUsedAt = now;
    return { cacheName: '', cacheStatus: 'bypassed_after_cache_error', cacheWriteTokens: 0, cacheKey };
  }

  localCache.delete(cacheKey);
  const entry = { promise: null, lastUsedAt: now };
  const createPromise = (async () => {
    try {
      const response = await fetchImpl(`${baseUrl}/cachedContents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(240_000),
        body: JSON.stringify({
          model: `models/${model}`,
          displayName: `examifying-marking-${cacheKey.slice(0, 16)}`,
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: 'user', parts: sourceParts }],
          ttl: `${GEMINI_CONTEXT_CACHE_TTL_SECONDS}s`,
        }),
      });
      const data = await response.json().catch(() => ({}));
      const name = String(data?.name ?? '').trim();
      if (!response.ok || !name) {
        return { cacheName: '', cacheWriteTokens: 0, errorCode: String(data?.error?.status || `http_${response.status}`).toLowerCase() };
      }
      const expiresAt = Date.parse(data?.expireTime) || Date.now() + GEMINI_CONTEXT_CACHE_TTL_SECONDS * 1000;
      const result = {
        cacheName: name,
        cacheWriteTokens: Number(data?.usageMetadata?.totalTokenCount || data?.usageMetadata?.promptTokenCount) || 0,
        expiresAt,
      };
      localCache.set(cacheKey, { ...result, lastUsedAt: Date.now() });
      trimLocalCache();
      return result;
    } catch (error) {
      return { cacheName: '', cacheWriteTokens: 0, errorCode: String(error?.code || 'cache_request_failed') };
    }
  })();
  entry.promise = createPromise;
  localCache.set(cacheKey, entry);
  trimLocalCache();
  const result = await createPromise;
  if (result.cacheName) {
    const saved = localCache.get(cacheKey);
    if (saved) saved.promise = null;
    return { ...result, cacheStatus: 'created', cacheKey };
  }

  localCache.set(cacheKey, { negativeUntil: Date.now() + NEGATIVE_CACHE_MS, lastUsedAt: Date.now() });
  trimLocalCache();
  return { cacheName: '', cacheStatus: 'unavailable', cacheWriteTokens: 0, cacheKey, errorCode: result.errorCode };
};

export const invalidateGeminiSourceContextCache = (cacheKey) => {
  if (cacheKey) localCache.delete(cacheKey);
};

export const resetGeminiContextCacheForTests = () => localCache.clear();
