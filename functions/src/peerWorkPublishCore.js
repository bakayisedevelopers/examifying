import { questionIdentity } from './aiMarkingCore.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const packQuestionIdentity = (row = {}, fallbackPaperId = '') => {
  const storedId = String(row.questionId ?? '').trim();
  if (storedId) return storedId;
  const paperId = String(row.paperId ?? fallbackPaperId ?? '').trim();
  const questionReference = String(row.questionReference ?? row.questionNumber ?? '').trim();
  return paperId && questionReference ? questionIdentity(paperId, questionReference) : '';
};

export const selectSystemPeerWorkImages = ({ pack = {}, questionLinks = [] } = {}) => {
  const imagesByQuestionId = new Map();
  (Array.isArray(pack.images) ? pack.images : []).forEach((image) => {
    const questionId = packQuestionIdentity(image, pack.paperId);
    if (questionId && !imagesByQuestionId.has(questionId)) imagesByQuestionId.set(questionId, image);
  });
  const selected = questionLinks.map((link) => imagesByQuestionId.get(packQuestionIdentity(link, pack.paperId)));
  // Older single-question packs can lack stable question metadata on one side.
  // Their one-to-one order is still unambiguous, so retain the sole saved image.
  if (selected.length === 1 && !selected[0] && pack.images?.length === 1) return [pack.images[0]];
  if (!questionLinks.length || selected.some((image) => !image)) {
    throw new Error('The saved practice work is missing a question image.');
  }
  return selected;
};

export const loadReadyPeerWorkPack = async (pack) => {
  if (!pack?.ref || typeof pack.ref.get !== 'function') {
    throw new Error('The generated peer-work record could not be reloaded before publication.');
  }
  const snapshot = await pack.ref.get();
  if (!snapshot.exists) throw new Error('The saved practice work is unavailable for publication.');
  const latestPack = { ...pack, ...snapshot.data() };
  if (latestPack.status !== 'ready' || !Array.isArray(latestPack.images)) {
    throw new Error('The saved practice work is not ready for publication.');
  }
  return latestPack;
};

export const publishPeerWorkWithRetry = async ({
  publish,
  maxAttempts = 3,
  retryDelayMs = 250,
  delay = wait,
  onRetry = () => {},
}) => {
  const attempts = Math.max(1, Math.floor(Number(maxAttempts) || 1));
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await publish();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      onRetry(error, attempt);
      await delay(retryDelayMs * (2 ** (attempt - 1)));
    }
  }

  throw lastError;
};
