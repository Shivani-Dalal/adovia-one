import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { Modal } from '../../components/Modal';
import { campaignWriteError, nameClash } from '../../lib/campaigns';
import { rows as asRows, type Campaign, type Client } from '../../lib/types';

/**
 * Starting a campaign from the daily grid, without leaving it.
 *
 * The same insert `CampaignManager` performs, reachable from the screen ops
 * actually sits on. Splitting a client is something you discover you need at
 * the moment you are entering their figures — "PR started today and there is
 * nowhere to put it" — and making that a trip to Clients, then the client, then
 * back to the grid, on the correct date, is three chances to lose the day's
 * half-typed work. `CampaignManager` remains the place to rename and archive;
 * this is only the create.
 *
 * Deliberately not a second implementation of anything. It inserts the same two
 * columns and lets the grid reload itself, so a campaign made here and one made
 * on Client detail are the same record made the same way.
 */
export function NewCampaign({
  clients,
  initialClientId,
  hasUnattributed,
  dateLabel,
  onClose,
  onCreated,
}: {
  /** The clients on the grid, in the grid's own order. */
  clients: Client[];
  /** Preselected when opened from a client's own row group. */
  initialClientId?: string;
  /**
   * Whether this client already has figures on the open date that are not
   * attributed to any campaign. Drives the changeover warning below.
   */
  hasUnattributed: (clientId: string) => boolean;
  /** The date the grid is open on, already formatted for reading. */
  dateLabel: string;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [clientId, setClientId] = useState(initialClientId ?? clients[0]?.id ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The chosen client's existing campaigns, every status.
   *
   * Fetched here rather than passed in because the duplicate check has to see
   * paused and archived ones too. A new "PR" beside an archived "PR" is not a
   * naming inconvenience: the client's breakdown would carry two rows with one
   * label and no way to tell which is which, and the figures under each would
   * be real, so nothing about it looks like a fault.
   */
  const [existing, setExisting] = useState<Campaign[]>([]);

  useEffect(() => {
    if (!clientId) return;
    let alive = true;
    void (async () => {
      const { data, error: err } = await supabase
        .from('campaigns')
        .select('*')
        .eq('client_id', clientId)
        .order('name', { ascending: true });
      if (!alive || err) return;
      setExisting(asRows<Campaign>(data));
    })();
    return () => {
      alive = false;
    };
  }, [clientId]);

  const trimmed = name.trim();
  const clash = nameClash(existing, trimmed);
  const tooLong = trimmed.length > 120;
  const ok = trimmed !== '' && !clash && !tooLong && clientId !== '';

  /*
    The changeover case, warned about before the fact rather than discovered
    afterwards on the client's own report.

    A client whose open date already carries an unattributed row is one whose
    day is currently recorded as a single whole-day figure. Adding a campaign
    puts a second line on that date, and if ops fills it in without clearing the
    first, the day counts the whole and its parts — the client's spend for that
    day is then overstated by exactly the figure that was already correct. This
    is the one thing about splitting a live client that is not self-evident from
    the grid, so it is said here, at the moment the split is made.
  */
  const changeover = clientId !== '' && hasUnattributed(clientId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok) return;

    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from('campaigns')
      .insert({ client_id: clientId, name: trimmed });
    setBusy(false);

    if (err) {
      setError(campaignWriteError(err));
      return;
    }
    onCreated(trimmed);
  }

  return (
    <Modal title="New campaign" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="ncclient">Client</label>
          <select
            id="ncclient"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="ncname">Campaign name</label>
          <input
            id="ncname"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="PR"
          />
          <p className="hint">
            The client reads this. It is printed beside their own figures in the
            by-campaign breakdown and lands in the CSV they download, so name it the way
            you would say it to them on a call.
            {clash && (
              <strong className="warn">
                {' '}
                This client already has a campaign called &ldquo;{clash.name}&rdquo;
                {clash.status !== 'active' && ` (${clash.status})`}. Two campaigns with one
                name would show the client two rows they cannot tell apart.
              </strong>
            )}
            {tooLong && <strong className="warn"> Names are limited to 120 characters.</strong>}
          </p>
        </div>

        {existing.length === 0 && clientId !== '' && (
          <p className="hint">
            This is {clients.find((c) => c.id === clientId)?.name}&rsquo;s first campaign.
            Their history stays where it is, under &ldquo;Not split by campaign&rdquo;.
          </p>
        )}

        {changeover && (
          <p className="hint">
            <strong className="warn">Heads up:</strong> this client already has figures on{' '}
            {dateLabel} that are not attributed to a campaign. After this, that day will
            show both lines — clear the unattributed one before entering campaign figures,
            or the day will count the whole and its parts.
          </p>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || !ok}>
            {busy ? 'Creating…' : 'Create campaign'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
