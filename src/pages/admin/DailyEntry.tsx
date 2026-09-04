import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useBlocker, type BlockerFunction } from 'react-router-dom';
import { supabase, errorText } from '../../lib/supabase';
import { useSession } from '../../auth/SessionProvider';
import { Card, Empty, ErrorNote, PageHead, Shell } from '../../components/Shell';
import { Modal } from '../../components/Modal';
import { byField, isBadFigure, parseFigure, toInput } from '../../lib/format';
import { addDays, businessToday, formatDateLong, formatDate, type ISODate } from '../../lib/dates';
import {
  buildBaselines,
  findOutliers,
  WINDOW_DAYS,
  type Baselines,
  type Outlier,
} from '../../lib/outliers';
import { sumStated } from '../../lib/campaigns';
import { NewCampaign } from './NewCampaign';
import { ManageClients } from './ManageClients';
import { ImportSheet } from './ImportSheet';
import {
  ACTUAL_FIELDS,
  ACTUAL_SHORT,
  REPORT_COLS,
  REPORT_FIELDS,
  REPORT_LABELS,
  UNATTRIBUTED,
  rows as asRows,
  type ActualField,
  type Campaign,
  type Client,
  type DailyReport,
  type DailyActuals,
  type ReportField,
} from '../../lib/types';

/**
 * The columns ops actually types into the client-facing grid — the four figures
 * a client is shown, and nothing else.
 *
 * `clicks`, `leads`, `admissions` and `projected_impressions` are deliberately
 * absent. They were being entered every working day and read by no one: no
 * client screen renders them, and the two that mattered internally now live in
 * the actuals grid below, where they are private by policy rather than by
 * omission. The columns remain in the database and in history, so nothing
 * already recorded is lost or rewritten — they are simply no longer asked for.
 */
const HEADS: { field: ReportField; short: string }[] = [
  { field: 'ad_spend', short: 'Spend ₹' },
  { field: 'impressions', short: 'Impr.' },
  { field: 'projected_leads', short: 'Proj. leads' },
  { field: 'projected_admissions', short: 'Proj. adm.' },
];

type CellState = Record<ReportField, string>;
type ActualState = Record<ActualField, string>;

/**
 * One line of the grid: a client's campaign on this date, not a client.
 *
 * The grain changed when campaigns arrived. Ops types one line per campaign and
 * the client's figure for the day is their sum, computed for display and never
 * saved — see `lib/campaigns.ts` for why the total is derived rather than a
 * column. A client with no campaigns still gets exactly one line, with
 * `campaign` null, and behaves precisely as it did before; that is the same
 * unattributed row the client's history is already full of.
 */
interface RowState {
  client: Client;
  /** Null for the unattributed line — a client that is not split by campaign. */
  campaign: Campaign | null;
  /** `clientId:campaignId`, the identity every setter matches on. */
  key: string;

  /** The row as it exists in the database, or null if today has no row yet. */
  saved: DailyReport | null;
  values: CellState;
  /** True when values came from yesterday rather than from a saved row. */
  draft: boolean;
  note: string;

  /** Adovia's own measurements for the day. Never leaves the admin side. */
  savedActuals: DailyActuals | null;
  actuals: ActualState;
  /** The internal line about the measurement. Its own field, not part of
      `actuals`, because that record is figures and this is prose. */
  actualNote: string;
}

/** The identity of a grid line, and of a `(client, campaign, date)` row. */
function rowKey(clientId: string, campaignId: string | null): string {
  return `${clientId}:${campaignId ?? ''}`;
}

const EMPTY: CellState = {
  ad_spend: '',
  impressions: '',
  clicks: '',
  leads: '',
  admissions: '',
  projected_impressions: '',
  projected_leads: '',
  projected_admissions: '',
};

const EMPTY_ACTUALS: ActualState = {
  impressions: '',
  leads: '',
  admissions: '',
};

function cellsFrom(m: Partial<DailyReport>): CellState {
  return REPORT_FIELDS.reduce((acc, f) => {
    acc[f] = toInput(m[f] as number | null | undefined);
    return acc;
  }, {} as CellState);
}

function actualsFrom(a: DailyActuals | null): ActualState {
  if (!a) return EMPTY_ACTUALS;
  return ACTUAL_FIELDS.reduce((acc, f) => {
    acc[f] = toInput(a[f]);
    return acc;
  }, {} as ActualState);
}

/** True when the client-facing figures and note are untouched. */
function reportUnchanged(r: RowState): boolean {
  if (!r.saved) return Object.values(r.values).every((v) => v.trim() === '');
  const noteSame = (r.saved.client_note ?? '') === r.note;
  return noteSame && REPORT_FIELDS.every((f) => r.values[f] === toInput(r.saved![f]));
}

/** True when Adovia's own measurements and the note on them are untouched. */
function actualsUnchanged(r: RowState): boolean {
  // A note with no figures is still a row worth saving: "platform reported
  // nothing all day" is a measurement result, and requiring a number beside it
  // would push ops to type a 0 — which this codebase spends its whole effort
  // keeping distinct from "not measured".
  if (!r.savedActuals) {
    return Object.values(r.actuals).every((v) => v.trim() === '') && r.actualNote.trim() === '';
  }
  return (
    (r.savedActuals.note ?? '') === r.actualNote &&
    ACTUAL_FIELDS.every((f) => r.actuals[f] === toInput(r.savedActuals![f]))
  );
}

function sameAsSaved(r: RowState): boolean {
  return reportUnchanged(r) && actualsUnchanged(r);
}

/**
 * The three ways off this screen that destroy typed figures, and each one is
 * caught by a different mechanism because each is a different kind of event.
 *
 * `date` is state — the pager just calls `setDate`, and `goToDate` intercepts it.
 * `route` is a navigation, held open by the router's blocker. `signout` is
 * neither: it clears the session and `Protected` swaps the login screen in where
 * it stands, so the URL never changes and nothing but the button itself can
 * notice. One dialog serves all three, and this is what tells it which happened.
 */
type Exit = { kind: 'date'; date: ISODate } | { kind: 'route' } | { kind: 'signout' };

export default function DailyEntry() {
  const { signOut } = useSession();
  const [date, setDate] = useState<ISODate | null>(null);
  const [maxDate, setMaxDate] = useState<ISODate | null>(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const [baselines, setBaselines] = useState<Baselines>(new Map());
  /** Non-null while the guard is holding a save open for confirmation. */
  const [queried, setQueried] = useState<Outlier[] | null>(null);
  const [addingCampaign, setAddingCampaign] = useState(false);
  const [managing, setManaging] = useState(false);
  const [importing, setImporting] = useState(false);
  /** The day the pager is trying to reach, held open while the discard is confirmed. */
  const [leaving, setLeaving] = useState<ISODate | null>(null);
  /** True while a sign out is held open for the same confirmation. */
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    void businessToday().then((t) => {
      setMaxDate(t);
      setDate((d) => d ?? t);
    });
  }, []);

  const load = useCallback(async (d: ISODate) => {
    setLoading(true);
    setError(null);
    setSaved(null);

    const [clientsRes, campaignsRes, todayRes, prevRes, windowRes, actualsRes] =
      await Promise.all([
      supabase
        .from('clients')
        .select('*')
        .eq('status', 'active')
        .order('name', { ascending: true }),
      // Every campaign, not just the active ones. A paused or archived campaign
      // that already has a row for this date must still be editable — ops
      // correcting last Tuesday's figure should not be blocked because the
      // campaign was archived on Wednesday. Which of them get a line is decided
      // below; this query just makes sure none of them are invisible.
      supabase
        .from('campaigns')
        .select('*')
        .order('name', { ascending: true }),
      supabase.from('daily_report').select(REPORT_COLS).eq('date', d),
      // The previous day, for prefill. One query for every client rather than
      // one per client — this grid is the thing that has to feel instant or the
      // entry stops happening.
      supabase.from('daily_report').select(REPORT_COLS).eq('date', addDays(d, -1)),
      // The trailing fortnight, for the typo guard's sense of normal. Fetched
      // up front rather than on Save: ops pressing Save should not then wait on
      // a network round trip to find out the number was fine.
      supabase
        .from('daily_report')
        .select(REPORT_COLS)
        .gte('date', addDays(d, -WINDOW_DAYS))
        .lt('date', d),
      supabase.from('daily_actuals').select('*').eq('date', d),
    ]);

    if (
      clientsRes.error ||
      campaignsRes.error ||
      todayRes.error ||
      prevRes.error ||
      actualsRes.error
    ) {
      setError(
        errorText(
          clientsRes.error ??
            campaignsRes.error ??
            todayRes.error ??
            prevRes.error ??
            actualsRes.error,
        ),
      );
      setLoading(false);
      return;
    }

    // A failed baseline query is not a failed load. Losing the guard degrades
    // the grid to how it behaved yesterday; blocking entry over it would stop
    // the one thing this page exists to do.
    setBaselines(windowRes.error ? new Map() : buildBaselines(asRows<DailyReport>(windowRes.data)));

    const clients = asRows<Client>(clientsRes.data);
    const campaigns = asRows<Campaign>(campaignsRes.data);

    // Keyed by client *and* campaign now. Keying on the client alone would make
    // every campaign of a client collide into one entry, so the last row of the
    // fetch would win and the rest would silently vanish from the grid.
    const todayRows = asRows<DailyReport>(todayRes.data);
    const byKeyToday = new Map(
      todayRows.map((m) => [rowKey(m.client_id, m.campaign_id), m]),
    );
    const byKeyPrev = new Map(
      asRows<DailyReport>(prevRes.data).map((m) => [rowKey(m.client_id, m.campaign_id), m]),
    );
    const actualRows = asRows<DailyActuals>(actualsRes.data);
    const byKeyActuals = new Map(
      actualRows.map((a) => [rowKey(a.client_id, a.campaign_id), a]),
    );

    /**
     * Which lines a client gets today.
     *
     * Active campaigns, plus any campaign that already has a row for this date
     * whatever its status, plus the unattributed line when the client has no
     * campaigns at all or already has an unattributed row. The second and third
     * clauses are what stop the grid from hiding a figure that exists: a line
     * that is absent cannot be corrected, and ops would have no way to tell the
     * difference between "no figure" and "figure we won't show you".
     */
    function slotsFor(clientId: string): (Campaign | null)[] {
      const mine = campaigns.filter((c) => c.client_id === clientId);
      const entered = new Set(
        [...todayRows, ...actualRows]
          .filter((r) => r.client_id === clientId)
          .map((r) => r.campaign_id),
      );

      const slots: (Campaign | null)[] = mine.filter(
        (c) => c.status === 'active' || entered.has(c.id),
      );
      if (mine.length === 0 || entered.has(null)) slots.push(null);
      return slots;
    }

    setRows(
      clients.flatMap((c) =>
        slotsFor(c.id).map((campaign): RowState => {
          const key = rowKey(c.id, campaign?.id ?? null);
          const savedActuals = byKeyActuals.get(key) ?? null;
          const today = byKeyToday.get(key) ?? null;
          if (today) {
            return {
              client: c,
              campaign,
              key,
              saved: today,
              values: cellsFrom(today),
              draft: false,
              note: today.client_note ?? '',
              savedActuals,
              actuals: actualsFrom(savedActuals),
              actualNote: savedActuals?.note ?? '',
            };
          }
          const prev = byKeyPrev.get(key);
          return {
            client: c,
            campaign,
            key,
            saved: null,
            savedActuals,
            // Never prefilled from yesterday. Actuals are measurements, and the
            // rule that keeps ops honest about the client-facing figures applies
            // with more force to the numbers Adovia checks itself against.
            actuals: actualsFrom(savedActuals),
            // Nor is the note, for the same reason and a sharper one: yesterday's
            // explanation of yesterday's number, sitting under today's, is a
            // caption attached to the wrong photograph.
            actualNote: savedActuals?.note ?? '',
            // Prefill only the projections, and only from the same campaign's
            // own previous day — `byKeyPrev` is keyed on the campaign, so a PR
            // line never inherits the Google line's forecast. Copying
            // yesterday's *actuals* forward would put a plausible spend figure
            // in front of ops on a day nobody has checked, and one distracted
            // Save publishes it as fact. Projections move slowly and are a
            // stated intention, so carrying them is a genuine convenience;
            // actuals are measurements and must be typed.
            values: prev
              ? {
                  ...EMPTY,
                  projected_impressions: toInput(prev.projected_impressions),
                  projected_leads: toInput(prev.projected_leads),
                  projected_admissions: toInput(prev.projected_admissions),
                }
              : EMPTY,
            draft: Boolean(
              prev &&
                (prev.projected_impressions !== null ||
                  prev.projected_leads !== null ||
                  prev.projected_admissions !== null),
            ),
            note: '',
          };
        }),
      ),
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    if (date) void load(date);
  }, [date, load]);

  const dirty = useMemo(() => rows.filter((r) => !sameAsSaved(r)), [rows]);

  /**
   * The rows somebody actually typed into — a different question from `dirty`,
   * and the one to ask before throwing work away.
   *
   * `dirty` means "Save would write this", and it is right that a prefilled row
   * counts: carrying yesterday's projections forward and pressing Save is the
   * entire point of the prefill. But nothing is *lost* when a prefilled row is
   * abandoned, because returning to this date rebuilds it identically from the
   * same previous day. Warning about those would fire the confirmation below on
   * every step of the pager for most clients, and a confirmation that appears
   * when there is nothing to lose is how people learn to dismiss the one that
   * matters.
   *
   * The exclusion has to name all three ways a prefilled row can pick up typed
   * content, because only the first of them clears `draft`: that flag drives the
   * "prefilled" tag beside the figures and has to keep meaning "these came from
   * yesterday", so `setNote` and `setActual` leave it alone on purpose.
   */
  const typed = useMemo(
    () =>
      rows.filter((r) => !sameAsSaved(r) && !(r.draft && r.note === '' && actualsUnchanged(r))),
    [rows],
  );

  /**
   * How many rows have pending edits in the ACTUALS half specifically.
   *
   * Not `dirty.length`. A row is dirty if either half changed, so the savebar's
   * count answers "how many lines will be written" across both tables — the
   * right question for a button that writes both. The actuals card lid is
   * asking something narrower: is there anything unsaved *inside the thing I am
   * folding away*. Using the wider count there would put "3 unsaved rows" on a
   * collapsed card whose grid is untouched, and the reader would open it
   * looking for edits that are in the client-facing grid behind them.
   *
   * The predicate is the same one `save()` uses to decide what goes to
   * `daily_actuals`, so the lid cannot disagree with what the button does.
   */
  const dirtyActuals = useMemo(() => rows.filter((r) => !actualsUnchanged(r)).length, [rows]);

  /**
   * The clients that have more than one line today.
   *
   * Only these get a campaign column, a grouping header and a derived total
   * row. A client with a single line is rendered exactly as it was before
   * campaigns existed — one row, the client's name, no total restating the one
   * number directly above it. Most clients are in that case and should not pay
   * for a feature they don't use.
   */
  const split = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.client.id, (counts.get(r.client.id) ?? 0) + 1);
    return new Set([...counts].filter(([, n]) => n > 1).map(([id]) => id));
  }, [rows]);

  /**
   * A colour band per client, keyed by the order they appear on the grid.
   *
   * By position, not by hashing the id. A hash gives a client the same colour
   * forever, which sounds better and is worse: it also, sooner or later, gives
   * two clients that sit next to each other the same one, and two adjacent
   * groups in one hue is precisely the confusion the bands exist to remove.
   * Cycling by position guarantees neighbours differ, and the colour is only
   * ever read against the client's name a few rows up — it never has to mean
   * anything on its own, so it does not need to be stable across days.
   *
   * Five is the number of hues defined in the stylesheet; see `--band-1`.
   */
  const bands = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) if (!m.has(r.client.id)) m.set(r.client.id, (m.size % 5) + 1);
    return m;
  }, [rows]);
  // Both grids gate the one Save button. A mistyped actual is as good a reason
  // to hold the save as a mistyped client figure — they go up in the same click.
  const invalid = useMemo(
    () =>
      rows.some(
        (r) =>
          REPORT_FIELDS.some((f) => isBadFigure(r.values[f])) ||
          ACTUAL_FIELDS.some((f) => isBadFigure(r.actuals[f])),
      ),
    [rows],
  );

  // Leaving with unsaved figures is the failure mode of a grid with one Save.
  useEffect(() => {
    if (dirty.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty.length]);

  /**
   * Every route to another day goes through here.
   *
   * The listener above only fires when the BROWSER leaves the page — closing the
   * tab, reloading, typing a URL. Changing the date does none of those things:
   * it sets state, the effect below refetches, and `setRows` replaces the typed
   * figures with whatever the server holds. No prompt, no diff, no undo — and
   * because `load` also clears `saved`, what is left looks like an ordinary
   * fresh day, so nothing even hints that something was lost.
   *
   * The pager sits inches from the grid being typed into, which makes it the
   * exit somebody actually takes by accident.
   */
  function goToDate(next: ISODate) {
    if (typed.length > 0) setLeaving(next);
    else setDate(next);
  }

  /**
   * The other way off this screen: the header links, and the back button.
   *
   * Those are route changes rather than state changes, so `goToDate` never sees
   * them and `beforeunload` never fires for them. `useBlocker` holds the
   * navigation open — it is why `App` builds a data router — and the same dialog
   * asks the same question, rather than inventing a second one that means it.
   *
   * Compared on pathname, not on the whole location. A navigation to the route
   * already showing is not somebody leaving, and blocking one would put a
   * discard prompt in front of a person who pressed nothing.
   *
   * Sign out is not covered here and cannot be: `signOut` clears the session and
   * `Protected` swaps in the login screen where it stands, without ever changing
   * route, so there is no navigation for this to see. That exit is caught at the
   * button instead — see the `unsaved` prop passed to `Shell` below.
   */
  const blocker = useBlocker(
    useCallback<BlockerFunction>(
      ({ currentLocation, nextLocation }) =>
        typed.length > 0 && currentLocation.pathname !== nextLocation.pathname,
      [typed.length],
    ),
  );

  // All four match on the row key, not the client id. Matching on the client
  // would write one keystroke into every campaign of that client at once.
  function setCell(key: string, field: ReportField, raw: string) {
    setRows((rs) =>
      rs.map((r) =>
        r.key === key ? { ...r, values: { ...r.values, [field]: raw }, draft: false } : r,
      ),
    );
    setSaved(null);
  }

  function setActual(key: string, field: ActualField, raw: string) {
    setRows((rs) =>
      rs.map((r) => (r.key === key ? { ...r, actuals: { ...r.actuals, [field]: raw } } : r)),
    );
    setSaved(null);
  }

  function setNote(key: string, raw: string) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, note: raw } : r)));
    setSaved(null);
  }

  function setActualNote(key: string, raw: string) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, actualNote: raw } : r)));
    setSaved(null);
  }

  /**
   * Arrow keys walk the grid; Enter moves down. Tab is left to the browser.
   *
   * Scoped to whichever table the focused cell is in, and stepping by that
   * table's own column count, so the two grids navigate independently. A single
   * ref over one table would have left the actuals grid keyboard-dead, which for
   * a column of figures typed in sequence is most of the usability.
   */
  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    const keys = ['ArrowUp', 'ArrowDown', 'Enter'];
    if (!keys.includes(e.key)) return;
    const table = e.currentTarget.closest('table');
    if (!table) return;
    const cols = Number(table.getAttribute('data-cols'));
    if (!cols) return;
    const inputs = Array.from(table.querySelectorAll<HTMLInputElement>('input[data-cell]'));
    const i = inputs.indexOf(e.currentTarget);
    if (i < 0) return;
    const next = e.key === 'ArrowUp' ? i - cols : i + cols;
    if (next >= 0 && next < inputs.length) {
      e.preventDefault();
      inputs[next].focus();
      inputs[next].select();
    }
  }

  /**
   * Save goes through the guard first. It only ever asks a question — every
   * outlier is still savable, because ops is the one who knows whether a client
   * genuinely spent ten times more yesterday. A guard that could block would be
   * a guard ops learns to route around.
   */
  function attemptSave() {
    if (!date || dirty.length === 0) return;

    const found = findOutliers(
      dirty.map((r) => ({
        clientId: r.client.id,
        clientName: r.client.name,
        campaignId: r.campaign?.id ?? null,
        // Null when the client isn't split, so the modal says "Jaro · Ad spend"
        // rather than "Jaro · Not split by campaign · Ad spend" for the many
        // clients that have no campaigns and never will. When the client *is*
        // split, the unattributed line is named — on those clients "which line
        // was this?" is a real question.
        campaignName: r.campaign
          ? r.campaign.name
          : split.has(r.client.id)
            ? UNATTRIBUTED
            : null,
        values: REPORT_FIELDS.reduce(
          (acc, f) => ({ ...acc, [f]: parseFigure(r.values[f]) }),
          {} as Record<ReportField, number | null>,
        ),
        saved: r.saved,
      })),
      baselines,
    );

    if (found.length > 0) {
      setQueried(found);
      return;
    }
    void commit();
  }

  async function commit() {
    if (!date || dirty.length === 0) return;
    setQueried(null);
    setSaving(true);
    setError(null);

    // The two grids are written separately, and each only for the rows that
    // actually changed in it. Sending every dirty row to both tables would mean
    // recording an internal measurement silently publishes a client-facing row
    // for that day — turning a private note into a page the client can load.
    const reportRows = dirty.filter((r) => !reportUnchanged(r));
    const actualRows = dirty.filter((r) => !actualsUnchanged(r));

    // One upsert for the whole grid. `onConflict` names (client_id, campaign_id,
    // date) because that is the unique key now, and it is what makes re-saving a
    // corrected figure an UPDATE — which is also what fires the history trigger.
    // An insert-or-skip would lose the audit trail. The old two-column target
    // does not merely mis-target here, it fails outright: Postgres refuses an
    // ON CONFLICT whose columns match no unique constraint.
    const payload = reportRows.map((r) => ({
      ...(r.saved ? { id: r.saved.id } : {}),
      client_id: r.client.id,
      campaign_id: r.campaign?.id ?? null,
      date,
      ...REPORT_FIELDS.reduce(
        (acc, f) => ({ ...acc, [f]: parseFigure(r.values[f]) }),
        {} as Record<ReportField, number | null>,
      ),
      client_note: r.note.trim() === '' ? null : r.note.trim(),
    }));

    const actualsPayload = actualRows.map((r) => ({
      ...(r.savedActuals ? { id: r.savedActuals.id } : {}),
      client_id: r.client.id,
      campaign_id: r.campaign?.id ?? null,
      date,
      ...ACTUAL_FIELDS.reduce(
        (acc, f) => ({ ...acc, [f]: parseFigure(r.actuals[f]) }),
        {} as Record<ActualField, number | null>,
      ),
      // Empty becomes null, matching client_note. An empty string would be a
      // note that exists and says nothing, which reads as "" in every export and
      // sorts as present in every query.
      note: r.actualNote.trim() === '' ? null : r.actualNote.trim(),
    }));

    // Sequential, not parallel, and reports first. If the second write fails the
    // grid reloads showing exactly which half landed; running them together
    // would leave ops guessing which table to re-check.
    const reportRes = payload.length
      ? await supabase
          .from('daily_report')
          .upsert(payload, { onConflict: 'client_id,campaign_id,date' })
      : null;

    const actualsRes =
      !reportRes?.error && actualsPayload.length
        ? await supabase
            .from('daily_actuals')
            .upsert(actualsPayload, { onConflict: 'client_id,campaign_id,date' })
        : null;

    setSaving(false);

    const err = reportRes?.error ?? actualsRes?.error;
    if (err) {
      setError(errorText(err));
      // Reload anyway: a partial save is still a save, and the grid must show
      // what is now in the database rather than what ops hoped to put there.
      await load(date);
      return;
    }

    // "Lines", not "clients". One client can contribute several rows now, and
    // reporting "1 client" after saving four campaigns would understate what
    // just went out to them.
    const parts: string[] = [];
    if (payload.length) parts.push(`${payload.length} line${payload.length === 1 ? '' : 's'}`);
    if (actualsPayload.length) parts.push(`${actualsPayload.length} actuals`);
    setSaved(`Saved ${parts.join(' and ')}.`);
    await load(date);
  }

  if (!date || loading) {
    return (
      // No `unsaved` here, deliberately. This branch renders no dialog, so a
      // guard on the sign out button would have nothing to show and the button
      // would do nothing at all when pressed. Unguarded is the safe shape: the
      // only route into this branch is a load, and a load is reached either from
      // a first mount or from a discard that has already been confirmed.
      <Shell>
        <div className="skeleton-page" />
      </Shell>
    );
  }

  const isToday = date === maxDate;

  return (
    <Shell unsaved={{ count: typed.length, ask: () => setSigningOut(true) }}>
      <PageHead
        title="Daily entry"
        sub={
          <>
            {formatDateLong(date)}
            {!isToday && maxDate && (
              <>
                {' '}
                ·{' '}
                <button type="button" className="linkish" onClick={() => goToDate(maxDate)}>
                  Back to today
                </button>
              </>
            )}
          </>
        }
        actions={
          <div className="datepager">
            {/*
              Beside the date pager rather than inside the grid. Splitting a
              client is configuration, not a figure, and a control that adds a
              row sitting among the rows it adds invites a mis-click on a screen
              whose whole job is typing numbers accurately.
            */}
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setAddingCampaign(true)}
              disabled={rows.length === 0}
            >
              New campaign
            </button>
            {/*
              Removals live behind their own button rather than on the rows
              themselves. A delete control inside a grid of inputs is one
              mis-click away from a destroyed account, and the things it removes
              — a client, a campaign — are not things anyone removes while
              entering a day's figures.
            */}
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setManaging(true)}
            >
              Manage
            </button>
            {/*
              Disabled while the grid has unsaved figures. An import writes to
              whatever dates its file covers and then reloads this grid, which
              would throw away half-typed work on the open day — and the person
              who lost it would have no way to tell what they had typed.
            */}
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setImporting(true)}
              disabled={rows.length === 0 || dirty.length > 0}
              title={
                dirty.length > 0
                  ? 'Save or discard the figures you have typed before importing.'
                  : undefined
              }
            >
              Import
            </button>
            <button
              type="button"
              className="btn ghost sm icon"
              onClick={() => goToDate(addDays(date, -1))}
              aria-label="Previous day"
            >
              ‹
            </button>
            {/*
              Controlled, which is what makes the confirmation safe here. If the
              discard is declined, `date` never changes, React re-renders this
              input with the old `value`, and the picker snaps back on its own —
              so a refused move cannot leave the field showing a day the grid is
              not actually on.
            */}
            <input
              type="date"
              className="dateinput"
              value={date}
              max={maxDate ?? undefined}
              onChange={(e) => e.target.value && goToDate(e.target.value)}
            />
            <button
              type="button"
              className="btn ghost sm icon"
              onClick={() => goToDate(addDays(date, 1))}
              disabled={isToday}
              aria-label="Next day"
            >
              ›
            </button>
          </div>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {saved && <p className="ok">{saved}</p>}

      {addingCampaign && (
        <NewCampaign
          // The grid's own clients, deduped in grid order — a client with three
          // campaigns occupies three rows and must still appear once.
          clients={[...new Map(rows.map((r) => [r.client.id, r.client])).values()]}
          dateLabel={formatDateLong(date)}
          // Only a SAVED unattributed row counts. A blank prefilled line is not
          // a figure on the day and warning about it would cry wolf on every
          // client who simply has not been entered yet.
          hasUnattributed={(id) =>
            rows.some(
              (r) =>
                r.client.id === id &&
                r.campaign === null &&
                (r.saved !== null || r.savedActuals !== null),
            )
          }
          onClose={() => setAddingCampaign(false)}
          onCreated={(name) => {
            setAddingCampaign(false);
            setSaved(`Campaign “${name}” created. It is on the grid below.`);
            // Reload rather than splice a row in: `slotsFor` decides which lines
            // a client gets, and reproducing that decision here would be a
            // second copy of the rule that could disagree with the first.
            void load(date);
          }}
        />
      )}

      {managing && (
        // No client list passed in. The grid holds active clients only, and the
        // client somebody wants deleted is usually one already switched off —
        // so it fetches its own, every status. See the note in ManageClients.
        <ManageClients
          onClose={() => setManaging(false)}
          onChanged={(message) => {
            setManaging(false);
            setSaved(message);
            // Same reason as after a create: `slotsFor` owns which lines exist,
            // and a deleted client or campaign changes that answer.
            void load(date);
          }}
        />
      )}

      {importing && maxDate && (
        <ImportSheet
          // Same deduped grid order as New campaign uses, so the two dropdowns
          // list the same clients in the same order.
          clients={[...new Map(rows.map((r) => [r.client.id, r.client])).values()]}
          maxDate={maxDate}
          onClose={() => setImporting(false)}
          onImported={(message) => {
            setImporting(false);
            setSaved(message);
            // The file may not have touched the open date at all — reload
            // anyway. The grid must show what is now stored rather than what it
            // held before, and working out whether this day was among them is a
            // second copy of the plan's own answer.
            void load(date);
          }}
        />
      )}

      <Card>
        {rows.length === 0 ? (
          <Empty
            title="No active clients"
            body="Add a client before entering figures."
          />
        ) : (
          <div className="tablewrap">
            <table className="table grid" data-cols={HEADS.length}>
              <thead>
                <tr>
                  <th className="sticky">Client</th>
                  {HEADS.map((h) => (
                    <th key={h.field} className="num">
                      {h.short}
                    </th>
                  ))}
                  <th>Note to client</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const rowDirty = !sameAsSaved(r);
                  const isSplit = split.has(r.client.id);
                  // First line of a client, so the group header and the total
                  // row can be placed without grouping the array first.
                  const first = i === 0 || rows[i - 1].client.id !== r.client.id;
                  const last = i === rows.length - 1 || rows[i + 1].client.id !== r.client.id;
                  const label = r.campaign ? r.campaign.name : isSplit ? UNATTRIBUTED : r.client.name;
                  // The client's hue, carried by every line of the group and by
                  // the total that closes it. Purely identity — see the note on
                  // `bands` and the stylesheet's `--band-1`.
                  const band = `b${bands.get(r.client.id) ?? 1}`;

                  return (
                    <Fragment key={r.key}>
                      {isSplit && first && (
                        <tr className={`grouphead ${band}`}>
                          <th className="sticky rowhead" colSpan={HEADS.length + 2}>
                            {r.client.name}
                          </th>
                        </tr>
                      )}
                      <tr className={`${band}${rowDirty ? ' dirty' : ''}`}>
                        <th className={`sticky rowhead${isSplit ? ' sub' : ''}`}>
                          {label}
                          {r.saved ? (
                            <span className="tag saved">saved</span>
                          ) : r.draft ? (
                            <span className="tag draft">prefilled</span>
                          ) : null}
                        </th>

                        {HEADS.map((h) => {
                          const raw = r.values[h.field];
                          const bad = isBadFigure(raw);
                          const isDraft = r.draft && raw !== '';
                          return (
                            <td key={h.field} className="num">
                              <input
                                data-cell
                                inputMode="decimal"
                                className={`cell${isDraft ? ' draft' : ''}${bad ? ' bad' : ''}`}
                                value={raw}
                                placeholder="—"
                                aria-label={`${r.client.name} ${label} ${h.short}`}
                                onKeyDown={onKey}
                                onFocus={(e) => e.currentTarget.select()}
                                onChange={(e) => setCell(r.key, h.field, e.target.value)}
                              />
                            </td>
                          );
                        })}

                        <td>
                          <input
                            className="cell note"
                            value={r.note}
                            maxLength={2000}
                            placeholder="Visible to the client"
                            aria-label={`${r.client.name} ${label} note to client`}
                            onChange={(e) => setNote(r.key, e.target.value)}
                          />
                        </td>
                      </tr>
                      {isSplit && last && (
                        <TotalRow rows={rows} clientId={r.client.id} band={band} />
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/*
        Adovia's own measurements, in a table no client can read.

        Deliberately a second grid rather than four more columns on the first
        one. The client-facing figures are a statement Adovia publishes; these
        are what Adovia measured. Interleaving them would put "what we said" and
        "what happened" in adjacent cells of one row, and the day someone tabs
        one column too far, an internal figure becomes a published one. The
        separation is the safeguard — the RLS policy is what enforces it, but
        ops should be able to see the boundary, not just trust it.
      */}
      {rows.length > 0 && (
        <Card
          title="Adovia's actuals — internal only"
          collapsible
          // Shut on arrival. Most days ops opens this page to publish the
          // client-facing figures, and the actuals grid is a second table of
          // inputs that looks much like the first — folding it away by default
          // means the screen opens on exactly one grid, and the private one has
          // to be asked for. It also makes the boundary between "what we said"
          // and "what we measured" a thing you cross deliberately.
          defaultOpen={false}
          // The one thing folding must never do is hide pending edits. A closed
          // card with unsaved actuals would leave the savebar counting changes
          // the reader cannot see, so the lid carries the count and the panel
          // says how many rows are waiting.
          note={
            dirtyActuals > 0 ? (
              <span className="tag warn">
                {dirtyActuals} unsaved {dirtyActuals === 1 ? 'row' : 'rows'}
              </span>
            ) : null
          }
        >
          <p className="muted">
            What we measured, for our own reference. No client screen renders these, and the
            database refuses the read regardless of what the app asks for.
          </p>
          <div className="tablewrap mt">
            <table className="table grid internal" data-cols={ACTUAL_FIELDS.length}>
              <thead>
                <tr>
                  <th className="sticky">Client</th>
                  {ACTUAL_FIELDS.map((f) => (
                    <th key={f} className="num">
                      {ACTUAL_SHORT[f]}
                    </th>
                  ))}
                  <th>Internal note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const rowDirty = !actualsUnchanged(r);
                  const isSplit = split.has(r.client.id);
                  const first = i === 0 || rows[i - 1].client.id !== r.client.id;
                  const label = r.campaign
                    ? r.campaign.name
                    : isSplit
                      ? UNATTRIBUTED
                      : r.client.name;
                  const band = `b${bands.get(r.client.id) ?? 1}`;

                  return (
                    <Fragment key={r.key}>
                      {/* Grouped the same way as the grid above, split the same
                          way and BANDED the same way, so a campaign sits at the
                          same position in the same colour in both tables. No
                          total row here: nothing derives a client-level actual,
                          because no screen reads one. */}
                      {isSplit && first && (
                        <tr className={`grouphead ${band}`}>
                          <th className="sticky rowhead" colSpan={ACTUAL_FIELDS.length + 2}>
                            {r.client.name}
                          </th>
                        </tr>
                      )}
                      <tr className={`${band}${rowDirty ? ' dirty' : ''}`}>
                        <th className={`sticky rowhead${isSplit ? ' sub' : ''}`}>
                          {label}
                          {r.savedActuals && <span className="tag saved">saved</span>}
                        </th>
                        {ACTUAL_FIELDS.map((f) => {
                          const raw = r.actuals[f];
                          return (
                            <td key={f} className="num">
                              <input
                                data-cell
                                inputMode="decimal"
                                className={`cell${isBadFigure(raw) ? ' bad' : ''}`}
                                value={raw}
                                placeholder="—"
                                aria-label={`${r.client.name} ${label} actual ${ACTUAL_SHORT[f]}`}
                                onKeyDown={onKey}
                                onFocus={(e) => e.currentTarget.select()}
                                onChange={(e) => setActual(r.key, f, e.target.value)}
                              />
                            </td>
                          );
                        })}
                        <td>
                          {/* Placeholder says who reads it, exactly as the
                              client-facing note's says "Visible to the client".
                              The two inputs look alike and sit on one screen; the
                              only thing that keeps a private line out of a
                              published field is knowing which one you are in. */}
                          <input
                            className="cell note"
                            value={r.actualNote}
                            maxLength={2000}
                            placeholder="Adovia only"
                            aria-label={`${r.client.name} ${label} internal note on actuals`}
                            onChange={(e) => setActualNote(r.key, e.target.value)}
                          />
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted mt sm">
            Never prefilled from yesterday. A measurement carried forward is a guess wearing
            a measurement&rsquo;s clothes.
          </p>
        </Card>
      )}

      <div className="savebar">
        <div className="savebar-note">
          {/*
            Prefilled projections are shown dashed and are NOT counted as dirty
            until touched, so a blind Save writes nothing. A stale number that
            looks freshly entered is exactly the failure this product is
            positioned against.
          */}
          {dirty.length === 0 ? (
            <span className="muted">
              Nothing to save. Blank cells stay “not yet entered”, not zero. Prefilled
              projections are drafts until you edit them.
            </span>
          ) : (
            <span>
              <strong>{dirty.length}</strong> line{dirty.length === 1 ? '' : 's'} changed.
              {invalid && ' Fix the highlighted cells first.'}
            </span>
          )}
        </div>
        <button
          type="button"
          className="btn"
          disabled={saving || dirty.length === 0 || invalid}
          onClick={attemptSave}
        >
          {saving ? 'Saving…' : `Save ${formatDate(date)}`}
        </button>
      </div>

      {queried && (
        <OutlierModal
          outliers={queried}
          onCancel={() => setQueried(null)}
          onConfirm={() => void commit()}
        />
      )}

      {/*
        One of the three, never two. Each is triggered by a different gesture and
        none of them touches the other two's state, so they cannot fire together
        — but written as a chain, a mistake in that reasoning shows up as the
        wrong dialog rather than as two stacked on top of each other, each
        trapping focus against the other.
      */}
      {leaving ? (
        <DiscardModal
          rows={typed}
          exit={{ kind: 'date', date: leaving }}
          onCancel={() => setLeaving(null)}
          onConfirm={() => {
            setDate(leaving);
            setLeaving(null);
          }}
        />
      ) : signingOut ? (
        <DiscardModal
          rows={typed}
          exit={{ kind: 'signout' }}
          onCancel={() => setSigningOut(false)}
          /*
            No `setSigningOut(false)` after it. Cancelling has a grid to go back
            to; confirming does not — `signOut` clears the session and this whole
            component is replaced by the login screen, so tidying the flag would
            be setting state on the way out for nobody to read.
          */
          onConfirm={() => void signOut()}
        />
      ) : blocker.state === 'blocked' ? (
        <DiscardModal
          rows={typed}
          exit={{ kind: 'route' }}
          onCancel={() => blocker.reset()}
          onConfirm={() => blocker.proceed()}
        />
      ) : null}
    </Shell>
  );
}


/**
 * What the client will see for this day, summed from the campaign lines above.
 *
 * Read-only, and deliberately not an input. This is the number the client's
 * Overview will show, and it is derived on every read from the rows ops types —
 * there is no column behind it. Making it typeable would create a second record
 * of a figure the parts already state, and the two would disagree the moment
 * one campaign was corrected without the total being retyped.
 *
 * It follows the cells as they are edited rather than as they are saved, so ops
 * can see the client-facing consequence of a figure before committing to it.
 * Blank cells are skipped rather than read as zero, exactly as the fold does on
 * the client side, so a total here means the same thing it will mean there.
 */
function TotalRow({
  rows,
  clientId,
  band,
}: {
  rows: RowState[];
  clientId: string;
  /** The client's colour class, so the closing line matches the group. */
  band: string;
}) {
  const mine = rows.filter((r) => r.client.id === clientId);

  return (
    <tr className={`totalrow ${band}`}>
      <th className="sticky rowhead">Client total</th>
      {HEADS.map((h) => {
        const total = sumStated(mine, (r) => parseFigure(r.values[h.field]));
        return (
          <td key={h.field} className="num derived">
            {total === null ? '—' : byField(h.field, total)}
          </td>
        );
      })}
      <td className="muted sm">Derived — not stored</td>
    </tr>
  );
}

/**
 * What is about to be thrown away, named rather than counted.
 *
 * "You have unsaved changes" is the version of this dialog that gets clicked
 * through, because it asks someone to remember what they typed in order to
 * decide. Listing the rows lets them recognise it instead — and recognising one
 * client they had not finished is the whole reason to press Back.
 *
 * `btn danger` for the confirm, matching the two delete confirmations in
 * `ManageClients`. The emphasised button still proceeds, as it does in every
 * dialog here — what changes is its colour, so the one press that cannot be
 * taken back does not look identical to the one that saves.
 *
 * Nothing is auto-focused, which means `Modal` parks focus on the close button:
 * a stray Enter from the grid dismisses this rather than discarding through it.
 */
function DiscardModal({
  rows,
  exit,
  onCancel,
  onConfirm,
}: {
  rows: RowState[];
  /**
   * Which of the three ways off this screen is being held open, so the prose and
   * the confirm button can name it.
   *
   * A union rather than the nullable date this started as. With two exits, `null`
   * could honestly mean "not a date change"; with three it would have to mean
   * "one of the two that aren't", and the sign-out copy would be reached by
   * asking a question about a day. Naming the exit says what varies, and adding a
   * fourth would fail to compile here rather than fall through to the wrong
   * sentence.
   */
  exit: Exit;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const n = rows.length;
  const these = n === 1 ? 'this figure' : 'these figures';

  return (
    <Modal title={n === 1 ? 'One row is unsaved' : `${n} rows are unsaved`} onClose={onCancel}>
      <p className="muted">
        {exit.kind === 'date'
          ? `Moving to ${formatDateLong(exit.date)} reloads the grid from what has been saved, so ${these} would be gone.`
          : exit.kind === 'route'
            ? `Leaving daily entry discards ${these}. Coming back reloads the grid from what has been saved.`
            : /*
                Sign out says where the work is rather than where you are going,
                because the other two exits leave it recoverable-looking — the
                grid is still there, the tab is still open — and this one does
                not. The figures live in this browser and nowhere else until Save
                is pressed, and the login screen is what replaces them.
              */
              `${n === 1 ? 'This figure is' : 'These figures are'} only in this browser until Save is pressed. Signing out discards ${n === 1 ? 'it' : 'them'}.`}{' '}
        There is no undo.
      </p>

      {/*
        `history-diff` unadorned, exactly as `OutlierModal` below uses it. A `mt`
        here would be dead code: the class sets `margin: 0` and is declared later
        in the stylesheet, so it wins the tie and the utility does nothing.
      */}
      <ul className="history-diff">
        {rows.map((r) => {
          const halves = [
            !reportUnchanged(r) && 'client figures',
            !actualsUnchanged(r) && 'measured actuals',
          ].filter(Boolean);
          return (
            <li key={r.key}>
              <span className="dl-label">
                {r.client.name}
                {r.campaign && ` · ${r.campaign.name}`}
              </span>
              <span>{halves.join(' and ')}</span>
            </li>
          );
        })}
      </ul>

      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Back to the grid
        </button>
        <button type="button" className="btn danger" onClick={onConfirm}>
          {exit.kind === 'date'
            ? `Discard and open ${formatDate(exit.date)}`
            : exit.kind === 'route'
              ? 'Discard and leave'
              : 'Discard and sign out'}
        </button>
      </div>
    </Modal>
  );
}

/**
 * The question, not the verdict. It names each suspect figure next to what that
 * client's recent days actually looked like, because "12× higher than usual" is
 * only useful if you can see the usual — ops needs to recognise the right number
 * on sight, not take our word that this one is wrong.
 */
function OutlierModal({
  outliers,
  onCancel,
  onConfirm,
}: {
  outliers: Outlier[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const n = outliers.length;

  return (
    <Modal title={n === 1 ? 'Check this figure' : `Check these ${n} figures`} onClose={onCancel}>
      <p className="muted">
        {n === 1 ? 'One figure is' : `${n} figures are`} well outside what this client&rsquo;s
        last {WINDOW_DAYS} days look like. That is usually a stray digit. If it&rsquo;s
        genuine, save it — this is a question, not a block.
      </p>

      <ul className="history-diff">
        {outliers.map((o) => (
          <li key={`${o.clientId}-${o.campaignId ?? ''}-${o.field}`}>
            <span className="dl-label">
              {o.clientName}
              {o.campaignName && ` · ${o.campaignName}`} · {REPORT_LABELS[o.field]}
            </span>
            <span className="was">usually {byField(o.field, o.baseline)}</span>
            <span className="arrow">→</span>
            <span className="now">{byField(o.field, o.value)}</span>
            <span className="muted sm">
              {o.factor === null
                ? ' zero entered'
                : ` ${Math.round(o.factor)}× ${o.direction === 'up' ? 'higher' : 'lower'}`}
            </span>
          </li>
        ))}
      </ul>

      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Back to the grid
        </button>
        <button type="button" className="btn" onClick={onConfirm}>
          {n === 1 ? 'Figure is correct — save' : 'Figures are correct — save'}
        </button>
      </div>
    </Modal>
  );
}
