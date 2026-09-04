import { useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { Modal } from '../../components/Modal';
import type { Client } from '../../lib/types';

/**
 * Calls the admin-invite-client-user Edge Function. This is the one operation
 * in the app that cannot happen in the browser: it needs the service-role key
 * to create a user, and that key never leaves the function's environment.
 *
 * supabase.functions.invoke attaches the caller's JWT automatically, which is
 * what the function checks to confirm the caller is an admin.
 */
export function InviteUser({ client, onClose }: { client: Client; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { data, error: err } = await supabase.functions.invoke(
      'admin-invite-client-user',
      { body: { email: email.trim(), client_id: client.id, full_name: fullName.trim() } },
    );

    setBusy(false);

    // Non-2xx from an Edge Function arrives as a FunctionsHttpError whose body
    // holds our own message. Surfacing "Edge Function returned a non-2xx status
    // code" instead would hide the sentence we wrote for exactly this moment.
    if (err) {
      const body = await (err as { context?: Response }).context
        ?.json()
        .catch(() => null);
      setError(body?.error ?? err.message);
      return;
    }
    if ((data as { error?: string })?.error) {
      setError((data as { error: string }).error);
      return;
    }
    setDone(true);
  }

  return (
    <Modal title={`Invite a contact — ${client.name}`} onClose={onClose}>
      {done ? (
        <>
          <p>
            Invitation sent to <strong>{email.trim()}</strong>. They&rsquo;ll get a link
            that signs them in and binds their account to {client.name}.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="invemail">Email</label>
            <input
              id="invemail"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="priya@sunstone.edu.in"
            />
            <p className="hint">
              A shared inbox is fine — sign-in is by link, so there&rsquo;s no password to
              circulate. This account will see {client.name}&rsquo;s figures and nobody
              else&rsquo;s.
            </p>
          </div>

          <div className="field">
            <label htmlFor="invname">Name (optional)</label>
            <input
              id="invname"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
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
            <button className="btn" disabled={busy || !email.trim()}>
              {busy ? 'Sending…' : 'Send invitation'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
