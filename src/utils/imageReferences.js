const getSource = (image) => String(image?.url ?? image?.downloadUrl ?? image?.storagePath ?? image?.path ?? '').trim();

export const imageReferenceIdentity = (image) => {
  const source = getSource(image);
  if (!source) return '';
  if (source.startsWith('gs://')) return `storage:${source.slice(5).split('?')[0]}`;
  try {
    const parsed = new URL(source);
    const storagePath = parsed.pathname.match(/\/b\/([^/]+)\/o\/(.+)$/);
    if (storagePath) {
      return `storage:${decodeURIComponent(storagePath[1])}:${decodeURIComponent(storagePath[2])}`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return source.split(/[?#]/)[0];
  }
};

export const excludeDuplicateImageReferences = (preferredImages = [], candidateImages = []) => {
  const seen = new Set(preferredImages.map(imageReferenceIdentity).filter(Boolean));
  return candidateImages.filter((image) => {
    const identity = imageReferenceIdentity(image);
    if (!identity) return true;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
};
