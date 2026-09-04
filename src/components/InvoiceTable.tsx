import { useState } from 'react';
import { supabase, errorText } from '../lib/supabase';
import { deleteInvoice } from '../lib/deletion';
import { moneyExact } from '../lib/format';
import { formatDate } from '../lib/dates';
import { Modal } from './Modal';
import { InvoiceEdit } from './InvoiceEdit';
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

export function InvoiceTable({
  rows,
  onDeleted,
  onUpdated,
}: {
  rows: Invoice[];
  /**
   * Turns on the delete column. Omitted on the client's own invoice list, and
   * that omission is the access control at this layer — not a role check
   * written here.
   *
   * This table is rendered by both `client/Invoices` and `admin/ClientDetail`,
   * so the alternative was reading the session and branching inside. That would
   * put "can this person destroy an invoice" in a component whose job is to lay
   * out a table, and it would be a second answer to a question the RLS policy
   * already answers — `admin writes invoices` is what actually stops a client,
   * whatever this renders. A prop the admin page passes and the client page
   * does not keeps the two views honestly different, and a client who forges
   * their way to the button still gets refused by the database.
   *
   * Handed the invoice that went, so the caller can drop it from its own list
   * rather than refetch the page — the same shape as `onCreativeDeleted` beside
   * it in `ClientDetail`, and for the same reason: one row disappearing is not
   * worth six queries.
   */
  onDeleted?: (invoice: Invoice) => void;
  /**
   * Turns on the edit column, on the same terms as `onDeleted` above: the
   * client's own list omits it, and that omission is the access control here.
   *
   * Separate from `onDeleted` rather than one `admin` flag, because they are
   * genuinely separate permissions in the making — correcting a mistyped
   * invoice number is routine, destroying an invoice is not — and a single flag
   * would make it impossible to offer one without the other later.
   */
  onUpdated?: (invoice: Invoice) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Invoice | null>(null);
  const [editing, setEditing] = useState<Invoice | null>(null);
  /**
   * Said after a delete that worked but left the PDF behind. Kept apart from
   * `error` because it is not one: the invoice is gone, which is what was
   * asked. Rendering it through the error slot would put a red alert on a
   * successful action, and `role="status"` is the polite announcement an
   * assistive reader should get for an aside rather than a failure.
   */
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}

      {editing && (
        <InvoiceEdit
          invoice={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setEditing(null);
            setError(null);
            setNotice(`Invoice ${updated.number} was updated.`);
            onUpdated?.(updated);
          }}
        />
      )}

      {confirming && (
        <Modal title={`Delete invoice ${confirming.number}?`} onClose={() => setConfirming(null)}>
          <ConfirmDelete
            invoice={confirming}
            onBack={() => setConfirming(null)}
            onDone={(orphaned) => {
              const gone = confirming;
              setConfirming(null);
              setError(null);
              setNotice(
                orphaned
                  ? `Invoice ${gone.number} was deleted, but its PDF could not be removed from storage. Nothing links to it now, so the client cannot reach it — worth tidying up later.`
                  : `Invoice ${gone.number} and its PDF were deleted.`,
              );
              onDeleted?.(gone);
            }}
          />
        </Modal>
      )}
      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Date</th>
              {/*
                The qualifier belongs on the heading rather than in a footnote,
                because the figure underneath is what a client reconciles against
                their own ledger: "Amount" beside ₹1,18,000 invites them to read
                it as the pre-tax 1,00,000 and raise a query about the
                difference. It matches the wording on both upload and edit — the
                number an admin types under "Amount (incl. taxes)" is the number
                that prints here, and carrying the same label is what says so.
                Adovia's invoices call this line "Billing Amount"; `invoicePdf.ts`
                prefers it over "Total Amount" for exactly this reason.

                One table, both sides. Admin reads it on Client detail and the
                client reads it on Invoices, so a heading changed here cannot
                come to mean one thing to an account manager and another to the
                person they are on a call with.
              */}
              <th className="num">Amount (incl. taxes)</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.status === 'void' ? 'voided' : undefined}>
                <td className="mono">{r.number}</td>
                <td>{formatDate(r.issue_date)}</td>
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
                  {onUpdated && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setEditing(r)}
                      aria-label={`Edit invoice ${r.number}`}
                    >
                      Edit
                    </button>
                  )}
                  {onDeleted && (
                    <button
                      type="button"
                      className="btn ghost sm danger"
                      onClick={() => setConfirming(r)}
                      /*
                        Named in full for screen readers. Six identical
                        "Delete" buttons down a column is a list of controls
                        that cannot be told apart when read out of context,
                        and this is the column where guessing is expensive.
                      */
                      aria-label={`Delete invoice ${r.number}`}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {onDeleted && (
        <p className="muted mt">
          {onUpdated && (
            <>
              Edit corrects what an invoice is filed under — its number, date, amount or
              status. It does not touch the PDF, so use it when the document is right and
              the record beside it is wrong.{' '}
            </>
          )}
          Delete removes the invoice and its PDF for good. It is for an upload that
          should not have happened — the wrong file, the wrong client, a number typed
          twice. An invoice the client has actually been sent should be voided instead,
          so the document they hold still has a record here.
        </p>
      )}

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

/**
 * The confirmation, which changes its mind depending on what it is looking at.
 *
 * A draft is a document nobody outside Adovia has seen, and deleting one is
 * housekeeping. An issued or paid invoice is a record of money, quite possibly
 * sitting in a client's inbox already, and deleting it leaves this portal
 * disagreeing with a PDF somebody can still open. The database will do either
 * without complaint — nothing has a foreign key onto `invoices` — so this is
 * the only place the difference gets stated, and it is stated as a warning
 * rather than a block: reissuing under a number that is already taken is
 * impossible while the old row exists, so there are real cases where deleting a
 * genuinely issued invoice is the correct fix.
 */
function ConfirmDelete({
  invoice,
  onBack,
  onDone,
}: {
  invoice: Invoice;
  onBack: () => void;
  onDone: (orphaned: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sent = invoice.status !== 'draft';

  async function remove() {
    setBusy(true);
    setError(null);
    const { error: err, orphaned } = await deleteInvoice(invoice);
    if (err) {
      setBusy(false);
      setError(err);
      return;
    }
    // No `setBusy(false)` on the way out. The row this dialog belongs to is
    // about to disappear along with the dialog itself, and dropping the button
    // back to "Delete invoice" for the frame before that happens invites a
    // second click on an invoice that is already gone.
    onDone(orphaned);
  }

  return (
    <>
      <p>
        <strong className="warn">This cannot be undone.</strong> Invoice{' '}
        <span className="mono">{invoice.number}</span>
        {invoice.amount !== null && <> for {moneyExact(invoice.amount)}</>}, dated{' '}
        {formatDate(invoice.issue_date)}, will be removed along with its PDF. Adovia keeps
        no other copy.
      </p>

      {sent && (
        <p className="muted">
          This invoice is marked{' '}
          <strong>{INVOICE_STATUS_LABELS[invoice.status].toLowerCase()}</strong>, so the
          client may already hold a copy. Voiding it instead keeps it listed here, with
          its status visible, which is usually what you want when a real invoice was
          replaced. Delete is the right choice only if it should never have been raised.
        </p>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onBack} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn danger"
          disabled={busy}
          onClick={() => void remove()}
        >
          {busy ? 'Deleting…' : 'Delete invoice'}
        </button>
      </div>
    </>
  );
}
