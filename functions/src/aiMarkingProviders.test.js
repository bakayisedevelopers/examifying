import test from 'node:test';
import assert from 'node:assert/strict';
import { callMarkingWithFallback } from './aiMarkingProviders.js';

test('calls Gemini once after OpenAI fails and records the fallback reason', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  let validationCalls = 0;
  const result = await callMarkingWithFallback({
    request: { version: 'v1' },
    callPrimary: async () => {
      primaryCalls += 1;
      const error = new Error('no credits');
      error.code = 'credit_balance_exhausted';
      error.status = 429;
      throw error;
    },
    callFallback: async () => {
      fallbackCalls += 1;
      return { status: 'unclear_images', results: [], model: 'gemini-3.5-flash-lite' };
    },
    validateResponse: (response) => { validationCalls += 1; assert.equal(response.status, 'unclear_images'); },
  });
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(validationCalls, 1);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.fallbackReasonCode, 'credit_balance_exhausted');
});

test('does not call Gemini when OpenAI returns a valid result', async () => {
  let fallbackCalls = 0;
  const result = await callMarkingWithFallback({
    request: {},
    callPrimary: async () => ({ status: 'completed', results: [] }),
    callFallback: async () => { fallbackCalls += 1; return {}; },
    validateResponse: (response) => assert.equal(response.status, 'completed'),
  });
  assert.equal(fallbackCalls, 0);
  assert.equal(result.provider, 'openai');
  assert.equal(result.fallbackUsed, false);
});

test('falls back once when OpenAI output fails authoritative validation', async () => {
  let fallbackCalls = 0;
  const result = await callMarkingWithFallback({
    request: {},
    callPrimary: async () => ({ status: 'completed', results: [{ questionId: 'unknown', awardedMark: 1 }] }),
    callFallback: async () => {
      fallbackCalls += 1;
      return { status: 'unclear_images', results: [] };
    },
    validateResponse: (response) => {
      if (response.results[0]?.questionId === 'unknown') throw Object.assign(new Error('unknown question'), { code: 'invalid_ai_result' });
    },
  });
  assert.equal(fallbackCalls, 1);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.fallbackReasonCode, 'invalid_ai_result');
});

test('surfaces Gemini failure with bounded provider error codes', async () => {
  await assert.rejects(callMarkingWithFallback({
    request: {},
    callPrimary: async () => { throw Object.assign(new Error('OpenAI failed'), { code: 'rate_limit_exceeded' }); },
    callFallback: async () => { throw Object.assign(new Error('Gemini unavailable'), { code: 'http_503' }); },
  }), (error) => error.code === 'gemini_fallback_failed'
    && error.primaryErrorCode === 'rate_limit_exceeded'
    && error.fallbackErrorCode === 'http_503'
    && error.message === 'Gemini unavailable');
});
