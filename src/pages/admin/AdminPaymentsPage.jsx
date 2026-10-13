import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { PaymentTransactionList } from '../../components/billing/PaymentTransactionList';
import { useAuth } from '../../hooks/useAuth';
import { useScreenLoadMetrics } from '../../hooks/useScreenLoadMetrics';
import { getAdminAuthorizationRefundIssues, getAdminPaymentTransactions } from '../../services/paymentsService';
import { buildPaymentLedgerRows, formatPaymentAmount, formatPaymentDate, readablePaymentStatus } from '../../utils/paymentTransactions';

const toLocalDateInput = (value) => {
  if (!value) return '';
  const date = new Date(value?.toDate?.() ?? value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export const AdminPaymentsPage = () => {
  const { profile, logout } = useAuth();
  const [issues, setIssues] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [issuesLoading, setIssuesLoading] = useState(true);
  const [transactionsLoading, setTransactionsLoading] = useState(true);
  const [issuesError, setIssuesError] = useState('');
  const [transactionsError, setTransactionsError] = useState('');
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [payerFilter, setPayerFilter] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const loading = issuesLoading || transactionsLoading;
  useScreenLoadMetrics('Admin payments', 'admin', !loading);

  const loadData = useCallback(async () => {
    setIssuesLoading(true);
    setTransactionsLoading(true);
    setIssuesError('');
    setTransactionsError('');
    const [issueResult, transactionResult] = await Promise.allSettled([
      getAdminAuthorizationRefundIssues(),
      getAdminPaymentTransactions(),
    ]);
    if (issueResult.status === 'fulfilled') setIssues(issueResult.value.issues || []);
    else setIssuesError(issueResult.reason?.message || 'Could not load authorization refund records.');
    if (transactionResult.status === 'fulfilled') setTransactions(transactionResult.value.transactions || []);
    else setTransactionsError(transactionResult.reason?.message || 'Could not load payment transactions.');
    setIssuesLoading(false);
    setTransactionsLoading(false);
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  const allRows = useMemo(() => buildPaymentLedgerRows(transactions), [transactions]);
  const statuses = useMemo(() => [...new Set(allRows.map((row) => row.status).filter(Boolean))].sort(), [allRows]);
  const filteredRows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return allRows.filter((row) => {
      if (kindFilter !== 'all' && row.kind !== kindFilter) return false;
      if (statusFilter !== 'all' && row.status !== statusFilter) return false;
      const normalizedPayer = row.payer.toLowerCase();
      if (payerFilter === 'student' && !normalizedPayer.startsWith('student')) return false;
      if (payerFilter === 'parent' && !normalizedPayer.includes('parent')) return false;
      if (payerFilter === 'automatic' && !normalizedPayer.includes('automatic')) return false;
      const dateKey = toLocalDateInput(row.date);
      if (fromDate && dateKey && dateKey < fromDate) return false;
      if (toDate && dateKey && dateKey > toDate) return false;
      if (!normalizedSearch) return true;
      return [
        row.reference,
        row.title,
        row.studentName,
        row.studentEmail,
        row.payer,
        row.planDetails,
        row.status,
      ].some((value) => String(value || '').toLowerCase().includes(normalizedSearch));
    });
  }, [allRows, fromDate, kindFilter, payerFilter, search, statusFilter, toDate]);

  return (
    <AppShell title="Payments" subtitle="Review student payments, payer details, and refund statuses." role="admin" user={profile} onLogout={logout}>
      <div className="space-y-5">
        <section className="panel space-y-4 p-5" aria-labelledby="admin-payment-history-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="admin-payment-history-heading" className="text-lg font-bold text-slate-950">All payment transactions</h2>
              <p className="mt-1 text-sm text-slate-600">Payments and refunds recorded for every student, including who paid.</p>
            </div>
            <button type="button" className="btn-secondary" onClick={() => void loadData()} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
            <label className="text-sm text-slate-700 sm:col-span-2">
              Search
              <input className="input mt-1 w-full" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Student, payer, email, reference" />
            </label>
            <label className="text-sm text-slate-700">
              Transaction
              <select className="input mt-1 w-full" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
                <option value="all">Payments and refunds</option>
                <option value="payment">Payments</option>
                <option value="refund">Refunds</option>
              </select>
            </label>
            <label className="text-sm text-slate-700">
              Paid by
              <select className="input mt-1 w-full" value={payerFilter} onChange={(event) => setPayerFilter(event.target.value)}>
                <option value="all">All payers</option>
                <option value="student">Student</option>
                <option value="parent">Parent</option>
                <option value="automatic">Automatic renewal</option>
              </select>
            </label>
            <label className="text-sm text-slate-700">
              Status
              <select className="input mt-1 w-full" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="all">All statuses</option>
                {statuses.map((status) => <option key={status} value={status}>{readablePaymentStatus(status)}</option>)}
              </select>
            </label>
            <label className="text-sm text-slate-700">
              From
              <input className="input mt-1 w-full" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
            </label>
            <label className="text-sm text-slate-700">
              To
              <input className="input mt-1 w-full" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
            </label>
          </div>

          <p className="text-sm text-slate-600" aria-live="polite">Showing {filteredRows.length} of {allRows.length} transaction records.</p>
          {transactionsError ? <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{transactionsError}</p> : null}
          {transactionsLoading ? <LoadingState label="Loading payment transactions…" /> : transactionsError ? null : <PaymentTransactionList rows={filteredRows} showStudent />}
        </section>

        <section className="panel space-y-4 p-5">
          <div>
            <h2 className="text-lg font-bold text-slate-950">Authorization refund reconciliation</h2>
            <p className="mt-1 text-sm text-slate-600">R1 card-authorization payments whose automatic refund needs review.</p>
          </div>
          {issuesError ? <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{issuesError}</p> : null}
          {issuesLoading ? <LoadingState label="Loading refund review records…" /> : null}
          {!issuesLoading && !issuesError && issues.length === 0 ? (
            <p className="rounded-xl bg-lime-50 p-3 text-sm text-slate-700">No authorization refunds need review.</p>
          ) : null}
          {issues.length > 0 ? (
            <div className="space-y-3">
              {issues.map((issue) => (
                <article key={issue.reference} className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-slate-800">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold">{issue.email || issue.studentId || 'Unknown account'}</p>
                      <p className="mt-1 break-all text-xs text-slate-600">Payment reference: {issue.reference}</p>
                    </div>
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-900">
                      {String(issue.refundStatus || 'pending').replaceAll('-', ' ')}
                    </span>
                  </div>
                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                    <div><dt className="text-slate-500">Temporary charge</dt><dd className="font-medium">{formatPaymentAmount(issue.amount, 'ZAR')}</dd></div>
                    <div><dt className="text-slate-500">Refund attempts</dt><dd className="font-medium">{issue.attempts}</dd></div>
                    <div><dt className="text-slate-500">Last updated</dt><dd className="font-medium">{formatPaymentDate(issue.updatedAt)}</dd></div>
                  </dl>
                  {issue.error ? <p className="mt-3 break-words text-xs text-red-800">{issue.error}</p> : null}
                  <p className="mt-3 text-xs text-slate-600">Check the matching transaction and refund in Paystack before initiating any manual refund.</p>
                </article>
              ))}
            </div>
          ) : null}
        </section>
        <div className="panel p-5 text-sm text-slate-600">Payment amounts are calculated and verified server-side. Paystack authorization details remain server-only.</div>
      </div>
    </AppShell>
  );
};
