/**
 * Folding per-campaign rows back into the day totals a client reads.
 *
 * `daily_report` used to hold one row per client-day. It now holds one row per
 * client-campaign-day, which means every figure the client was shown before —
 * the day's spend, the day's impressions — is now a SUM over rows rather than a
 * column. This module is where that sum happens, and it is the only place it is
 * allowed to happen: a total computed inline on one screen and via this module
 * on another is exactly the "two of our own pages disagree" failure the product
 * is positioned against.
 *
 * Nothing here is ever written back. The client-level total is derived on read
 * and never stored, because storing it would be a second record of a number the
 * campaign rows already state, and the two would drift the first time one
 * campaign was corrected. The parts are the record; the whole is a view of them.
 *
 * The second half of the file is the naming rule — what counts as two campaigns
 * having the same name, and what to say when the database refuses one. It lives
 * beside the folding because it protects the same thing: a breakdown whose rows
 * a client can tell apart.
 */

import { errorText } from './supabase';
import { UNATTRIBUTED, type Campaign } from './types';

/**
 * Sums the stated values, and returns null when nothing states one.
 *
 * The null rule is the whole point and it is not defensive coding. Null means
 * "Adovia has not stated this", 0 means "Adovia states it was zero", and a fold
 * that returned 0 for a day no campaign reported would invent a published
 * figure — it would tell a client their campaign spent nothing on a day nobody
 * had entered yet. So: a day is null until at least one campaign states a
 * number, and from then on it is the sum of the campaigns that did state one.
 *
 * Campaigns that have not been entered are skipped rather than counted as zero,
 * for the same reason a day with no row is skipped from a month total. This
 * does mean a day total can be partial — three campaigns entered out of four —
 * which is a real property of the data and is surfaced by `statedCount` rather
 * than smoothed over here.
 */
export function sumStated<T>(
  rows: readonly T[],
  pick: (r: T) => number | null | undefined,
): number | null {
  let total = 0;
  let stated = false;
  for (const r of rows) {
    const v = pick(r);
    if (typeof v === 'number') {
      total += v;
      stated = true;
    }
  }
  return stated ? total : null;
}

/** How many rows actually state this figure — the denominator behind a total. */
export function statedCount<T>(
  rows: readonly T[],
  pick: (r: T) => number | null | undefined,
): number {
  return rows.filter((r) => typeof pick(r) === 'number').length;
}

/** A row carrying figures for one campaign on one date. */
type FigureRow<F extends string> = { date: string; campaign_id: string | null } & {
  [K in F]: number | null;
};

/** The summed figures for one date, in the same shape as a single row's. */
export type Totals<F extends string> = { [K in F]: number | null };

/**
 * Sums the given fields across a set of rows.
 *
 * Every field goes through `sumStated`, so a field no row states stays null
 * while its neighbours total normally — one campaign entering spend but not
 * impressions yields a spend total and a null impressions total, which is an
 * honest description of what was entered.
 *
 * A note on projections. `projected_leads` and `projected_admissions` are summed
 * across campaigns within a day — each campaign carries its own forecast, and
 * the client's forecast for the day is their sum. They are also summed across
 * days for the month total: `projected_leads` tracks each day's spend rather
 * than standing still, so a month of them is the month's projection. See
 * `SpendTotals` in `spendReport.ts`, which carries the evidence and the one
 * caveat left — `DailyEntry` used to carry projections forward, so rows entered
 * by hand before that was removed may repeat a figure nobody retyped.
 *
 * This function cannot tell any of that apart — it sums whatever fields and
 * whatever rows it is handed, and which direction you get is decided entirely by
 * the CALLER, by what it puts in `rows`. The distinction still matters for what
 * a fold MEANS rather than whether it is arithmetically safe: a per-campaign
 * slice spanning a month is a different claim from a day's total, which is why
 * the breakdown card passes `SPEND_ACCRUING_FIELDS` and the day sheet passes
 * `SPEND_FIELDS`.
 */
export function sumFields<F extends string>(
  rows: readonly FigureRow<F>[],
  fields: readonly F[],
): Totals<F> {
  return fields.reduce((acc, f) => {
    acc[f] = sumStated(rows, (r) => r[f]);
    return acc;
  }, {} as Totals<F>);
}

/**
 * One date's rows folded into a single set of totals, newest first.
 *
 * This is the shape every client screen wants: the day, as the client
 * understands a day, regardless of how many campaigns it was assembled from.
 * `campaigns` counts the rows behind it so a screen can say "across 3
 * campaigns" without re-grouping.
 */
export interface DayTotals<F extends string> {
  date: string;
  totals: Totals<F>;
  /** How many campaign rows this day was folded from. Always at least 1. */
  campaigns: number;
}

export function foldToDays<F extends string>(
  rows: readonly FigureRow<F>[],
  fields: readonly F[],
): DayTotals<F>[] {
  const byDate = new Map<string, FigureRow<F>[]>();
  for (const r of rows) {
    const bucket = byDate.get(r.date);
    if (bucket) bucket.push(r);
    else byDate.set(r.date, [r]);
  }

  return [...byDate.entries()]
    .map(([date, rs]) => ({ date, totals: sumFields(rs, fields), campaigns: rs.length }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** The totals for one specific date, or null when that date has no rows. */
export function dayTotals<F extends string>(
  rows: readonly FigureRow<F>[],
  date: string,
  fields: readonly F[],
): DayTotals<F> | null {
  const rs = rows.filter((r) => r.date === date);
  if (rs.length === 0) return null;
  return { date, totals: sumFields(rs, fields), campaigns: rs.length };
}

/**
 * One campaign's figures within whatever span was passed in.
 *
 * `id` is null for the unattributed slice — rows recorded before the client was
 * split into campaigns. That slice is not a gap to be filtered out: those
 * figures were real and published, and dropping them would make the breakdown
 * add up to less than the total beside it.
 */
export interface CampaignSlice<F extends string> {
  id: string | null;
  name: string;
  totals: Totals<F>;
  /** How many rows — days, if the span is a month — this slice rests on. */
  rows: number;
}

/**
 * Groups rows by campaign and names each group.
 *
 * Ordering is by the campaign list's own order with the unattributed slice
 * pinned last, rather than by size. A breakdown that reorders itself as the
 * numbers move is one a reader cannot scan down twice, and "biggest first"
 * silently editorialises about which campaign matters.
 *
 * Only campaigns that STATE something appear. A campaign with nothing entered
 * is absent rather than shown as a line of dashes — the caller knows the full
 * campaign list and can say so more precisely than a row of blanks can.
 *
 * The test is on the totals and not on whether rows exist, and the difference
 * is not hypothetical. A row whose every figure is null is still a row, so
 * grouping by presence let one through and printed the exact line of dashes
 * this rule was written to prevent: five of them reached a client's September
 * breakdown, left behind by dates somebody opened, was handed prefilled
 * projections on, and cleared again before saving.
 *
 * Dropping a slice cannot shrink the breakdown's total, which is what keeps
 * this safe beside the archived-campaign rule below. A slice stating none of
 * `fields` contributes null to every column, so the total under it is the same
 * number whether the row is listed or not — nothing is being hidden, and a row
 * that can only ever say "we don't know" once per column is not information the
 * reader loses.
 *
 * Judged against `fields`, not against every column the underlying rows carry.
 * A slice whose only stated figure is one this card does not print would be a
 * line of dashes ON THIS CARD whatever it holds elsewhere, and the rule is
 * about what the reader sees.
 *
 * MIND THE FIELDS. This groups by campaign, not by date, so each slice normally
 * spans every day in `rows`. Pass `SPEND_ACCRUING_FIELDS` when `rows` covers
 * more than one date; `SPEND_FIELDS` is what a same-day fold wants, as on
 * Overview. The difference is no longer about arithmetic — it is about what the
 * slice claims. A projection totalled per campaign over a month sits beside
 * that campaign's spend and reads as leads it delivered, which is a measurement
 * this product does not publish.
 */
export function sliceByCampaign<F extends string>(
  rows: readonly FigureRow<F>[],
  fields: readonly F[],
  campaigns: readonly Campaign[],
): CampaignSlice<F>[] {
  const grouped = new Map<string | null, FigureRow<F>[]>();
  for (const r of rows) {
    const bucket = grouped.get(r.campaign_id);
    if (bucket) bucket.push(r);
    else grouped.set(r.campaign_id, [r]);
  }

  const order = campaigns.map((c) => c.id).filter((id) => grouped.has(id));
  const keys: (string | null)[] = [...order];
  // Any campaign_id present in the rows but missing from `campaigns` still gets
  // a slice. That happens when a campaign is archived and the list passed in
  // only holds active ones — the figures it published are still the client's,
  // and dropping them here would quietly shrink the breakdown's total.
  for (const k of grouped.keys()) {
    if (k !== null && !keys.includes(k)) keys.push(k);
  }
  if (grouped.has(null)) keys.push(null);

  const name = campaignNamer(campaigns);
  return keys
    .map((id) => {
      const rs = grouped.get(id) ?? [];
      return { id, name: name(id), totals: sumFields(rs, fields), rows: rs.length };
    })
    .filter((s) => fields.some((f) => s.totals[f] !== null));
}

/* -------------------------------------------------------- picking one --- */

/**
 * The two `<select>` values that are not a campaign id.
 *
 * `CAMPAIGN_NONE` exists because the unattributed slice's id genuinely is null,
 * and null cannot be an option value. Without a stand-in it would be the one
 * slice a reader can see in a breakdown and not open on its own — the figures
 * recorded before the client was split, which are the ones most likely to need
 * explaining.
 */
export const CAMPAIGN_ALL = 'all';
export const CAMPAIGN_NONE = 'unattributed';

export function campaignKey(id: string | null): string {
  return id ?? CAMPAIGN_NONE;
}

export interface CampaignPick<F extends string, T> {
  /** The selection as it should be rendered — see the correction rule below. */
  key: string;
  /** The chosen slice, or undefined when the selection is every campaign. */
  slice: CampaignSlice<F> | undefined;
  /** `rows`, narrowed to the chosen campaign. All of them when none is chosen. */
  rows: T[];
}

/**
 * Applies a campaign selection to a set of rows, correcting it first.
 *
 * The correction is the reason this is shared rather than written twice. A
 * selection outlives the span it was made in — pick PR, then move to a month PR
 * did not run in — and the obvious behaviour, filtering anyway, leaves an empty
 * sheet under PR's name. A reader takes that as "PR spent nothing", which is a
 * claim nobody made and one the empty table looks exactly like. So a selection
 * the slices do not contain falls back to everything, which says the true
 * thing: there is no PR here to show.
 *
 * `key` comes back so the caller can render the corrected value rather than the
 * stored one. Correcting in state on every span change instead would leave a
 * frame where the dropdown and the table disagree, and would also destroy the
 * selection — moving to July and back to August would have silently forgotten
 * that PR was picked.
 *
 * `slice` is the caller's cue for labelling: undefined means the heading, total
 * row and file name should say the span, and a slice means they must all say
 * the campaign too. Handing back one object keeps those from drifting apart.
 */
export function pickCampaign<F extends string, T extends { campaign_id: string | null }>(
  rows: readonly T[],
  slices: readonly CampaignSlice<F>[],
  selected: string,
): CampaignPick<F, T> {
  const slice = slices.find((s) => campaignKey(s.id) === selected);
  if (!slice) return { key: CAMPAIGN_ALL, slice: undefined, rows: [...rows] };
  return {
    key: selected,
    slice,
    rows: rows.filter((r) => campaignKey(r.campaign_id) === selected),
  };
}

/**
 * Turns a campaign id into the name to print.
 *
 * Falls back to "Campaign no longer listed" rather than to the raw UUID: the
 * breakdown is client-readable, and an id is both meaningless to a client and a
 * detail of our storage that has no business on their screen. It appears only
 * when a row points at a campaign missing from the list it was given, which in
 * practice means an archived campaign in an active-only fetch.
 */
export function campaignNamer(
  campaigns: readonly Campaign[],
): (id: string | null) => string {
  const names = new Map(campaigns.map((c) => [c.id, c.name]));
  return (id) => (id === null ? UNATTRIBUTED : (names.get(id) ?? 'Campaign no longer listed'));
}

/* ------------------------------------------------------------- colour --- */

/**
 * How many distinct campaign hues exist. See `--band-1..5` in styles.css.
 *
 * The palette is reused rather than extended, and on purpose: those five hues
 * were chosen as the ones this app spends no meaning on. Orange is the brand,
 * amber is the internal grid, green is saved, red is destructive — a campaign
 * drawn in any of them would look like it was reporting its own state instead
 * of its identity.
 */
export const CAMPAIGN_TONES = 5;

/**
 * Turns a campaign id into the hue to draw it in, stable across every screen.
 *
 * One campaign, one colour, everywhere — that is the whole job. A donut slice,
 * a legend swatch and a line on the chart beneath it are only readable together
 * if PR is the same colour in all three, and a client who learns "PR is the
 * blue one" on Monday should not have to relearn it on Tuesday.
 *
 * Null for the unattributed slice, which is a deliberate absence rather than an
 * oversight: it is not a campaign, and giving it one of the five would spend a
 * hue on the one slice that means "we did not record which campaign this was".
 * Callers draw it in a neutral, which also lets it recede, which is right.
 *
 * By position in the list, not by hashing the id, matching what the band tokens
 * already do for clients. The honest cost: the list is ordered by name, so
 * adding a campaign called "Awareness" shifts the hue of everything after it.
 * That is a colour a client has to relearn once, against a hash's alternative
 * of two campaigns landing on the same hue in the same pie with no way to
 * separate them — which is unreadable rather than merely unfamiliar. Beyond
 * five campaigns the hues cycle and that same collision returns; a client with
 * six is the point at which this needs more colours, not a different rule.
 */
export function campaignToner(
  campaigns: readonly Campaign[],
): (id: string | null) => number | null {
  const tones = new Map(campaigns.map((c, i) => [c.id, (i % CAMPAIGN_TONES) + 1]));
  return (id) => (id === null ? null : (tones.get(id) ?? null));
}

/**
 * True when the client has ever been split into campaigns.
 *
 * The screens use this to decide whether to show a breakdown at all. A client
 * with one campaign, or none, should not be made to read a "by campaign" table
 * with a single line in it that restates the total directly above it.
 */
export function isSplit(rows: readonly { campaign_id: string | null }[]): boolean {
  const seen = new Set(rows.map((r) => r.campaign_id));
  return seen.size > 1;
}

/**
 * The campaign a proposed name would collide with, or undefined when it is free.
 *
 * Case- and space-insensitive, because "PR", "pr" and "PR " are one campaign to
 * everybody except a byte comparison. It shadows the database, which enforces
 * the same rule as a unique index on `campaigns (client_id, lower(btrim(name)))`
 * — the check exists here so the refusal arrives while the name is still in the
 * box, not because the UI is what enforces it.
 *
 * The two are not byte-identical and lean the safe way. JavaScript's `trim()`
 * strips tabs and newlines; Postgres `btrim()` strips spaces only. So a name
 * differing from another by a tab is refused here and would be accepted by the
 * database — this side is the stricter one, which means the button is never
 * enabled for a write that would fail. A divergence in the other direction
 * would be the dangerous one.
 *
 * It searches EVERY status, and that is the part worth keeping. An archived "PR"
 * is invisible on the daily grid, so the natural assumption when the name is
 * refused is that nothing is using it. But the archived campaign still carries
 * figures the client was shown, and those figures still appear in their
 * breakdown — so a second "PR" would put two rows with one label in front of
 * them, both real, with nothing to say which is which. The clash is not a
 * bookkeeping nicety; it is the thing that keeps the client's report legible.
 *
 * `exceptId` excludes a campaign from its own check, so renaming one to a
 * different capitalisation of what it already has is not reported as a clash
 * with itself.
 */
export function nameClash(
  campaigns: readonly Campaign[],
  name: string,
  exceptId?: string,
): Campaign | undefined {
  const norm = name.trim().toLowerCase();
  if (norm === '') return undefined;
  return campaigns.find(
    (c) => c.id !== exceptId && c.name.trim().toLowerCase() === norm,
  );
}

/**
 * What to say when a campaign write comes back a duplicate.
 *
 * `nameClash` catches this before the request in every screen that writes a
 * campaign, so reaching here means the list on screen was stale — another admin
 * added the name, or it was archived in another tab. Rare, but the generic
 * handler is actively wrong for it: `errorText` renders 23505 as "check for a
 * duplicate invoice number or a row for this date", which sends someone looking
 * at invoices over a campaign name.
 *
 * The message names paused and archived campaigns explicitly. Somebody hitting
 * this is looking at a grid that does not show them, and "that already exists"
 * about something you cannot see is a message that reads like a bug.
 */
export function campaignWriteError(e: unknown): string {
  if ((e as { code?: string } | null)?.code === '23505') {
    return (
      'This client already has a campaign with that name. Paused and archived ' +
      'ones count too, and they do not appear on the daily grid — open Campaigns ' +
      'on the client to find it.'
    );
  }
  return errorText(e);
}
