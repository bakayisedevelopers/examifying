import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSystemPeerWorkSourcePdf, MAX_SYSTEM_PEER_WORK_PDF_BYTES } from './peerMarkingFallbackPdf.js';

const validPdf = Buffer.from('%PDF-1.7\nFull paper fixture');
const storageUrl = (path) => `https://firebasestorage.googleapis.com/v0/b/papers-bucket/o/${encodeURIComponent(path)}?alt=media&token=secret`;
const bucketFor = (path, buffer = validPdf) => ({
  name: 'papers-bucket',
  file: (requestedPath) => {
    assert.equal(requestedPath, path);
    return {
      getMetadata: async () => [{ size: String(buffer.length) }],
      download: async () => [buffer],
    };
  },
});

test('loads the complete source PDF from the configured Firebase Storage bucket', async () => {
  const path = 'questionPapers/owner/question/Paper One.pdf';
  const result = await loadSystemPeerWorkSourcePdf({
    paper: { id: 'paper-one', paperUrl: storageUrl(path), paperFileName: 'Paper One.pdf' },
    bucket: bucketFor(path),
  });
  assert.equal(result.paperId, 'paper-one');
  assert.equal(result.fileName, 'Paper_One.pdf');
  assert.equal(result.mimeType, 'application/pdf');
  assert.equal(result.sizeBytes, validPdf.length);
  assert.deepEqual(result.buffer, validPdf);
});

test('rejects a memo URL even when it is stored below the paper collection', async () => {
  const path = 'questionPapers/owner/memo/Paper One memo.pdf';
  await assert.rejects(() => loadSystemPeerWorkSourcePdf({
    paper: { id: 'paper-one', paperUrl: storageUrl(path) },
    bucket: bucketFor(path),
  }), /points to a memo/);
});

test('rejects an oversized PDF before downloading it', async () => {
  const path = 'questionPapers/owner/question/Paper One.pdf';
  let downloaded = false;
  const bucket = {
    name: 'papers-bucket',
    file: () => ({
      getMetadata: async () => [{ size: String(MAX_SYSTEM_PEER_WORK_PDF_BYTES + 1) }],
      download: async () => { downloaded = true; return [validPdf]; },
    }),
  };
  await assert.rejects(() => loadSystemPeerWorkSourcePdf({
    paper: { id: 'paper-one', paperUrl: storageUrl(path) }, bucket,
  }), /exceeds the AI PDF input size limit/);
  assert.equal(downloaded, false);
});

test('rejects non-PDF bytes rather than attaching them as a paper', async () => {
  const path = 'questionPapers/owner/question/Paper One.pdf';
  const invalidPdf = Buffer.from('Not a PDF file');
  await assert.rejects(() => loadSystemPeerWorkSourcePdf({
    paper: { id: 'paper-one', paperUrl: storageUrl(path) },
    bucket: bucketFor(path, invalidPdf),
  }), /not a valid PDF/);
});
