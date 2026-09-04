import { useEffect, useState } from 'react';
import { supabase, errorText } from '../lib/supabase';
import { relativeTime, formatTimestamp } from '../lib/dates';
import type { Creative } from '../lib/types';

/** '2.4 MB' — file sizes are the one place a rounded number is fine. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function isImage(mime: string): boolean {
  return mime.startsWith('image/');
}

/**
 * Thumbnails for image creatives. The bucket is private, so a preview needs a
 * signed URL just as a download does — minted in one batch call rather than one
 * per row, and left to expire on their own. A failure here is silent: no
 * thumbnail is a cosmetic loss, and an error banner over a working list would
 * be worse than the missing picture.
 */
function useThumbnails(rows: Creative[]): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(new Map());

  // Keyed on the paths themselves so re-renders with the same rows don't re-sign.
  const key = rows.filter((r) => isImage(r.mime_type)).map((r) => r.storage_path).join('|');

  useEffect(() => {
    const paths = key === '' ? [] : key.split('|');
    if (paths.length === 0) {
      setUrls(new Map());
      return;
    }
    let alive = true;

    void supabase.storage
      .from('creatives')
      .createSignedUrls(paths, 3600)
      .then(({ data }) => {
        if (!alive || !data) return;
        const pairs: [string, string][] = [];
        for (const d of data) {
          if (d.path && d.signedUrl) pairs.push([d.path, d.signedUrl]);
        }
        setUrls(new Map(pairs));
      });

    return () => {
      alive = false;
    };
  }, [key]);

  return urls;
}

async function open(c: Creative, onError: (m: string) => void) {
  const { data, error } = await supabase.storage
    .from('creatives')
    .createSignedUrl(c.storage_path, 60, { download: c.title });

  if (error || !data?.signedUrl) {
    onError(errorText(error) || 'Could not prepare that download.');
    return;
  }
  window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
}

export function CreativeList({
  rows,
  onDeleted,
}: {
  rows: Creative[];
  /** Omit to render read-only. Admins and the owning client may both delete. */
  onDeleted?: (c: Creative) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const thumbs = useThumbnails(rows);

  async function remove(c: Creative) {
    if (!window.confirm(`Remove “${c.title}”? This cannot be undone.`)) return;
    setBusy(c.id);
    setError(null);

    // Row first this time — the row is what makes the object reachable, so
    // deleting it is the step that actually withdraws the creative. If the
    // object delete then fails, the bytes are orphaned but unreachable, which
    // is the same failure mode the upload path already tolerates.
    const del = await supabase.from('creatives').delete().eq('id', c.id);
    if (del.error) {
      setBusy(null);
      setError(errorText(del.error));
      return;
    }
    await supabase.storage.from('creatives').remove([c.storage_path]);
    setBusy(null);
    onDeleted?.(c);
  }

  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <ul className="creatives">
        {rows.map((c) => {
          const thumb = thumbs.get(c.storage_path);
          return (
            <li key={c.id} className="creative">
              <div className="creative-thumb">
                {thumb ? (
                  <img src={thumb} alt="" loading="lazy" />
                ) : (
                  <span className="creative-kind">
                    {c.mime_type.split('/')[1]?.toUpperCase() ?? 'FILE'}
                  </span>
                )}
              </div>

              <div className="creative-body">
                <div className="creative-title">{c.title}</div>
                <div className="muted sm" title={formatTimestamp(c.created_at)}>
                  {fileSize(c.size_bytes)} · added {relativeTime(c.created_at)}
                </div>
                {c.note && <p className="note sm">{c.note}</p>}
              </div>

              <div className="creative-actions">
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => void open(c, setError)}
                >
                  Download
                </button>
                {onDeleted && (
                  <button
                    type="button"
                    className="btn ghost sm danger"
                    disabled={busy === c.id}
                    onClick={() => void remove(c)}
                  >
                    {busy === c.id ? 'Removing…' : 'Remove'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
