const normalizeIdentityText = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export const normalizePaperRegionIdentity = (value) => normalizeIdentityText(value);

export const normalizePaperIdentityValue = (value, field) => field === 'region'
  ? normalizePaperRegionIdentity(value)
  : normalizeIdentityText(value);

const firstText = (...values) => {
  for (const value of values) {
    const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (normalized) return normalized;
  }
  return '';
};

// The PDF filename is the canonical identity source for every importer. The
// sibling analysis JSON can fill optional or absent fields, followed by the
// previous Firestore value for compatibility with older Drive schemas.
export const resolveDrivePaperIdentity = ({
  analysisIdentity = {},
  filenameIdentity = {},
  storedIdentity = {},
} = {}) => {
  const resolved = Object.fromEntries(['subject', 'grade', 'region', 'month', 'year', 'paperNumber', 'language', 'examSession'].map((field) => [
    field,
    firstText(filenameIdentity[field], analysisIdentity[field], storedIdentity[field]),
  ]));
  const year = Number(resolved.year);
  if (Number.isInteger(year) && year > 0) resolved.year = year;
  return resolved;
};
