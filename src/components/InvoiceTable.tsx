import { useState } from 'react';
import { supabase, errorText } from '../lib/supabase';
import { moneyExact } from '../lib/format';
import { formatDate } from '../lib/dates';
import { INVOICE_STATUS_LABELS, type Invoice } from '../lib/types';

/**
 * Downloads go through a freshly minted signed URL with a 60-second life. The
 * bucket is private and nothing is ever linked directly, so a URL that leaks
 * out of a browser history or a forwarded email is dead before it is useful.
 */
async function download(inv: Invoice, setBusy: (id: string | null) => void, onError: (m: string) => void) {
  setBusy(inv.id);
  const { data, error } = await supabase.storage
    .from('invoices')
    .createSignedUrl(inv.storage_path, 60, { download: `${inv.number}.pdf` });
  setBusy(null);

  if (error || !data?.signedUrl) {
    onError(errorText(error) || 'Could not prepare that download.');
    return;
  }
  window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
}

export function InvoiceTable({ rows }: { rows: Invoice[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Period</th>
              <th className="num">Amount</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.status === 'void' ? 'voided' : undefined}>
                <td className="mono">{r.number}</td>
                <td>
                  {formatDate(r.period_start)} – {formatDate(r.period_end)}
                </td>
                <td className="num">{moneyExact(r.amount) ?? '—'}</td>
                <td>
                  <span className={`pill ${r.status}`}>
                    {INVOICE_STATUS_LABELS[r.status]}
                  </span>
                </td>
                <td className="right">
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busy === r.id}
                    onClick={() => void download(r, setBusy, setError)}
                  >
                    {busy === r.id ? 'Preparing…' : 'Download'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.some((r) => r.status === 'void') && (
        <p className="muted mt">
          Voided invoices stay listed and downloadable on purpose — a document you
          received should not vanish. A void invoice has been replaced by one with a new
          number.
        </p>
      )}

      {/* Said here rather than left to the pill, because "Part paid" beside a
          full amount reads as if that whole amount is still due. The balance is
          genuinely not recorded — see `InvoiceStatus` — so the honest thing is
          to say so where the number is, instead of printing a remainder the
          database cannot support. */}
      {rows.some((r) => r.status === 'partially_paid') && (
        <p className="muted mt">
          A part-paid invoice shows its full amount, not the balance — the amount
          received is not recorded here. Check with us for the outstanding figure.
        </p>
      )}
    </>
  );
}
