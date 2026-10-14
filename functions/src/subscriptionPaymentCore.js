const amountMatches = (left, right) => left !== null && left !== undefined && left !== ''
  && right !== null && right !== undefined && right !== ''
  && Number.isFinite(Number(left))
  && Number.isFinite(Number(right))
  && Math.round(Number(left) * 100) === Math.round(Number(right) * 100);

/**
 * Confirms that a successful payment document is the payment that activated the
 * current subscription. The subscription and payment documents remain the
 * authority for the plan, while the quote supplies the server-calculated price.
 */
export const isVerifiedSubscriptionPaymentRecord = ({
  studentId,
  subscription,
  payment,
  paymentDocumentId,
  quote,
}) => {
  if (!studentId || !subscription || !payment || !quote) return false;
  if (payment.status !== 'success'
    || payment.reference !== paymentDocumentId
    || payment.studentId !== studentId
    || payment.planId !== subscription.planId
    || payment.billingPeriod !== subscription.billingPeriod
    || Number(payment.subjectCount) !== Number(subscription.subjectCount)
    || payment.currency !== quote.currency) return false;

  const percentOff = Number(payment.discountPercent);
  const hasDiscount = Number.isInteger(percentOff) && percentOff >= 1 && percentOff <= 100;
  if (hasDiscount && (!payment.discountCode
    || payment.discountCode !== subscription.discountCode
    || Number(subscription.discountPercent) !== percentOff
    || payment.discountBillingDuration !== subscription.discountBillingDuration)) return false;
  if (!hasDiscount && Number(subscription.discountPercent) > 0) return false;

  const quoteMinor = Math.round(Number(quote.amount) * 100);
  if (!Number.isSafeInteger(quoteMinor) || quoteMinor < 0) return false;
  const expectedAmount = (hasDiscount
    ? Math.round((quoteMinor * (100 - percentOff)) / 100)
    : quoteMinor) / 100;
  if (subscription.amount !== null && subscription.amount !== undefined
    && !amountMatches(subscription.amount, expectedAmount)) return false;
  if (payment.subscriptionAmountDue !== null && payment.subscriptionAmountDue !== undefined
    && !amountMatches(payment.subscriptionAmountDue, expectedAmount)) return false;

  const actualAmount = Number(payment.amount);
  if (payment.authorizationOnly === true) {
    const authorizationAmount = Number(payment.authorizationChargeAmount);
    return expectedAmount === 0
      && Number.isFinite(authorizationAmount)
      && authorizationAmount > 0
      && amountMatches(actualAmount, authorizationAmount);
  }
  return amountMatches(actualAmount, expectedAmount);
};
