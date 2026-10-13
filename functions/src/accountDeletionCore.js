const TIME_ZONE = 'Africa/Johannesburg';
const REMOVED = Symbol('removed');

const partsFor = (date, timeZone, includeTime = false) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' } : {}),
  });
  return Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, Number(value)]));
};

export const getScheduledAccountDeletionDate = (now = new Date(), graceDays = 30) => {
  const currentDate = partsFor(now, TIME_ZONE);
  // The daily job runs at midnight, so use the first midnight after the full
  // 30-day grace window rather than expiring the request at the start of day 30.
  const targetUtcCalendarDate = new Date(Date.UTC(currentDate.year, currentDate.month - 1, currentDate.day + graceDays + 1));
  const targetYear = targetUtcCalendarDate.getUTCFullYear();
  const targetMonth = targetUtcCalendarDate.getUTCMonth() + 1;
  const targetDay = targetUtcCalendarDate.getUTCDate();
  const utcGuess = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay));
  const localAtGuess = partsFor(utcGuess, TIME_ZONE, true);
  const localAsUtc = Date.UTC(localAtGuess.year, localAtGuess.month - 1, localAtGuess.day,
    localAtGuess.hour, localAtGuess.minute, localAtGuess.second);
  const zoneOffset = localAsUtc - utcGuess.getTime();
  return new Date(utcGuess.getTime() - zoneOffset);
};

const isFirestoreSpecialValue = (value) => value instanceof Date
  || typeof value?.toMillis === 'function'
  || typeof value?.isEqual === 'function'
  || (value && typeof value.get === 'function' && typeof value.path === 'string');

const scrubValue = (value, uid) => {
  if (value === uid) return { value: REMOVED, changed: true };
  if (!value || typeof value !== 'object' || isFirestoreSpecialValue(value)) return { value, changed: false };

  if (Array.isArray(value)) {
    let changed = false;
    const cleaned = [];
    for (const item of value) {
      const result = scrubValue(item, uid);
      if (result.value === REMOVED) {
        changed = true;
        continue;
      }
      changed ||= result.changed;
      cleaned.push(result.value);
    }
    return { value: changed ? cleaned : value, changed };
  }

  let changed = false;
  const cleaned = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === uid) {
      changed = true;
      continue;
    }
    const result = scrubValue(item, uid);
    if (result.value === REMOVED) {
      changed = true;
      continue;
    }
    changed ||= result.changed;
    cleaned[key] = result.value;
  }
  return { value: changed ? cleaned : value, changed };
};

export const scrubUserReferences = (value, uid) => {
  const result = scrubValue(value, uid);
  return { value: result.value === REMOVED ? undefined : result.value, changed: result.changed };
};

export const removeUserFromStaffEpisode = (episode = {}, uid) => {
  const scrubbed = scrubUserReferences(episode, uid);
  const result = { ...scrubbed.value };
  if (episode.primaryTutorId === uid) result.primaryTutorId = '';
  if (episode.activeStaffIds?.includes?.(uid)) result.activeStaffIds = episode.activeStaffIds.filter((staffId) => staffId !== uid);
  if (episode.historicalStaffIds?.includes?.(uid)) result.historicalStaffIds = episode.historicalStaffIds.filter((staffId) => staffId !== uid);
  if (episode.staffByUid?.[uid]) {
    result.staffByUid = { ...episode.staffByUid };
    delete result.staffByUid[uid];
  }
  if (Array.isArray(episode.staffMemberships)) {
    result.staffMemberships = episode.staffMemberships
      .filter((membership) => membership?.uid !== uid)
      .map((membership) => scrubUserReferences(membership, uid).value);
  }
  return result;
};

export const formatDeletionDate = (date, timeZone = TIME_ZONE) => new Intl.DateTimeFormat('en-ZA', {
  dateStyle: 'long', timeZone,
}).format(date);
