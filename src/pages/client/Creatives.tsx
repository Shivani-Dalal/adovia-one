import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../../auth/SessionProvider';
import { supabase, errorText } from '../../lib/supabase';
import { Card, Empty, ErrorNote, PageHead, Shell } from '../../components/Shell';
import { CreativeList, fileSize } from '../../components/CreativeList';
import { rows as asRows, type Creative } from '../../lib/types';

const MAX_BYTES = 50 * 1024 * 1024;

/** Must stay in step with the bucket's allowed_mime_types, or uploads 400. */
const ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,video/mp4,video/quicktime,application/pdf';
const ALLOWED = new Set(ACCEPT.split(','));

function extensionFor(f: File): string {
  const fromName = f.name.includes('.') ? f.name.split('.').pop()! : '';
  if (fromName && fromName.length <= 5) return fromName.toLowerCase();
  return f.type.split('/')[1] ?? 'bin';
}

/**
 * The one screen where the client writes rather than reads: artwork they want
 * Adovia to run. Uploads land in the client's own folder and RLS pins the row's
 * client_id to the caller, so there is no path from this form to another
 * client's account even with a doctored request.
 */
export default function Creatives() {
  const { client } = useSession();
  const clientId = client?.id;

  const [rows, setRows] = useState<Creative[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [files, setFiles] = useState<File[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!clientId) return;
    const { data, error: err } = await supabase
      .from('creatives')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (err) setError(errorText(err));
    else setRows(asRows<Creative>(data));
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  function pick(list: FileList | null) {
    setError(null);
    setDone(null);
    const chosen = Array.from(list ?? []);

    const bad = chosen.find((f) => !ALLOWED.has(f.type));
    if (bad) {
      setError(`${bad.name} isn't a supported type. Images, MP4, MOV and PDF only.`);
      setFiles([]);
      return;
    }
    const big = chosen.find((f) => f.size > MAX_BYTES);
    if (big) {
      setError(`${big.name} is ${fileSize(big.size)} — the limit is 50 MB per file.`);
      setFiles([]);
      return;
    }
    setFiles(chosen);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!clientId || files.length === 0) return;

    setError(null);
    setDone(null);

    // Sequential, not Promise.all: a client on an office connection uploading
    // six videos at once gets all six stalled instead of the first four done.
    // It also means a mid-batch failure has a definite boundary to report.
    let uploaded = 0;
    for (const file of files) {
      setBusy(file.name);

      const id = crypto.randomUUID();
      const path = `${clientId}/${id}.${extensionFor(file)}`;

      const up = await supabase.storage
        .from('creatives')
        .upload(path, file, { upsert: false, contentType: file.type });

      if (up.error) {
        setBusy(null);
        setError(
          `${file.name} failed to upload: ${errorText(up.error)}` +
            (uploaded > 0 ? ` (${uploaded} before it went through)` : ''),
        );
        await load();
        return;
      }

      const ins = await supabase.from('creatives').insert({
        id,
        client_id: clientId,
        title: file.name,
        note: note.trim() === '' ? null : note.trim(),
        storage_path: path,
        mime_type: file.type,
        size_bytes: file.size,
      });

      if (ins.error) {
        // Same reasoning as invoices: without the row the object is unreachable,
        // so clean it up rather than leave a file nobody can list or open.
        await supabase.storage.from('creatives').remove([path]);
        setBusy(null);
        setError(`${file.name} could not be filed: ${errorText(ins.error)}`);
        await load();
        return;
      }
      uploaded++;
    }

    setBusy(null);
    setFiles([]);
    setNote('');
    if (fileRef.current) fileRef.current.value = '';
    setDone(`${uploaded} creative${uploaded === 1 ? '' : 's'} sent to your Adovia team.`);
    await load();
  }

  if (loading) {
    return (
      <Shell>
        <div className="skeleton-page" />
      </Shell>
    );
  }

  return (
    <Shell>
      <PageHead
        title="Creatives"
        sub="Artwork you send us. Your Adovia team sees everything here against your account."
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {done && <p className="ok">{done}</p>}

      <Card title="Send new creatives">
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="creative-files">Files</label>
            <input
              id="creative-files"
              ref={fileRef}
              type="file"
              multiple
              accept={ACCEPT}
              onChange={(e) => pick(e.target.files)}
            />
            <p className="hint">
              Images, MP4, MOV or PDF, up to 50 MB each. The file name becomes the title,
              so name them the way you want to discuss them.
            </p>
          </div>

          <div className="field">
            <label htmlFor="creative-note">Note (optional)</label>
            <input
              id="creative-note"
              value={note}
              maxLength={2000}
              placeholder="Run these from Monday, replaces the June set"
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="hint">Applied to every file in this upload.</p>
          </div>

          {files.length > 0 && (
            <ul className="filelist">
              {files.map((f) => (
                <li key={f.name} className={busy === f.name ? 'uploading' : undefined}>
                  {f.name} <span className="muted">· {fileSize(f.size)}</span>
                  {busy === f.name && <span className="muted"> · uploading…</span>}
                </li>
              ))}
            </ul>
          )}

          <div className="modal-actions">
            <button className="btn" disabled={busy !== null || files.length === 0}>
              {busy
                ? 'Uploading…'
                : `Send ${files.length || ''} creative${files.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </form>
      </Card>

      <Card title={`Sent (${rows.length})`}>
        {rows.length === 0 ? (
          <Empty
            title="Nothing sent yet"
            body="Creatives you upload appear here, and stay available to both you and your Adovia team."
          />
        ) : (
          <CreativeList
            rows={rows}
            onDeleted={(c) => setRows((rs) => rs.filter((r) => r.id !== c.id))}
          />
        )}
      </Card>
    </Shell>
  );
}
