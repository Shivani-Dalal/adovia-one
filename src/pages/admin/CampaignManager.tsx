import { useEffect, useState, type FormEvent } from 'react';
import { supabase, errorText } from '../../lib/supabase';
import { Card, Empty, ErrorNote } from '../../components/Shell';
import { campaignWriteError, nameClash } from '../../lib/campaigns';
import { formatDate } from '../../lib/dates';
import {
  rows as asRows,
  type Campaign,
  type CampaignStatus,
  type Client,
} from '../../lib/types';

/**
 * Creating and retiring a client's campaigns.
 *
 * Admin-only, and it is configuration rather than figures: nothing here states
 * anything to the client, it decides which lines ops is asked to fill in on the
 * daily grid and which headings the client's breakdown carries. Campaign names
 * *are* client-facing copy though — they are printed beside the client's own
 * numbers and land in the CSV they download — so this is not an internal
 * labelling screen and the hint below says so.
 *
 * There is no delete on THIS screen, and that is still deliberate. Archiving is
 * the real operation for a campaign that ran: `daily_report` and `daily_actuals`
 * point at campaigns with `on delete restrict`, so the database refuses to
 * remove one that has ever carried a figure, and a delete button sitting in this
 * list would work on new campaigns and throw a foreign-key error on the ones
 * anybody cares about. Archiving takes the campaign out of tomorrow's entry grid
 * and leaves every figure already shown to the client exactly where it was.
 *
 * A campaign that carried nothing is a different thing — configuration, typed
 * wrong, wanted gone — and Manage on the daily grid deletes those, after asking
 * `lib/deletion.ts` what the campaign holds and refusing in words rather than in
 * SQL. The check is what makes the button honest, which is why it lives with the
 * check and not here.
 */

const STATUS_NOTE: Record<CampaignStatus, string> = {
  active: 'On the daily entry grid.',
  paused: 'Off the grid, but existing days stay editable.',
  archived: 'Off the grid. History kept and still shown to the client.',
};

export function CampaignManager({ client }: { client: Client }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  /** The campaign whose name is being edited, and the text so far. */
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  /*
    Both name fields are checked against the campaigns already loaded here,
    which is every status for this client. The database has the same rule as a
    unique index, so without this the only feedback would be a failed write
    after the fact — and on the rename that is worse than it sounds, because the
    name you typed is gone from the input by the time the error arrives.
  */
  const createClash = nameClash(campaigns, name);
  const renameClash = editing ? nameClash(campaigns, editing.name, editing.id) : undefined;

  async function load() {
    setLoading(true);
    const { data, error: err } = await supabase
      .from('campaigns')
      .select('*')
      .eq('client_id', client.id)
      .order('name', { ascending: true });

    if (err) setError(errorText(err));
    else setCampaigns(asRows<Campaign>(data));
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id]);

  async function create(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '' || createClash) return;

    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from('campaigns')
      .insert({ client_id: client.id, name: trimmed });
    setBusy(false);

    if (err) {
      setError(campaignWriteError(err));
      return;
    }
    setName('');
    await load();
  }

  async function rename() {
    if (!editing) return;
    const trimmed = editing.name.trim();
    if (trimmed === '' || renameClash) return;

    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from('campaigns')
      .update({ name: trimmed })
      .eq('id', editing.id);
    setBusy(false);

    if (err) {
      setError(campaignWriteError(err));
      return;
    }
    setEditing(null);
    await load();
  }

  async function setStatus(c: Campaign, status: CampaignStatus) {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from('campaigns')
      .update({ status })
      .eq('id', c.id);
    setBusy(false);

    if (err) {
      setError(errorText(err));
      return;
    }
    await load();
  }

  return (
    <Card title={`Campaigns (${campaigns.length})`}>
      <p className="muted">
        Each campaign is a line on the daily entry grid and a row in this client&rsquo;s
        breakdown. The client reads these names beside their own figures, so name one the
        way you would say it to them on a call.
      </p>

      {error && <ErrorNote>{error}</ErrorNote>}

      {loading ? (
        <div className="skeleton-page" />
      ) : campaigns.length === 0 ? (
        <Empty
          title="Not split by campaign"
          body="Figures for this client are entered as a single line. Add a campaign to start splitting them — days already recorded stay as they are and keep counting toward every total."
        />
      ) : (
        <div className="tablewrap mt">
          <table className="table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td>
                    {editing?.id === c.id ? (
                      <>
                        <input
                          className="cell wide"
                          value={editing.name}
                          maxLength={120}
                          autoFocus
                          aria-label={`Rename ${c.name}`}
                          onChange={(e) => setEditing({ id: c.id, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void rename();
                            if (e.key === 'Escape') setEditing(null);
                          }}
                        />
                        {renameClash && (
                          <p className="hint sm">
                            <strong className="warn">
                              Already used by &ldquo;{renameClash.name}&rdquo;
                              {renameClash.status !== 'active' && ` (${renameClash.status})`}.
                            </strong>{' '}
                            The client would see two rows with one name.
                          </p>
                        )}
                      </>
                    ) : (
                      c.name
                    )}
                  </td>
                  <td>
                    <span className={`pill ${c.status}`}>{c.status}</span>
                  </td>
                  <td className="daycell">{formatDate(c.created_at.slice(0, 10))}</td>
                  <td className="right cellactions">
                    {editing?.id === c.id ? (
                      <>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={busy || editing.name.trim() === '' || !!renameClash}
                          onClick={() => void rename()}
                        >
                          Save
                        </button>{' '}
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={busy}
                          onClick={() => setEditing({ id: c.id, name: c.name })}
                        >
                          Rename
                        </button>{' '}
                        {/*
                          A plain select rather than a confirm dialog. None of
                          the three states destroys anything — archiving hides a
                          campaign from tomorrow's grid and touches no figure
                          already recorded — so a modal asking "are you sure"
                          would be theatre, and the kind that trains people to
                          click through the ones that matter.
                        */}
                        <select
                          value={c.status}
                          disabled={busy}
                          aria-label={`Status of ${c.name}`}
                          onChange={(e) =>
                            void setStatus(c, e.target.value as CampaignStatus)
                          }
                        >
                          <option value="active">Active</option>
                          <option value="paused">Paused</option>
                          <option value="archived">Archived</option>
                        </select>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {campaigns.length > 0 && (
        <p className="muted mt sm">
          {(['active', 'paused', 'archived'] as const)
            .filter((s) => campaigns.some((c) => c.status === s))
            .map((s) => `${s}: ${STATUS_NOTE[s]}`)
            .join(' ')}{' '}
          A campaign that has carried a figure the client has seen cannot be deleted —
          removing it would remove that figure too. One that has never been entered
          against can be deleted from Manage on the daily entry screen.
        </p>
      )}

      <form className="row2 mt" onSubmit={create}>
        <div className="field">
          <label htmlFor="newcampaign">Add a campaign</label>
          <input
            id="newcampaign"
            value={name}
            maxLength={120}
            placeholder="Google Ads"
            onChange={(e) => setName(e.target.value)}
          />
          {createClash && (
            <p className="hint">
              <strong className="warn">
                {client.name} already has a campaign called &ldquo;{createClash.name}
                &rdquo;{createClash.status !== 'active' && ` (${createClash.status})`}.
              </strong>{' '}
              {createClash.status === 'active'
                ? 'It is already on the daily entry grid.'
                : 'It is off the grid, but the figures it carries are still in the client’s breakdown — a second one with the same name would give them two rows they cannot tell apart. Set it back to Active instead of adding a new one.'}
            </p>
          )}
        </div>
        <div className="field">
          {/* Aligns the button with the input rather than the label. */}
          <label aria-hidden="true">&nbsp;</label>
          <button className="btn" disabled={busy || name.trim() === '' || !!createClash}>
            Add campaign
          </button>
        </div>
      </form>
    </Card>
  );
}
