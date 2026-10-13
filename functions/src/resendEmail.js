import { createHash } from 'node:crypto';
import { logger } from 'firebase-functions';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { admin, getDb } from './admin.js';
import { enqueueTaskOnce, stableTaskId } from './taskQueueUtils.js';
import { getEmailPortal, rewriteLegacyEmailPortalLinks } from './emailPortalUrls.js';
import { renderBrandedEmail } from './emailTemplate.js';

const FROM = 'Examifying <notifications@mail.bakayise.com>';
const OUTBOX = 'emailNotificationOutbox';
const MAX_ATTEMPTS = 8;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const emailJobId = ({ type, eventId, email }) => createHash('sha256')
  .update(`${type}|${eventId}|${normalizeEmail(email)}`)
  .digest('hex');

const getRecipientProfile = async (email) => {
  const db = getDb();
  const normalizedEmail = normalizeEmail(email);
  const normalizedMatch = await db.collection('users')
    .where('emailLowercase', '==', normalizedEmail).limit(1).get();
  if (!normalizedMatch.empty) return normalizedMatch.docs[0].data();
  const legacyMatch = await db.collection('users')
    .where('email', '==', normalizedEmail).limit(1).get();
  return legacyMatch.empty ? {} : legacyMatch.docs[0].data();
};

export const queueBrandedEmail = async ({
  type,
  eventId,
  to,
  profile = {},
  name = '',
  subject,
  heading,
  paragraphs = [],
  details = [],
  actionLabel,
  actionUrl,
}) => {
  const email = normalizeEmail(to);
  if (!validEmail(email) || !type || !eventId || !subject || !heading) return null;

  const id = emailJobId({ type, eventId, email });
  const rendered = renderBrandedEmail({ profile, name, heading, paragraphs, details, actionLabel, actionUrl });
  const ref = getDb().collection(OUTBOX).doc(id);
  await getDb().runTransaction(async (transaction) => {
    const current = await transaction.get(ref);
    if (current.exists) return;
    transaction.create(ref, {
      id,
      type,
      eventId: String(eventId),
      to: email,
      portalRole: getEmailPortal(profile),
      from: FROM,
      subject,
      ...rendered,
      status: 'queued',
      attempts: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  return id;
};

const claimEmail = async (ref) => getDb().runTransaction(async (transaction) => {
  const snapshot = await transaction.get(ref);
  if (!snapshot.exists) return { terminal: true };
  const data = snapshot.data();
  const now = Date.now();
  const nextAttemptAt = data.nextAttemptAt?.toDate?.()?.getTime?.() ?? 0;
  const lockedAt = data.lockedAt?.toDate?.()?.getTime?.() ?? 0;
  if (['sent', 'failed'].includes(data.status)) return { terminal: true };
  if (nextAttemptAt > now) return { retryAt: new Date(nextAttemptAt) };
  if (data.status === 'sending' && now - lockedAt < LOCK_TIMEOUT_MS) {
    return { retryAt: new Date(lockedAt + LOCK_TIMEOUT_MS + 1000) };
  }
  const attempts = Number(data.attempts || 0) + 1;
  if (attempts > MAX_ATTEMPTS) {
    transaction.update(ref, {
      status: 'failed',
      lastError: 'Email delivery exceeded retry limit.',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { terminal: true };
  }
  transaction.update(ref, {
    status: 'sending',
    attempts,
    lockedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { message: { ...data, attempts } };
});

const enqueueEmailDelivery = (jobId, generation, scheduleTime) => enqueueTaskOnce(
  'deliverResendEmail',
  { jobId, generation },
  {
    id: stableTaskId('email', `${jobId}|${generation}`),
    ...(scheduleTime ? { scheduleTime } : {}),
  },
);

const sendWithResend = async ({ apiKey, jobId, message }) => {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `examifying/${jobId}`,
    },
    body: JSON.stringify({
      from: message.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Resend rejected the email request (${response.status}).`);
    error.statusCode = response.status;
    error.providerName = result.name || result.error || null;
    throw error;
  }
  return result;
};

export const queueResendEmailDelivery = onDocumentCreated({
  document: `${OUTBOX}/{jobId}`,
  retry: true,
  memory: '256MiB',
}, async (event) => {
  if (!event.data?.exists) return;
  await enqueueEmailDelivery(event.params.jobId, 0);
});

export const deliverResendEmail = onTaskDispatched({
  retryConfig: { maxAttempts: 5, minBackoffSeconds: 30, maxBackoffSeconds: 900, maxDoublings: 4 },
  rateLimits: { maxConcurrentDispatches: 20, maxDispatchesPerSecond: 10 },
  timeoutSeconds: 120,
  memory: '256MiB',
}, async (request) => {
  const jobId = String(request.data?.jobId ?? '');
  if (!jobId) throw new Error('jobId is required to deliver an outbox email.');
  const ref = getDb().collection(OUTBOX).doc(jobId);
  const claim = await claimEmail(ref);
  if (claim.terminal) return;
  if (!claim.message) {
    await enqueueEmailDelivery(jobId, Number(request.data?.generation || 0) + 1, claim.retryAt);
    return;
  }

  let message = claim.message;
  if (`${message.html || ''}\n${message.text || ''}`.includes('.web.app')) {
    const recipientProfile = message.portalRole
      ? { role: message.portalRole }
      : await getRecipientProfile(message.to);
    const rewritten = rewriteLegacyEmailPortalLinks(message, recipientProfile);
    message = { ...message, ...rewritten, portalRole: getEmailPortal(recipientProfile) };
    await ref.set({
      html: rewritten.html,
      text: rewritten.text,
      portalRole: message.portalRole,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    await ref.set({
      status: 'queued',
      attempts: Math.max(0, Number(message.attempts || 1) - 1),
      lockedAt: admin.firestore.FieldValue.delete(),
      nextAttemptAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 60 * 60 * 1000)),
      lastError: 'Email delivery is waiting for RESEND_API_KEY configuration.',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    throw new Error('RESEND_API_KEY is not configured for email delivery.');
  }

  try {
    const result = await sendWithResend({ apiKey, jobId, message });
    await ref.set({
      status: 'sent',
      resendId: result.id || null,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lockedAt: admin.firestore.FieldValue.delete(),
      nextAttemptAt: admin.firestore.FieldValue.delete(),
      lastError: admin.firestore.FieldValue.delete(),
    }, { merge: true });
  } catch (error) {
    const terminal = [400, 401, 403, 404].includes(error.statusCode) || message.attempts >= MAX_ATTEMPTS;
    const delayMs = Math.min(60 * 60 * 1000, 30 * 1000 * (2 ** Math.min(message.attempts - 1, 7)));
    const retryAt = new Date(Date.now() + delayMs);
    await ref.set({
      status: terminal ? 'failed' : 'queued',
      nextAttemptAt: terminal ? admin.firestore.FieldValue.delete() : admin.firestore.Timestamp.fromDate(retryAt),
      lastError: String(error.message || 'Email delivery failed.').slice(0, 250),
      lastProviderError: error.providerName || null,
      lockedAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    logger.error('Resend email delivery failed', {
      jobId,
      type: message.type,
      statusCode: error.statusCode || null,
      attempt: message.attempts,
      terminal,
    });
    if (!terminal) await enqueueEmailDelivery(jobId, message.attempts, retryAt);
  }
});

export const processResendEmailOutbox = onSchedule({
  schedule: '15 2 * * *',
  timeZone: 'Africa/Johannesburg',
  timeoutSeconds: 120,
  memory: '256MiB',
}, async () => {
  const db = getDb();
  const queue = await db.collection(OUTBOX)
    .where('status', 'in', ['queued', 'sending'])
    .limit(100)
    .get();
  for (const document of queue.docs) {
    const data = document.data();
    const dueAt = data.nextAttemptAt?.toDate?.() ?? new Date(0);
    const lockAt = data.lockedAt?.toDate?.();
    const retryAt = data.status === 'sending' && lockAt && Date.now() - lockAt.getTime() < LOCK_TIMEOUT_MS
      ? new Date(lockAt.getTime() + LOCK_TIMEOUT_MS + 1000)
      : (dueAt > new Date() ? dueAt : undefined);
    const repairGeneration = Math.floor(Date.now() / (60 * 60 * 1000));
    await enqueueEmailDelivery(document.id, `repair-${repairGeneration}`, retryAt);
  }
});
