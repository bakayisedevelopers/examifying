import { useCallback, useEffect, useState } from 'react';
import { LoadingState } from '../common/LoadingState';
import { getStudentPaymentTransactions } from '../../services/paymentsService';
import { buildPaymentLedgerRows } from '../../utils/paymentTransactions';
import { PaymentTransactionList } from './PaymentTransactionList';

export const StudentPaymentHistory = ({ studentId }) => {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadTransactions = useCallback(async () => {
    if (!studentId) return;
    setLoading(true);
    setError('');
    try {
      const result = await getStudentPaymentTransactions(studentId);
      setTransactions(result.transactions || []);
    } catch (loadError) {
      setError(loadError?.message || 'Could not load payment history.');
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  useEffect(() => { void loadTransactions(); }, [loadTransactions]);

  return (
    <section className="panel space-y-4 p-5" aria-labelledby="student-payment-history-heading">
      <div>
        <h2 id="student-payment-history-heading" className="text-lg font-bold text-slate-950">Payment history</h2>
        <p className="mt-1 text-sm text-slate-600">Payments made for this student and refunds returned to the original card.</p>
      </div>
      {error ? <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      {loading ? <LoadingState label="Loading payment history…" /> : <PaymentTransactionList rows={buildPaymentLedgerRows(transactions)} layout="table" />}
    </section>
  );
};
