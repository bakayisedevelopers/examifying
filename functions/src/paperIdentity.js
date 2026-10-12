const normalizeIdentityText = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const regionAliases = new Map([
  ['Eastern Cape', ['Eastern Cape', 'EC', 'Province of Eastern Cape']],
  ['Free State', ['Free State', 'FS', 'Province of Free State']],
  ['Gauteng', ['Gauteng', 'GP', 'Province of Gauteng']],
  ['KwaZulu-Natal', ['KwaZulu-Natal', 'KwaZulu Natal', 'Kwa Zulu Natal', 'KZN', 'Province of KwaZulu-Natal']],
  ['Limpopo', ['Limpopo', 'LP', 'Province of Limpopo']],
  ['Mpumalanga', ['Mpumalanga', 'MP', 'Province of Mpumalanga']],
  ['North West', ['North West', 'NW', 'Province of North West']],
  ['Northern Cape', ['Northern Cape', 'NC', 'Province of Northern Cape']],
  ['Western Cape', ['Western Cape', 'WC', 'Province of Western Cape']],
  ['National', ['National']],
].flatMap(([canonical, aliases]) => aliases.map((alias) => [
  normalizeIdentityText(alias),
  normalizeIdentityText(canonical),
])));

export const normalizePaperRegionIdentity = (value) => {
  const normalized = normalizeIdentityText(value);
  const withoutProvinceSuffix = normalized.replace(/\s+province$/, '').trim();
  return regionAliases.get(normalized) ?? regionAliases.get(withoutProvinceSuffix) ?? normalized;
};

export const normalizePaperIdentityValue = (value, field) => field === 'region'
  ? normalizePaperRegionIdentity(value)
  : normalizeIdentityText(value);

export const findVerifiedPaperRegionCorrection = ({ storedIdentity = {}, providedIdentity = {}, filenameIdentity = {} } = {}) => {
  const nonRegionFields = ['subject', 'grade', 'month', 'year', 'paperNumber'];
  const filenameRegion = String(filenameIdentity.region ?? '').trim();
  if (!filenameRegion || !providedIdentity.region) return '';

  const nonRegionIdentityMatches = nonRegionFields.every((field) => {
    const filenameValue = normalizePaperIdentityValue(filenameIdentity[field], field);
    return filenameValue
      && filenameValue === normalizePaperIdentityValue(storedIdentity[field], field)
      && filenameValue === normalizePaperIdentityValue(providedIdentity[field], field);
  });
  const providedRegionMatchesFile = normalizePaperIdentityValue(providedIdentity.region, 'region')
    === normalizePaperIdentityValue(filenameRegion, 'region');
  const storedRegionMatchesFile = normalizePaperIdentityValue(storedIdentity.region, 'region')
    === normalizePaperIdentityValue(filenameRegion, 'region');

  return nonRegionIdentityMatches && providedRegionMatchesFile && !storedRegionMatchesFile
    ? filenameRegion
    : '';
};
