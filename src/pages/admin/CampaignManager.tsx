import { useEffect, useState, type FormEvent } from 'react';
import { supabase, errorText } from '../../lib/supabase';
import { Card, Empty, ErrorNote } from '../../components/Shell';
import { Modal } from '../../components/Modal';
import { campaignWriteError, nameClash } from '../../lib/campaigns';
import {
  campaignMonths,
  deleteCampaign,
  deleteCampaignData,
  type CampaignMonth,
} from '../../lib/deletion';
import { formatDate, monthLabel } from '../../lib/dates';
import { count, money } from '../../lib/format';
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
 * Delete lives on this screen now, and only on ARCHIVED rows. That gate is the
 * whole design, so it is worth saying why rather than treating it as a filter.
 *
 * Archiving is still the right operation for a campaign that ran, and nothing
 * here changes that. But archiving is not always what somebody wanted: a
 * campaign created to try the importer out, or pointed at the wrong client, ends
 * up holding a month of figures that were never real, and "archived" leaves them
 * in the client's totals forever. Before this, the only way out was a hand-
 * written DELETE against production — which is the same destruction with none of
 * the counting, none of the confirmation, and no record of who did it.
 *
 * So the sequence is: archive it, which is reversible and takes it off tomorrow's
 * grid; then, if it really should not exist, delete its figures a month at a
 * time; then delete the campaign. Requiring the archive first is not ceremony —
 * it means the destructive path can only be reached from a state somebody chose
 * on purpose, and an active campaign that ops is entering figures against every
 * morning has no delete button anywhere near it.
 *
 * The two steps stay two steps. `daily_report` and `daily_actuals` point at
 * campaigns `on delete restrict`, so the database itself refuses to let the
 * campaign go while it carries anything — and rather than work around that, the
 * screen follows it: figures are destroyed as their own named, counted, typed-
 * confirmation operation, and only then does the campaign delete become
 * available. Nobody ever clicks one button and loses both.
 *
 * A campaign that carried nothing is the easy case and Manage on the daily grid
 * still deletes those directly, via the same `deleteCampaign` used here.
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
  /** The archived campaign whose delete dialog is open. */
  const [purging, setPurging] = useState<Campaign | null>(null);
  /** What the last delete did, kept after the dialog closes. */
  const [done, setDone] = useState<string | null>(null);

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
      {done && <p className="ok" role="status">{done}</p>}

      {purging && (
        <Modal title={`Delete from “${purging.name}”`} onClose={() => setPurging(null)}>
          <ConfirmCampaignPurge
            campaign={purging}
            client={client}
            onClose={() => setPurging(null)}
            onDone={(message) => {
              setDone(message);
              setPurging(null);
              void load();
            }}
          />
        </Modal>
      )}

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
                        {/*
                          Archived only. See the note at the top of this file:
                          the gate is what keeps the destructive path away from
                          the campaigns ops touches every morning.
                        */}
                        {c.status === 'archived' && (
                          <>
                            {' '}
                            <button
                              type="button"
                              className="btn ghost sm danger"
                              disabled={busy}
                              onClick={() => setPurging(c)}
                            >
                              Delete…
                            </button>
                          </>
                        )}
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
          A campaign that has carried a figure the client has seen cannot be deleted while
          it still carries one — removing it would remove that figure too. Archive it
          first; Delete then offers its figures a month at a time, and once it holds
          none, the campaign itself.
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

/**
 * The delete dialog for an archived campaign: what it holds, by month, then one
 * month of it destroyed.
 *
 * It does exactly one destructive thing per opening, and then closes. That is
 * the point of it. The obvious design keeps the dialog open after a delete and
 * offers the next step inside it — pick a month, delete, pick another, delete,
 * and now delete the campaign — which is four irreversible acts performed with
 * accumulating momentum by somebody who has already decided. Closing returns
 * them to the list, where the campaign is visibly different from a moment ago,
 * and makes them choose again from a screen that has been updated by what they
 * just did.
 *
 * The month dropdown offers "every month" as well, and that option is not a
 * shortcut past the same care: it is the one an admin should pick when the whole
 * campaign was a mistake, and picking it shows the summed cost of all of it
 * before the name has to be typed.
 */
function ConfirmCampaignPurge({
  campaign,
  client,
  onClose,
  onDone,
}: {
  campaign: Campaign;
  client: Client;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [months, setMonths] = useState<CampaignMonth[] | null>(null);
  /** 'YYYY-MM', or null for every month. */
  const [month, setMonth] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { months: m, error: err } = await campaignMonths(campaign.id);
      if (!alive) return;
      if (err) setError(err);
      else {
        setMonths(m);
        // The newest month, not "everything". A dialog that opens with the most
        // destructive option already chosen is one Enter key from taking the
        // lot, and the default should be the smaller of the two mistakes.
        setMonth(m.length > 0 ? m[0].month : null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [campaign.id]);

  const holdsNothing = months !== null && months.length === 0;
  const chosen = months === null ? [] : month === null ? months : months.filter((m) => m.month === month);

  const sum = chosen.reduce(
    (a, m) => ({
      reportRows: a.reportRows + m.reportRows,
      reportDays: a.reportDays + m.reportDays,
      actualRows: a.actualRows + m.actualRows,
      // Stays null unless a month states a figure — the same rule every total
      // in this product follows.
      spend: m.spend === null ? a.spend : (a.spend ?? 0) + m.spend,
      clientNotes: a.clientNotes + m.clientNotes,
      internalNotes: a.internalNotes + m.internalNotes,
    }),
    {
      reportRows: 0,
      reportDays: 0,
      actualRows: 0,
      spend: null as number | null,
      clientNotes: 0,
      internalNotes: 0,
    },
  );

  const confirmed = typed.trim().toLowerCase() === campaign.name.trim().toLowerCase();
  const notes = sum.clientNotes + sum.internalNotes;
  const scopeLabel = month === null ? 'every month' : monthLabel(month);

  async function purge() {
    if (!confirmed || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    const res = await deleteCampaignData(campaign.id, month);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    onDone(
      `Deleted ${res.reportRows} row${res.reportRows === 1 ? '' : 's'} of figures from “${campaign.name}” for ${scopeLabel}` +
        (res.actualRows > 0 ? `, and ${res.actualRows} internal actuals row${res.actualRows === 1 ? '' : 's'}` : '') +
        `. ${client.name}’s totals for ${scopeLabel} have changed.`,
    );
  }

  async function removeCampaign() {
    setBusy(true);
    setError(null);
    const { error: err } = await deleteCampaign(campaign.id);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    onDone(`Campaign “${campaign.name}” deleted.`);
  }

  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {months === null ? (
        <p className="hint">Checking what this campaign holds…</p>
      ) : holdsNothing ? (
        <>
          <p className="hint">
            <strong>“{campaign.name}” holds no figures.</strong> Nothing has been recorded
            against it, so deleting it takes nothing with it and changes no total{' '}
            {client.name} has been shown.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => void removeCampaign()}
            >
              {busy ? 'Deleting…' : 'Delete campaign'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="hint">
            <strong className="warn">This destroys figures the client has already seen.</strong>{' '}
            There is no undo, and no copy of them anywhere in this app. Their spend report
            for the month you choose will change the moment this runs.
          </p>

          <div className="field mt">
            <label htmlFor="purge-month">Delete figures for</label>
            <select
              id="purge-month"
              value={month ?? ''}
              disabled={busy}
              onChange={(e) => setMonth(e.target.value === '' ? null : e.target.value)}
            >
              {months.map((m) => (
                <option key={m.month} value={m.month}>
                  {monthLabel(m.month)} —{' '}
                  {/*
                    A month can hold internal actuals and no report rows at all,
                    in which case "0 days" is both true and useless. Say what is
                    actually there instead.
                  */}
                  {m.reportDays > 0
                    ? `${m.reportDays} day${m.reportDays === 1 ? '' : 's'}`
                    : `${m.actualRows} internal row${m.actualRows === 1 ? '' : 's'}`}
                </option>
              ))}
              {/*
                Last, and named for what it does rather than "All". A list whose
                final entry is the total one is the shape people scan; a first
                entry reading "All months" is the one they land on by reflex.
              */}
              {months.length > 1 && <option value="">Every month — the whole campaign</option>}
            </select>
          </div>

          <ul className="killlist">
            <li>
              <strong>{sum.reportDays}</strong> day{sum.reportDays === 1 ? '' : 's'} of figures{' '}
              {client.name} has been shown
              {sum.reportRows !== sum.reportDays && ` (${sum.reportRows} rows)`}
            </li>
            <li>
              {sum.spend === null ? (
                <>
                  <strong>No spend</strong> is stated across those days
                </>
              ) : (
                <>
                  <strong>{money(sum.spend)}</strong> of recorded spend
                </>
              )}
            </li>
            {sum.actualRows > 0 && (
              <li>
                <strong>{count(sum.actualRows)}</strong> internal actuals row
                {sum.actualRows === 1 ? '' : 's'}
              </li>
            )}
            {notes > 0 && (
              <li>
                {/*
                  Called out on its own line even though it is the smallest
                  number here. Figures came from a sheet and can be imported
                  again; a note was typed once, by somebody who knew something
                  that day, and this app holds the only copy.
                */}
                <strong className="warn">
                  {notes} note{notes === 1 ? '' : 's'}
                </strong>{' '}
                written on those days
                {sum.clientNotes > 0 && sum.internalNotes > 0
                  ? ` (${sum.clientNotes} the client can read, ${sum.internalNotes} internal)`
                  : sum.clientNotes > 0
                    ? ' the client can read'
                    : ' internal'}
                . Nothing else holds a copy.
              </li>
            )}
          </ul>

          {month !== null && months.length > 1 && (
            <p className="hint sm">
              The campaign&rsquo;s other {months.length - 1} month
              {months.length - 1 === 1 ? '' : 's'} are untouched, and the campaign itself stays.
              Delete every month before the campaign can go.
            </p>
          )}

          <p className="hint sm">
            If you only want this off the daily grid, it already is — archived campaigns are
            not asked for. Deleting is for figures that should never have been recorded.
          </p>

          <div className="field mt">
            <label htmlFor="purge-name">
              Type <strong>{campaign.name}</strong> to confirm
            </label>
            <input
              id="purge-name"
              autoFocus
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={campaign.name}
            />
          </div>

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={busy || !confirmed}
              onClick={() => void purge()}
            >
              {busy ? 'Deleting…' : `Delete ${scopeLabel} permanently`}
            </button>
          </div>
        </>
      )}
    </>
  );
}
