import { useState, type FormEvent } from 'react';
import { supabase, errorText } from '../lib/supabase';
import { Modal } from './Modal';
import { moneyExact } from '../lib/format';
import type { Invoice, InvoiceStatus } from '../lib/types';

/**
 * Correcting the record an invoice was filed under, after the upload.
 *
 * Every field here was typed by hand at upload time, into a form standing next
 * to a PDF nobody was reading back — the number off a document in another tab,
 * the period defaulted to last month and left alone, the amount retyped. That
 * is four chances to file a real invoice under the wrong month, and until now
 * the only fix was delete-and-reupload, which is a destructive operation
 * standing in for a typo.
 *
 * The PDF is deliberately NOT editable here. Its storage path is derived from
 * the row id — `{client_id}/{id}.pdf` — so swapping the file means overwriting
 * an object that signed URLs already point at, and a client who downloaded
 * yesterday would find a different document under the same name today. A wrong
 * *file* is the case delete exists for. This form is for a wrong *label*.
 */
export function InvoiceEdit({
  invoice,
  onClose,
  onSaved,
}: {
  invoice: Invoice;
  onClose: () => void;
  /** Handed the updated row, so the caller can swap it in without a refetch. */
  onSaved: (updated: Invoice) => void;
}) {
  const [number, setNumber] = useState(invoice.number);
  const [issueDate, setIssueDate] = useState(invoice.issue_date);
  const [amount, setAmount] = useState(invoice.amount === null ? '' : String(invoice.amount));
  const [status, setStatus] = useState<InvoiceStatus>(invoice.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = number.trim();

  // Warned about rather than blocked. Moving an invoice between months is a
  // legitimate correction — it is most of why this form exists — but it also
  // moves the invoice in the client's own month dropdown, which is the one
  // change here they will notice without being told.
  const monthMoved = issueDate.slice(0, 7) !== invoice.issue_date.slice(0, 7);

  const amountChanged =
    (amount.trim() === '' ? null : Number(amount)) !== invoice.amount;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (trimmed === '' || issueDate === '') return;
    const parsed = amount.trim() === '' ? null : Number(amount);
    if (parsed !== null && (Number.isNaN(parsed) || parsed < 0)) {
      setError('That amount is not a number we can store.');
      return;
    }

    setBusy(true);
    setError(null);

    // `.select()` on the way out, for the same reason `deleteInvoice` does it:
    // an update the RLS policy refuses comes back as a success with an empty
    // array, not as an error. Reporting "saved" over a write that never
    // happened is the failure this whole convention exists to prevent.
    const { data, error: err } = await supabase
      .from('invoices')
      .update({
        number: trimmed,
        issue_date: issueDate,
        amount: parsed,
        status,
      })
      .eq('id', invoice.id)
      .select();

    setBusy(false);

    if (err) {
      setError(errorText(err));
      return;
    }
    const saved = (data ?? [])[0] as Invoice | undefined;
    if (!saved) {
      setError(
        `Nothing was saved. Invoice ${invoice.number} may have been deleted, or is not yours to change.`,
      );
      return;
    }

    onSaved(saved);
  }

  return (
    <Modal title={`Edit invoice ${invoice.number}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="editnum">Invoice number</label>
          <input
            id="editnum"
            required
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />
          <p className="hint">
            Must still be unique for this client. Changing it changes the name of the file
            the client downloads, but not the document inside it.
          </p>
        </div>

        <div className="field">
          <label htmlFor="editdate">Invoice date</label>
          <input
            id="editdate"
            type="date"
            required
            value={issueDate}
            onChange={(e) => setIssueDate(e.target.value)}
          />
          {monthMoved ? (
            <p className="hint">
              This moves the invoice out of{' '}
              <strong>{monthLabel(invoice.issue_date)}</strong> and into{' '}
              <strong>{monthLabel(issueDate)}</strong> in the client&rsquo;s month
              dropdown, so it will stop appearing where they last saw it.
            </p>
          ) : (
            <p className="hint">The date printed on the invoice.</p>
          )}
        </div>

        <div className="row2">
          <div className="field">
            <label htmlFor="editamt">Amount (incl. taxes)</label>
            <input
              id="editamt"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="118000.00"
            />
            <p className="hint">
              In ₹. The &ldquo;Billing Amount&rdquo; line on the invoice, not the pre-tax
              total above it.
            </p>
          </div>
          <div className="field">
            <label htmlFor="editstatus">Status</label>
            <select
              id="editstatus"
              value={status}
              onChange={(e) => setStatus(e.target.value as InvoiceStatus)}
            >
              <option value="draft">Draft</option>
              <option value="issued">Issued</option>
              <option value="partially_paid">Partially paid</option>
              <option value="paid">Paid</option>
              <option value="void">Void</option>
            </select>
          </div>
        </div>

        {/* The amount on this row and the amount printed on the PDF are two
            separate assertions, and only one of them changes here. Said plainly
            because the whole point of the portal is that the figures it shows
            agree with the documents behind them. */}
        {amountChanged && invoice.amount !== null && (
          <p className="hint">
            The PDF still says {moneyExact(invoice.amount)}. Change this only to correct a
            mistyped figure — if the invoice itself was wrong, the document needs reissuing,
            not relabelling.
          </p>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn" disabled={busy || trimmed === ''}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** "August 2026" from a yyyy-mm-dd, for the two spots that name a month. */
function monthLabel(date: string): string {
  const [y, m] = date.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
}
