const toDate = (value) => {
  if (!value) return null;
  const resolved = value?.toDate?.() ?? value;
  const date = resolved instanceof Date ? resolved : new Date(resolved);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const formatPaymentDate = (value) => {
  const date = toDate(value);
  return date ? date.toLocaleString() : 'Not recorded';
};

export const formatPaymentAmount = (amount, currency = 'ZAR') => {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '—';
  try {
    return new Intl.NumberFormat('en-ZA', { style: 'currency', currency }).format(Number(amount));
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
};

export const readablePaymentStatus = (status) => String(status || 'unknown')
  .replaceAll('_', ' ')
  .replaceAll('-', ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

export const maskPaymentReference = (reference) => {
  const suffix = String(reference ?? '').trim().slice(-4);
  return suffix ? `••••${suffix}` : '—';
};

const getPayerLabel = (payment) => {
  if (payment.payerId && payment.payerId === payment.studentId) {
    return payment.recurring ? 'Student · automatic renewal' : 'Student';
  }
  if (payment.parentId || (payment.payerId && payment.payerId !== payment.studentId)) {
    const parentName = payment.payerName;
    return `${parentName ? `${parentName} · ` : ''}Parent${payment.recurring ? ' · automatic renewal' : ''}`;
  }
  return payment.recurring ? 'Automatic renewal' : 'Not recorded';
};

export const buildPaymentLedgerRows = (transactions = []) => transactions.flatMap((payment) => {
  const reference = payment.reference || payment.id || 'Payment reference unavailable';
  const payerLabel = getPayerLabel(payment);
  const paymentAmount = payment.amount
    ?? (payment.authorizationOnly ? payment.authorizationChargeAmount : null)
    ?? payment.subscriptionAmountDue;
  const paymentTitle = payment.recurring
    ? 'Automatic renewal'
    : payment.authorizationOnly
      ? 'Card authorization payment'
      : payment.planName || payment.planId || 'Subscription payment';
  const rows = [{
    id: `${reference}:payment`,
    kind: 'payment',
    date: payment.paidAt || payment.createdAt || payment.updatedAt,
    reference,
    title: paymentTitle,
    status: payment.status || 'unknown',
    amount: paymentAmount,
    currency: payment.currency || 'ZAR',
    payer: payerLabel,
    studentName: payment.studentName || payment.email || payment.studentEmail || payment.studentId || 'Student',
    studentEmail: payment.studentEmail || payment.email || '',
    planDetails: [payment.billingPeriod, payment.subjectCount ? `${payment.subjectCount} subject${payment.subjectCount === 1 ? '' : 's'}` : null]
      .filter(Boolean).join(' · '),
  }];

  if (payment.authorizationRefundStatus) {
    rows.push({
      id: `${reference}:refund`,
      kind: 'refund',
      date: payment.authorizationRefundUpdatedAt || payment.authorizationRefundExpectedAt || payment.updatedAt,
      reference,
      title: 'Card authorization refund',
      status: payment.authorizationRefundStatus,
      providerStatus: payment.authorizationRefundProviderStatus || null,
      amount: payment.authorizationRefundAmount ?? payment.authorizationChargeAmount ?? payment.amount,
      currency: payment.authorizationRefundCurrency || payment.currency || 'ZAR',
      payer: payerLabel === 'Not recorded' ? 'Returned to card' : `Returned to ${payerLabel}`,
      studentName: payment.studentName || payment.email || payment.studentEmail || payment.studentId || 'Student',
      studentEmail: payment.studentEmail || payment.email || '',
      planDetails: payment.authorizationRefundId ? `Refund ${payment.authorizationRefundId}` : `Payment ${reference}`,
      error: payment.authorizationRefundError || '',
    });
  }
  return rows;
}).sort((left, right) => {
  const leftDate = toDate(left.date)?.getTime() ?? 0;
  const rightDate = toDate(right.date)?.getTime() ?? 0;
  return rightDate - leftDate;
});
