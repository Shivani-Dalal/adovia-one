import { useState, type FormEvent } from 'react';
import { supabase, errorText } from '../../lib/supabase';
import { Modal } from '../../components/Modal';
import { readInvoicePdf, type ExtractedInvoice } from '../../lib/invoicePdf';
import type { Client, InvoiceStatus } from '../../lib/types';

const MAX_BYTES = 20 * 1024 * 1024;

export function InvoiceUpload({
  client,
  onClose,
  onUploaded,
}: {
  client: Client;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [number, setNumber] = useState('');
  const [issueDate, setIssueDate] = useState('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<InvoiceStatus>('issued');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What the PDF gave up, or null before a file has been read. */
  const [read, setRead] = useState<ExtractedInvoice | null>(null);
  const [reading, setReading] = useState(false);

  /**
   * Reads the PDF and fills the form in.
   *
   * Only ever writes into fields that are still empty. Picking a second file
   * after correcting a field by hand must not quietly undo the correction — the
   * admin's typing outranks the parser, always.
   */
  async function pickFile(f: File | null) {
    setError(null);
    setRead(null);
    if (!f) {
      setFile(null);
      return;
    }
    if (f.type !== 'application/pdf') {
      setError('Invoices must be PDFs.');
      setFile(null);
      return;
    }
    if (f.size > MAX_BYTES) {
      setError('That file is over 20 MB.');
      setFile(null);
      return;
    }
    setFile(f);

    setReading(true);
    const found = await readInvoicePdf(f);
    setReading(false);
    setRead(found);

    if (found.number) setNumber((v) => (v.trim() === '' ? found.number!.value : v));
    if (found.issueDate) setIssueDate((v) => (v === '' ? found.issueDate!.value : v));
    if (found.amount) setAmount((v) => (v.trim() === '' ? String(found.amount!.value) : v));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;

    setBusy(true);
    setError(null);

    // The id is minted here, in the browser, because the storage path contains
    // it and the path has to exist before the row does.
    const id = crypto.randomUUID();
    const path = `${client.id}/${id}.pdf`;

    // Upload first, insert second. A file with no row is UNREACHABLE — the only
    // route to a download is a signed URL minted from invoices.storage_path —
    // so a failed insert costs orphaned bytes, not an exposure. The reverse
    // order produces an invoice the client can see and click and cannot
    // download, which is worse.
    const up = await supabase.storage
      .from('invoices')
      .upload(path, file, { upsert: false, contentType: 'application/pdf' });

    if (up.error) {
      setBusy(false);
      setError(errorText(up.error));
      return;
    }

    const ins = await supabase.from('invoices').insert({
      id,
      client_id: client.id,
      number: number.trim(),
      issue_date: issueDate,
      amount: amount.trim() === '' ? null : Number(amount),
      status,
      storage_path: path,
    });

    if (ins.error) {
      // The row is what makes a file reachable, so without it the object is
      // dead weight. Best effort — if this delete also fails the file is still
      // unreachable, just untidy.
      await supabase.storage.from('invoices').remove([path]);
      setBusy(false);
      setError(errorText(ins.error));
      return;
    }

    setBusy(false);
    onUploaded();
  }

  return (
    <Modal title={`Upload invoice — ${client.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="invfile">PDF</label>
          <input
            id="invfile"
            type="file"
            accept="application/pdf"
            required
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
        </div>

        {reading && (
          <p className="muted" role="status">
            Reading the PDF…
          </p>
        )}

        {read && !reading && <ReadSummary read={read} />}

        <div className="field">
          <label htmlFor="invnum">Invoice number</label>
          <input
            id="invnum"
            required
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="SGB/26-27/0007"
          />
          <p className="hint">
            Must be unique for this client. Never reissue under an existing number — void
            the old invoice and raise a new one.
          </p>
        </div>

        <div className="field">
          <label htmlFor="invdate">Invoice date</label>
          <input
            id="invdate"
            type="date"
            required
            value={issueDate}
            onChange={(e) => setIssueDate(e.target.value)}
          />
          <p className="hint">
            The date printed on the invoice. This is what the client&rsquo;s month dropdown
            groups by — an invoice dated 2 July files under July, whatever month the work
            it bills was done in.
          </p>
        </div>

        <div className="row2">
          <div className="field">
            <label htmlFor="invamt">Amount (incl. taxes)</label>
            <input
              id="invamt"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="118000.00"
            />
            <p className="hint">
              In ₹. This is the <strong>Billing Amount</strong> line on the invoice — the
              figure with GST in it, not the pre-tax &ldquo;Total&rdquo; sitting just above
              it, which is smaller and looks just as much like the answer.
            </p>
          </div>
          <div className="field">
            <label htmlFor="invstatus">Status</label>
            <select
              id="invstatus"
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

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || !file || !number.trim()}>
            {busy ? 'Uploading…' : 'Upload invoice'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * What the parser found, quoted back.
 *
 * It prints the text each value came from rather than just the value, because
 * the failure that matters is not "it read nothing" — that one is obvious from
 * an empty field — it is "it read the wrong thing convincingly". Showing that
 * the amount came from the line labelled "Billing Amount" is what lets an admin
 * catch it having taken the pre-tax total, in the second it takes to read.
 *
 * `role="status"` rather than `alert`: nothing has gone wrong. The form is
 * fully usable with every field blank, which is exactly what it was before.
 */
function ReadSummary({ read }: { read: ExtractedInvoice }) {
  const found = [read.number, read.issueDate, read.amount].filter((f) => f !== null);

  if (found.length === 0) {
    return (
      <p className="muted" role="status">
        {read.empty
          ? 'There is no text in that PDF to read — it is a scan, or artwork with the text drawn as shapes. Fill the fields in below.'
          : 'That PDF has text, but not in a layout this recognises. Fill the fields in below.'}
      </p>
    );
  }

  return (
    <div className="hint" role="status">
      <p>
        Read from the PDF — check each one against the document before uploading:
      </p>
      <ul>
        {read.number && (
          <li>
            <strong>{read.number.label}</strong> → <span className="mono">{read.number.value}</span>
          </li>
        )}
        {read.issueDate && (
          <li>
            <strong>{read.issueDate.label}</strong> → {read.issueDate.value}{' '}
            <span className="muted">(from &ldquo;{read.issueDate.source}&rdquo;)</span>
          </li>
        )}
        {read.amount && (
          <li>
            <strong>{read.amount.label}</strong> → ₹{read.amount.value.toLocaleString('en-IN')}{' '}
            <span className="muted">(from &ldquo;{read.amount.source}&rdquo;)</span>
          </li>
        )}
      </ul>
      {found.length < 3 && <p>The rest it could not find. Fill those in by hand.</p>}
    </div>
  );
}
