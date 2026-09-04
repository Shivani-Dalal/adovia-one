import { useEffect, useState, type FormEvent } from 'react';
import { supabase, errorText } from '../../lib/supabase';
import { Modal } from '../../components/Modal';
import { businessToday, monthStart, addDays } from '../../lib/dates';
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
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<InvoiceStatus>('issued');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default the period to last full month, which is what an invoice raised
  // today almost always covers.
  useEffect(() => {
    void businessToday().then((t) => {
      const thisMonth = monthStart(t);
      setPeriodStart(monthStart(addDays(thisMonth, -1)));
      setPeriodEnd(addDays(thisMonth, -1));
    });
  }, []);

  function pickFile(f: File | null) {
    setError(null);
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
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    if (periodEnd < periodStart) {
      setError('The period ends before it starts.');
      return;
    }

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
      period_start: periodStart,
      period_end: periodEnd,
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

        <div className="field">
          <label htmlFor="invnum">Invoice number</label>
          <input
            id="invnum"
            required
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="ADV-2026-014"
          />
          <p className="hint">
            Must be unique for this client. Never reissue under an existing number — void
            the old invoice and raise a new one.
          </p>
        </div>

        <div className="row2">
          <div className="field">
            <label htmlFor="pstart">Period from</label>
            <input
              id="pstart"
              type="date"
              required
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="pend">Period to</label>
            <input
              id="pend"
              type="date"
              required
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
            />
          </div>
        </div>
        <p className="hint">
          The client&rsquo;s month dropdown groups by the start of this period, so this is
          what decides whether it files under August or September.
        </p>

        <div className="row2">
          <div className="field">
            <label htmlFor="invamt">Amount (₹)</label>
            <input
              id="invamt"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="245000.00"
            />
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
