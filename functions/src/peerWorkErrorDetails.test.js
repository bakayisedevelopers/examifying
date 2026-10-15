import test from 'node:test';
import assert from 'node:assert/strict';
import { safePeerWorkErrorMessage } from './peerWorkErrorDetails.js';

test('safePeerWorkErrorMessage preserves useful diagnostic text while redacting credentials and URLs', () => {
  const error = new Error('Gemini returned HTTP 400 for https://example.test/request?key=secret-value');
  error.cause = new Error('x-goog-api-key: hidden-key Bearer access-token');

  const message = safePeerWorkErrorMessage(error);

  assert.match(message, /Gemini returned HTTP 400/);
  assert.match(message, /\[url\]/);
  assert.match(message, /x-goog-api-key=\[redacted\]/);
  assert.match(message, /Bearer \[redacted\]/);
  assert.doesNotMatch(message, /secret-value|hidden-key|access-token/);
});

test('safePeerWorkErrorMessage redacts API keys included in provider error text', () => {
  const message = safePeerWorkErrorMessage(new Error('Incorrect API key provided: sk-proj-this-is-a-secret-key'));

  assert.match(message, /API key=\[redacted\]/);
  assert.doesNotMatch(message, /sk-proj-this-is-a-secret-key/);
});

test('safePeerWorkErrorMessage redacts inline PDF payloads and bounds diagnostic length', () => {
  const error = new Error(`Failed with data:application/pdf;base64,${'A'.repeat(400)}${'x'.repeat(500)}`);

  const message = safePeerWorkErrorMessage(error);

  assert.match(message, /\[encoded-data-redacted\]/);
  assert.ok(message.length <= 320);
  assert.doesNotMatch(message, /A{20}/);
});

test('safePeerWorkErrorMessage handles missing errors', () => {
  assert.equal(safePeerWorkErrorMessage(null), 'Unknown peer-work error');
});
