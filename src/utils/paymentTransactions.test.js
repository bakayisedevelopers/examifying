import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentLedgerRows, readablePaymentStatus } from './paymentTransactions.js';

test('payment history keeps the payer and creates a separate row for its refund', () => {
  const [paymentRow, refundRow] = buildPaymentLedgerRows([{
    id: 'pay-1',
    reference: 'pay-1',
    studentId: 'student-1',
    payerId: 'parent-1',
    parentId: 'parent-1',
    payerName: 'Parent One',
    planName: 'Examifying Program',
    amount: 1,
    authorizationOnly: true,
    authorizationChargeAmount: 1,
    authorizationRefundStatus: 'processed',
    authorizationRefundAmount: 1,
    authorizationRefundCurrency: 'ZAR',
    authorizationRefundId: 'refund-1',
    status: 'success',
  }]);

  assert.equal(paymentRow.kind, 'payment');
  assert.equal(paymentRow.payer, 'Parent One · Parent');
  assert.equal(paymentRow.amount, 1);
  assert.equal(refundRow.kind, 'refund');
  assert.equal(refundRow.payer, 'Returned to Parent One · Parent');
  assert.equal(refundRow.amount, 1);
  assert.equal(refundRow.status, 'processed');
});

test('zero cost and student paid records remain visible without inventing refund entries', () => {
  const [row] = buildPaymentLedgerRows([{
    reference: 'free-1',
    studentId: 'student-1',
    payerId: 'student-1',
    status: 'success',
    amount: 0,
  }]);

  assert.equal(row.amount, 0);
  assert.equal(row.payer, 'Student');
  assert.equal(row.kind, 'payment');
});

test('payment status labels are readable without changing stored values', () => {
  assert.equal(readablePaymentStatus('pending_initiation'), 'Pending Initiation');
});
