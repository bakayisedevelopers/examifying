const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 320;

export const safePeerWorkErrorMessage = (error) => {
  const messages = [];
  let current = error;
  for (let depth = 0; current && depth < 3; depth += 1) {
    const message = String(current.message ?? '').trim();
    if (message && !messages.includes(message)) messages.push(message);
    current = current.cause;
  }

  const diagnostic = (messages.join(' | ') || 'Unknown peer-work error')
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, '[encoded-data-redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[-_ ]?key|x-goog-api-key|access[-_ ]?token|refresh[-_ ]?token|token|secret|authorization)\b(?:\s+provided)?\s*(?:is\s*)?[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(?:sk-(?:proj-)?|AIza|ya29\.)[A-Za-z0-9._-]{12,}/gi, '[credential-redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\b[A-Za-z0-9+/]{160,}={0,2}\b/g, '[long-value-redacted]');

  return diagnostic.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
};
