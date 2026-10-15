const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
