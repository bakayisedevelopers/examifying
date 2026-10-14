const safeCode = (error) => String(error?.code || error?.name || 'provider_error')
  .replace(/[^a-zA-Z0-9_-]/g, '_')
  .slice(0, 80);

export const callMarkingWithFallback = async ({
  request,
  callPrimary,
  callFallback,
  validateResponse,
  onPrimaryFailure,
}) => {
  let primaryError;
  try {
    const response = await callPrimary(request);
    validateResponse?.(response);
    return { ...response, provider: 'openai', fallbackUsed: false, fallbackReasonCode: '' };
  } catch (error) {
    primaryError = error;
    onPrimaryFailure?.(error);
  }

  try {
    const response = await callFallback(request);
    validateResponse?.(response);
    return {
      ...response,
      provider: 'gemini',
      fallbackUsed: true,
      fallbackReasonCode: safeCode(primaryError),
    };
  } catch (fallbackError) {
    const error = new Error(fallbackError?.message || 'Both AI marking providers failed.', { cause: fallbackError });
    error.code = 'gemini_fallback_failed';
    error.primaryErrorCode = safeCode(primaryError);
    error.fallbackErrorCode = safeCode(fallbackError);
    throw error;
  }
};
