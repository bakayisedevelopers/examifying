import { formatPaymentAmount, formatPaymentDate, readablePaymentStatus } from '../../utils/paymentTransactions';

const statusColor = (status) => {
  const normalized = String(status || '').toLowerCase();
  if (['success', 'processed', 'active'].includes(normalized)) return 'bg-lime-100 text-lime-900';
  if (['failed', 'amount_mismatch', 'needs-attention', 'reversed'].includes(normalized)) return 'bg-red-100 text-red-800';
  if (['scheduled_change', 'superseded', 'cancelled', 'abandoned'].includes(normalized)) return 'bg-slate-100 text-slate-700';
  return 'bg-amber-100 text-amber-900';
};

export const PaymentTransactionList = ({ rows, showStudent = false }) => {
  if (!rows.length) return <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">No payment transactions have been recorded yet.</p>;

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <article key={row.id} className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="font-semibold text-slate-900">{row.kind === 'refund' ? 'Refund' : 'Payment'} · {row.title}</p>
              {showStudent ? <span className="text-sm text-slate-600">for {row.studentName}</span> : null}
            </div>
            {showStudent && row.studentEmail && row.studentEmail !== row.studentName ? <p className="mt-1 text-xs text-slate-500">{row.studentEmail}</p> : null}
            <p className="mt-1 break-all text-xs text-slate-500">Reference: {row.reference}</p>
            {row.planDetails ? <p className="mt-1 text-xs text-slate-500">{row.planDetails}</p> : null}
            {row.error ? <p className="mt-2 break-words text-xs text-red-700">Refund note: {row.error}</p> : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-end">
            <div className="text-left sm:text-right">
              <p className="text-sm font-semibold text-slate-800">{row.payer}</p>
              <p className="mt-1 text-xs text-slate-500">{formatPaymentDate(row.date)}</p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusColor(row.status)}`}>
              {readablePaymentStatus(row.status)}
              {row.providerStatus && row.providerStatus !== row.status ? ` · ${readablePaymentStatus(row.providerStatus)}` : ''}
            </span>
            <p className="min-w-24 text-right text-sm font-bold text-slate-950">{formatPaymentAmount(row.amount, row.currency)}</p>
          </div>
        </article>
      ))}
    </div>
  );
};
