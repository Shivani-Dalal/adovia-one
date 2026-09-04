import { useEffect, useState } from 'react';
import { supabase, errorText } from '../../lib/supabase';
import { Modal } from '../../components/Modal';
import {
  campaignUsage,
  clientUsage,
  deleteCampaign,
  deleteClient,
  type CampaignUsage,
  type ClientUsage,
} from '../../lib/deletion';
import { rows as asRows, type Campaign, type Client } from '../../lib/types';

/**
 * Removing a campaign or a client, from the screen ops is already on.
 *
 * Both operations exist elsewhere in spirit — campaigns are configured on Client
 * detail, clients are created from the client list — but neither had a delete,
 * and the practical effect was that a mistyped client made on a Tuesday stayed
 * on the daily grid forever, quietly asking to be filled in. That is a real cost
 * on a screen whose whole job is a short list of lines to type into.
 *
 * The two deletes are presented together and behave completely differently, and
 * the difference is stated rather than smoothed over:
 *
 *   - A campaign that has never carried a figure is a piece of configuration and
 *     deleting it is nothing. One that has carried a figure cannot be deleted at
 *     all — the database refuses, because those figures are the client's — so
 *     this offers Archive instead and says why. The button is not disabled with
 *     a shrug; the panel explains the refusal before you can reach it.
 *
 *   - A client is the opposite. Every figure, invoice, creative and campaign
 *     cascades, so this is the single most destructive control in the product
 *     and it is the only one that makes you type the name. It also points at the
 *     non-destructive option, because "off the grid" is what is usually wanted
 *     and setting the client inactive does that without destroying the history.
 *
 * Confirmation happens inside this modal rather than in a second one stacked on
 * top. A dialog opened from a dialog is a dialog nobody reads.
 */

type Confirm =
  | { kind: 'campaign'; campaign: Campaign; client: Client }
  | { kind: 'client'; client: Client };

export function ManageClients({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  /** Called after something was actually removed. The parent reloads. */
  onChanged: (message: string) => void;
}) {
  const [clients, setClients] = useState<Client[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [confirm, setConfirm] = useState<Confirm | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // Fetched here rather than taken from the grid that opened this, and both
      // lists are every status rather than the active ones.
      //
      // The daily grid holds ACTIVE clients only, which is right for a grid —
      // an inactive client is one nobody is being asked to enter figures for.
      // It is exactly wrong as the list of things you may delete: the client
      // somebody wants gone is usually the one already switched off, and
      // inheriting the grid's list would have hidden precisely those and left no
      // way to tell that they existed. Same for paused and archived campaigns.
      const [cl, ca] = await Promise.all([
        supabase.from('clients').select('*').order('name', { ascending: true }),
        supabase.from('campaigns').select('*').order('name', { ascending: true }),
      ]);
      if (!alive) return;
      if (cl.error || ca.error) setError(errorText(cl.error ?? ca.error));
      else {
        setClients(asRows<Client>(cl.data));
        setCampaigns(asRows<Campaign>(ca.data));
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (confirm?.kind === 'campaign') {
    return (
      <Modal title={`Delete “${confirm.campaign.name}”?`} onClose={onClose}>
        <ConfirmCampaign
          campaign={confirm.campaign}
          client={confirm.client}
          onBack={() => setConfirm(null)}
          onDone={onChanged}
        />
      </Modal>
    );
  }

  if (confirm?.kind === 'client') {
    return (
      <Modal title={`Delete ${confirm.client.name}?`} onClose={onClose}>
        <ConfirmClient
          client={confirm.client}
          onBack={() => setConfirm(null)}
          onDone={onChanged}
        />
      </Modal>
    );
  }

  return (
    <Modal title="Manage clients and campaigns" onClose={onClose}>
      <p className="muted">
        Renaming, pausing and archiving live on each client&rsquo;s own page. This is only
        the removals — the two things that were previously impossible without opening the
        database.
      </p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="skeleton-page" />
      ) : (
        <div className="managelist mt">
          {clients.map((c) => {
            const mine = campaigns.filter((k) => k.client_id === c.id);
            return (
              <div key={c.id} className="manageclient">
                <div className="manageclient-head">
                  <strong>
                    {c.name}
                    {/* A paused or archived client is off the daily grid
                        already. Said here because it changes what "delete" is
                        for: the usual want is "stop asking me to enter this",
                        and for these it has already happened. */}
                    {c.status !== 'active' && <span className={`pill ${c.status}`}>{c.status}</span>}
                  </strong>
                  <button
                    type="button"
                    className="btn ghost sm danger"
                    onClick={() => setConfirm({ kind: 'client', client: c })}
                  >
                    Delete client
                  </button>
                </div>

                {mine.length === 0 ? (
                  <p className="muted sm">Not split by campaign.</p>
                ) : (
                  <ul className="managecamps">
                    {mine.map((k) => (
                      <li key={k.id}>
                        <span>
                          {k.name}
                          {k.status !== 'active' && (
                            <span className={`pill ${k.status}`}>{k.status}</span>
                          )}
                        </span>
                        <button
                          type="button"
                          className="btn ghost sm danger"
                          onClick={() => setConfirm({ kind: 'campaign', campaign: k, client: c })}
                        >
                          Delete
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

/**
 * The campaign panel: a count first, a button second.
 *
 * The usage query runs before anything is offered, so the destructive control
 * only ever appears on a campaign the database will actually let go. Everything
 * else gets the explanation and the archive.
 */
function ConfirmCampaign({
  campaign,
  client,
  onBack,
  onDone,
}: {
  campaign: Campaign;
  client: Client;
  onBack: () => void;
  onDone: (message: string) => void;
}) {
  const [usage, setUsage] = useState<CampaignUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { usage: u, error: err } = await campaignUsage(campaign.id);
      if (!alive) return;
      if (err) setError(err);
      else setUsage(u);
    })();
    return () => {
      alive = false;
    };
  }, [campaign.id]);

  async function remove() {
    setBusy(true);
    setError(null);
    const { error: err } = await deleteCampaign(campaign.id);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    onDone(`Campaign “${campaign.name}” deleted. It carried no figures.`);
  }

  async function archive() {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from('campaigns')
      .update({ status: 'archived' })
      .eq('id', campaign.id);
    setBusy(false);
    if (err) {
      setError(errorText(err));
      return;
    }
    onDone(`Campaign “${campaign.name}” archived. Its figures are untouched.`);
  }

  return (
    <>
      <p className="muted">
        {campaign.name} · {client.name}
      </p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {usage === null ? (
        <p className="hint mt">Checking what this campaign carries…</p>
      ) : usage.free ? (
        <p className="hint mt">
          Nothing has ever been entered against this campaign — no client-facing figures,
          no internal ones. Deleting it takes the line off the daily grid and changes no
          number anywhere. {client.name}
          &rsquo;s other campaigns and history are untouched.
        </p>
      ) : (
        <p className="hint mt">
          <strong className="warn">This campaign cannot be deleted.</strong> It carries{' '}
          {usage.report} day{usage.report === 1 ? '' : 's'} of figures {client.name} can
          read
          {usage.actuals > 0 && ` and ${usage.actuals} internal row${usage.actuals === 1 ? '' : 's'}`}
          . Deleting it would mean deleting those figures, so the database refuses — and
          that refusal is the right one. Archive it instead: it comes off tomorrow&rsquo;s
          grid and every figure already shown stays exactly where it is.
        </p>
      )}

      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onBack} disabled={busy}>
          Back
        </button>
        {usage !== null &&
          (usage.free ? (
            <button type="button" className="btn danger" disabled={busy} onClick={() => void remove()}>
              {busy ? 'Deleting…' : 'Delete campaign'}
            </button>
          ) : (
            campaign.status !== 'archived' && (
              <button type="button" className="btn" disabled={busy} onClick={() => void archive()}>
                {busy ? 'Archiving…' : 'Archive instead'}
              </button>
            )
          ))}
      </div>
    </>
  );
}

/**
 * The client panel: everything that dies, named, then the name typed back.
 *
 * The typed confirmation is not ceremony. Every other destructive thing in this
 * product is either reversible or refused by the database; this one is neither,
 * and it is reachable in two clicks from a screen people use every morning while
 * half-awake. Typing the name is the smallest gate that cannot be passed by
 * muscle memory.
 */
function ConfirmClient({
  client,
  onBack,
  onDone,
}: {
  client: Client;
  onBack: () => void;
  onDone: (message: string) => void;
}) {
  const [usage, setUsage] = useState<ClientUsage | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { usage: u, error: err } = await clientUsage(client.id);
      if (!alive) return;
      if (err) setError(err);
      else setUsage(u);
    })();
    return () => {
      alive = false;
    };
  }, [client.id]);

  const confirmed = typed.trim().toLowerCase() === client.name.trim().toLowerCase();

  async function remove() {
    if (!usage || !confirmed) return;
    setBusy(true);
    setError(null);
    const { error: err, orphaned } = await deleteClient(client, usage.files);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    onDone(
      `${client.name} deleted, with everything recorded against them.` +
        (orphaned > 0
          ? ` ${orphaned} uploaded file${orphaned === 1 ? '' : 's'} could not be removed from storage; nothing links to them.`
          : ''),
    );
  }

  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {usage === null ? (
        <p className="hint">Checking what this client holds…</p>
      ) : (
        <>
          <p className="hint">
            <strong className="warn">This deletes everything, permanently.</strong> There is
            no undo and no archive of it anywhere.
          </p>
          <ul className="killlist">
            <li>
              <strong>{usage.reportDays}</strong> day{usage.reportDays === 1 ? '' : 's'} of
              figures the client has been shown
              {usage.reportRows !== usage.reportDays && ` (${usage.reportRows} campaign rows)`}
            </li>
            <li>
              <strong>{usage.actualRows}</strong> internal actuals row
              {usage.actualRows === 1 ? '' : 's'}
            </li>
            <li>
              <strong>{usage.campaigns}</strong> campaign{usage.campaigns === 1 ? '' : 's'}
            </li>
            <li>
              <strong>{usage.invoices}</strong> invoice{usage.invoices === 1 ? '' : 's'} and{' '}
              <strong>{usage.creatives}</strong> creative
              {usage.creatives === 1 ? '' : 's'}
              {usage.files.length > 0 && `, including ${usage.files.length} uploaded file${usage.files.length === 1 ? '' : 's'}`}
            </li>
          </ul>
          <p className="hint">
            If you only want them off the daily grid, set the client to paused or archived
            on their own page instead. That keeps every figure and invoice and stops asking
            ops to fill them in — which is what &ldquo;delete&rdquo; usually means in
            practice.
          </p>
          {/*
            Stated rather than checked. RLS lets each user read only their own
            profile, so the app genuinely cannot count the logins attached to a
            client — see `lib/deletion.ts`. The database can, and will refuse
            without destroying anything, so the honest thing is to say that is
            what will happen rather than to pretend the check happened here.
          */}
          <p className="hint">
            If anyone can still sign in as this client, the database will refuse and nothing
            will be deleted. Remove their login first.
          </p>

          <div className="field mt">
            <label htmlFor="killname">
              Type <strong>{client.name}</strong> to confirm
            </label>
            <input
              id="killname"
              autoFocus
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={client.name}
            />
          </div>
        </>
      )}

      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button
          type="button"
          className="btn danger"
          disabled={busy || !confirmed || usage === null}
          onClick={() => void remove()}
        >
          {busy ? 'Deleting…' : 'Delete permanently'}
        </button>
      </div>
    </>
  );
}
