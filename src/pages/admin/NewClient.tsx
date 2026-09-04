import { useState, type FormEvent } from 'react';
import { supabase, errorText } from '../../lib/supabase';
import { Modal } from '../../components/Modal';

/** Mirrors the slug CHECK constraint so the error arrives before the round trip. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function NewClient({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [vertical, setVertical] = useState('Education');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slugTouched ? slug : slugify(name);
  const slugOk = /^[a-z0-9-]{2,60}$/.test(effectiveSlug);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error: err } = await supabase.from('clients').insert({
      name: name.trim(),
      slug: effectiveSlug,
      vertical: vertical.trim() || null,
    });

    setBusy(false);
    if (err) {
      setError(errorText(err));
      return;
    }
    onCreated();
  }

  return (
    <Modal title="Add client" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="cname">Name</label>
          <input
            id="cname"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sunstone"
          />
        </div>

        <div className="field">
          <label htmlFor="cslug">Slug</label>
          <input
            id="cslug"
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            placeholder="sunstone"
          />
          <p className="hint">
            Lowercase letters, numbers and hyphens. Used in URLs, so it should not change
            once clients have links.
            {!slugOk && effectiveSlug !== '' && (
              <strong className="warn"> That slug won&rsquo;t be accepted.</strong>
            )}
          </p>
        </div>

        <div className="field">
          <label htmlFor="cvert">Vertical</label>
          <input
            id="cvert"
            value={vertical}
            onChange={(e) => setVertical(e.target.value)}
          />
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
          <button className="btn" disabled={busy || !name.trim() || !slugOk}>
            {busy ? 'Creating…' : 'Create client'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
