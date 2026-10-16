const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
