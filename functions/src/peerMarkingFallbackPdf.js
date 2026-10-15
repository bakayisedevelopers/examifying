const MAX_SYSTEM_PEER_WORK_PDF_BYTES = 48_000_000;

const parseStorageUrl = (value) => {
  const source = String(value ?? '').trim();
  if (source.startsWith('gs://')) {
    const path = source.slice(5);
    const separator = path.indexOf('/');
    return separator > 0
      ? { bucketName: path.slice(0, separator), path: decodeURIComponent(path.slice(separator + 1)) }
      : null;
  }
  try {
    const parsed = new URL(source);
    const match = parsed.pathname.match(/\/b\/([^/]+)\/o\/(.+)$/);
    if (!match) return null;
    return { bucketName: decodeURIComponent(match[1]), path: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
};

const safePdfFileName = (value) => {
  const fileName = String(value ?? '').split(/[\\/]/).at(-1)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, 150);
  return `${fileName.replace(/\.pdf$/i, '') || 'source-question-paper'}.pdf`;
};

export const loadSystemPeerWorkSourcePdf = async ({ paper, bucket, maxBytes = MAX_SYSTEM_PEER_WORK_PDF_BYTES }) => {
  const parsed = parseStorageUrl(paper?.paperUrl);
  if (!parsed || parsed.bucketName !== bucket?.name || !parsed.path.startsWith('questionPapers/')) {
    throw new Error(`Source question paper ${paper?.id || ''} is not stored in the configured Firebase Storage bucket.`);
  }
  const pathType = String(parsed.path.split('/')[2] || '').toLocaleLowerCase();
  if (/^(memo|memorandum|marking[-_ ]?(?:memo|scheme|guide))$/.test(pathType)) {
    throw new Error(`Source question paper ${paper?.id || ''} points to a memo instead of a question paper.`);
  }

  const file = bucket.file(parsed.path);
  const [metadata] = await file.getMetadata();
  const sizeBytes = Number(metadata.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 8) {
    throw new Error(`Source question paper ${paper?.id || ''} has an invalid PDF size.`);
  }
  if (sizeBytes > maxBytes) {
    throw new Error(`Source question paper ${paper?.id || ''} exceeds the AI PDF input size limit.`);
  }

  const [buffer] = await file.download();
  if (!Buffer.isBuffer(buffer) || buffer.length !== sizeBytes) {
    throw new Error(`Source question paper ${paper?.id || ''} could not be downloaded completely.`);
  }
  if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    throw new Error(`Source question paper ${paper?.id || ''} is not a valid PDF file.`);
  }

  const storedFileName = parsed.path.split('/').at(-1) || '';
  return {
    paperId: String(paper?.id ?? ''),
    fileName: safePdfFileName(paper?.paperFileName || paper?.fileName || storedFileName),
    mimeType: 'application/pdf',
    buffer,
    sizeBytes,
  };
};

export { MAX_SYSTEM_PEER_WORK_PDF_BYTES };
