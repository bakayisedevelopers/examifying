import { formatPaymentAmount, formatPaymentDate, maskPaymentReference, readablePaymentStatus } from '../../utils/paymentTransactions';

const statusColor = (status) => {
  const normalized = String(status || '').toLowerCase();
  if (['success', 'processed', 'active'].includes(normalized)) return 'bg-lime-100 text-lime-900';
  if (['failed', 'amount_mismatch', 'needs-attention', 'reversed'].includes(normalized)) return 'bg-red-100 text-red-800';
  if (['scheduled_change', 'superseded', 'cancelled', 'abandoned'].includes(normalized)) return 'bg-slate-100 text-slate-700';
  return 'bg-amber-100 text-amber-900';
};

export const PaymentTransactionList = ({ rows, showStudent = false, layout = 'cards', transparentCards = false }) => {
  if (!rows.length) return <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">No payment transactions have been recorded yet.</p>;

  if (layout === 'table') {
    return (
      <div className="panel overflow-hidden p-0">
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="min-w-[760px] w-full border-collapse text-left text-sm">
            <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">Transaction</th>
                <th scope="col" className="px-4 py-3 font-semibold">Reference</th>
                {showStudent ? <th scope="col" className="px-4 py-3 font-semibold">Student</th> : null}
                <th scope="col" className="px-4 py-3 font-semibold">Paid by</th>
                <th scope="col" className="px-4 py-3 font-semibold">Date</th>
                <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/70">
              {rows.map((row) => {
                const referenceSuffix = String(row.reference ?? '').trim().slice(-4);
                return (
                  <tr key={row.id} className="align-top">
                    <th scope="row" className="px-4 py-4 text-left font-semibold text-slate-900">
                      <span>{row.kind === 'refund' ? 'Refund' : 'Payment'} · {row.title}</span>
                      {row.kind !== 'refund' && row.planDetails ? <span className="mt-1 block text-xs font-normal text-slate-500">{row.planDetails}</span> : null}
                    </th>
                    <td className="whitespace-nowrap px-4 py-4 font-mono text-xs text-slate-500" aria-label={referenceSuffix ? `Reference ending ${referenceSuffix}` : 'Reference unavailable'}>
                      {maskPaymentReference(row.reference)}
                    </td>
                    {showStudent ? <td className="px-4 py-4 text-slate-700">{row.studentName}</td> : null}
                    <td className="px-4 py-4 text-slate-700">{row.payer}</td>
                    <td className="whitespace-nowrap px-4 py-4 text-slate-500">{formatPaymentDate(row.date)}</td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${statusColor(row.status)}`}>
                        {readablePaymentStatus(row.status)}
                        {row.providerStatus && row.providerStatus !== row.status ? ` · ${readablePaymentStatus(row.providerStatus)}` : ''}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 text-right font-bold text-slate-950">{formatPaymentAmount(row.amount, row.currency)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <article key={row.id} className={`flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between ${transparentCards ? 'border-slate-700/70 bg-transparent' : 'border-slate-200 bg-white'}`}>
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
