/**
 * The client-facing spend report, in one place because two sides of the product
 * download it.
 *
 * The client exports it from their own Spend report page; an admin exports the
 * same month for the same client from Client detail. Those two files have to
 * agree, and the only way to guarantee that is for them to come from the same
 * function. A second copy of this on the admin side would be correct on the day
 * it was written and quietly wrong the first time either side changed a column —
 * and the failure would surface as a client and an account manager reading
 * different numbers off "the same" report, which is the exact argument this
 * product exists to prevent.
 */

import type { CampaignSlice, DayTotals } from './campaigns';
import { num, toCsvText } from './csv';
import { monthKey } from './dates';
import type { DailyReport } from './types';

export type SpendRow = Pick<
  DailyReport,
  | 'date'
  | 'campaign_id'
  | 'ad_spend'
  | 'impressions'
  | 'projected_leads'
  | 'projected_admissions'
>;

/**
 * The four figures plus the two things that identify the row they sit on.
 *
 * `campaign_id` is selected but never printed as itself. It is here because a
 * row is now one client-campaign-day rather than one client-day, so anything
 * reading this list has to fold by date before it has the day's figure — and it
 * cannot fold what it did not fetch. A select list without it would look
 * correct, return one row per campaign, and let a screen render a single
 * campaign's spend under the client's name.
 */
export const SPEND_COLS =
  'date, campaign_id, ad_spend, impressions, projected_leads, projected_admissions';

/** The figures, in the order the sheet prints them. */
export const SPEND_FIELDS = [
  'ad_spend',
  'impressions',
  'projected_leads',
  'projected_admissions',
] as const;

export type SpendField = (typeof SPEND_FIELDS)[number];

/**
 * The three columns the by-campaign breakdown reports.
 *
 * Named for a rule — the fields safe to sum across more than one day — and
 * `projected_leads` now satisfies it, for the reasons set out on `SpendTotals`:
 * the stored figure tracks each day's spend rather than restating a standing
 * target, so a campaign's month of them adds up to that campaign's projection.
 *
 * It was previously left out of this card even so, on the argument that a
 * forecast column beside each campaign's spend reads as leads that campaign
 * DELIVERED — a measurement Adovia does not publish. That risk is real and has
 * not gone away; it is now handled where it belongs, by naming the column
 * "Projected leads" in both the table and the file rather than by withholding
 * the figure. A client who asks which campaign their projection comes from is
 * asking a fair question, and the answer was already derivable by switching the
 * filter campaign by campaign and reading the footer each time.
 *
 * `projected_admissions` stays out of the per-campaign split specifically. It
 * is totalled for the month now (see `SpendTotals`), but no row states it, so a
 * per-campaign column would be one dash per campaign — a column that only ever
 * says "we don't know" broken down four ways.
 */
export const SPEND_ACCRUING_FIELDS = ['ad_spend', 'impressions', 'projected_leads'] as const;

export type SpendAccruingField = (typeof SPEND_ACCRUING_FIELDS)[number];

/**
 * "Cumulative impressions" is the day's own impressions — cumulative across the
 * placements running that day, not across the days of the month. Each row
 * stands alone, so the figure on 14 April does not contain the figure on 13
 * April. Adovia's wording, kept verbatim rather than renamed to "Impressions",
 * because it is what the client hears on a call.
 */
const SPEND_HEADERS = [
  'Date',
  'Spend (INR)',
  'Cumulative impressions',
  'Projected leads',
  'Projected admissions',
] as const;

/**
 * Month totals for the three columns it is safe to add up.
 *
 * Spend and impressions are quantities the day produced, so a month's worth of
 * them sums.
 *
 * `leads` is the newer one and it reverses an earlier decision here, so the
 * reasoning is worth keeping. This cell used to be deliberately empty, on the
 * grounds that ops prefills each day's projections from the day before and a
 * month of them is therefore one standing forecast restated thirty times. The
 * stored data does not behave that way: `projected_leads` moves every day in
 * proportion to that day's spend — around one lead per ₹1,400 across Jaro's PR
 * campaign — and falls to zero on days with no spend. It is a per-day figure
 * derived from a per-day quantity, so a month of them adds up to the month's
 * projection, which is the number a client is actually trying to read off this
 * sheet.
 *
 * The carry-forward is still real, and it is the thing to watch. `DailyEntry`
 * prefills tomorrow's projections from today's, and while a purely prefilled
 * row is excluded from the save set, editing any other cell on that row clears
 * the draft flag and commits the inherited figures with it. So a hand-entered
 * client CAN accumulate repeated projections in a way an imported one does not,
 * and this total would overstate them. That is an entry-side problem — the fix
 * belongs in `DailyEntry`, not in a total that refuses to add up correct data.
 *
 * `admissions` is summed the same way, and the null return is what makes that
 * safe rather than presumptuous. The column is null in every row currently
 * stored, so there is still no evidence whether it behaves like leads or like a
 * standing target — but `sumSpend` answers null for a month that states none,
 * every surface renders that null as a dash or as "not yet entered", and none
 * of them invents a 0. So while nothing states the figure this total is
 * invisible in practice, and on the day ops starts entering it the month's
 * projection appears on its own. If it turns out to be entered as a standing
 * target rather than a per-day figure, this is the line to revisit — the same
 * way `leads` was.
 */
export interface SpendTotals {
  spend: number | null;
  impressions: number | null;
  leads: number | null;
  admissions: number | null;
}

/** Sums the stated values, and returns null when the month states none. */
function sumSpend(rows: SpendRow[], key: SpendField): number | null {
  const vals = rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number');
  return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
}

export function spendTotals(rows: SpendRow[]): SpendTotals {
  return {
    spend: sumSpend(rows, 'ad_spend'),
    impressions: sumSpend(rows, 'impressions'),
    leads: sumSpend(rows, 'projected_leads'),
    admissions: sumSpend(rows, 'projected_admissions'),
  };
}

/**
 * One month's rows, exactly as stored — several per day when split.
 *
 * Generic in the row, so it hands back whatever it was given rather than
 * narrowing to `SpendRow`. The admin day table filters full `daily_report` rows
 * through here and needs the `id` and `updated_at` that a `SpendRow` return
 * type would strip; the alternative is a second copy of `monthKey(r.date) ===
 * month` living next to this one, which is one month filter too many for a
 * screen whose whole point is that two cards agree about what a month is.
 */
export function monthRows<T extends { date: string }>(rows: readonly T[], month: string): T[] {
  return rows.filter((r) => monthKey(r.date) === month);
}

/*
 * There was a `monthLines(rows, month)` here that did `monthRows` then
 * `foldToDays`, and it is gone on purpose rather than left as a convenience.
 * Both sheets now fold a campaign-FILTERED subset of the month, so neither can
 * use it — and a helper that quietly re-reads the whole month is one somebody
 * reaches for later, in a screen with a campaign picker, and gets every
 * campaign's figures back under one campaign's heading. The two steps are one
 * line at each call site and say which rows they are folding.
 */

/**
 * The months that have at least one row, newest first, with their DAY counts.
 *
 * Days, not rows. The count is printed as "August 2026 (23)" next to a month a
 * client picks, and it means the number of days recorded — counting rows would
 * say 69 for a client with three campaigns and quietly triple every figure the
 * reader takes from that label.
 */
export function monthsWithCounts(rows: { date: string }[]): [string, number][] {
  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = monthKey(r.date);
    const days = seen.get(k);
    if (days) days.add(r.date);
    else seen.set(k, new Set([r.date]));
  }
  return [...seen.entries()]
    .map(([k, days]): [string, number] => [k, days.size])
    .sort((a, b) => b[0].localeCompare(a[0]));
}

/**
 * The month's sheet as CSV. Numbers go out raw and dates as ISO — the file is
 * meant to be summed and pivoted, so formatting it for reading would only mean
 * the recipient has to strip ₹ signs and thousands separators back out.
 */
export function spendCsv(
  lines: DayTotals<SpendField>[],
  totals: SpendTotals,
  label: string,
): string {
  return toCsvText([
    [...SPEND_HEADERS],
    ...lines.map((l) => [
      l.date,
      num(l.totals.ad_spend),
      num(l.totals.impressions),
      num(l.totals.projected_leads),
      num(l.totals.projected_admissions),
    ]),
    // All four columns total, and `num` writes an empty cell rather than a 0
    // for any the month never states — which today is admissions, in every
    // stored row. The file and the screen total the same four columns, so a
    // client who exports what they are looking at gets the same footer they
    // were reading.
    [
      `${label} total`,
      num(totals.spend),
      num(totals.impressions),
      num(totals.leads),
      num(totals.admissions),
    ],
  ]);
}

/**
 * The month's split across campaigns as CSV — the by-campaign card, downloaded.
 *
 * The projected leads column is named "Projected leads" here and not "Leads",
 * and that is load-bearing rather than tidy. This file gets forwarded, opened
 * by someone who did not watch it being built, and read as a record of what
 * each campaign produced. The header is the only thing travelling with the
 * number that says it is a forecast, so it says so.
 *
 * Admissions is absent for the reason given on `SPEND_ACCRUING_FIELDS`: nothing
 * states it, so the column would be one empty cell per campaign.
 *
 * `days` is passed in rather than summed from the slices on purpose. Two
 * campaigns running on one day contribute two rows, so adding the slice counts
 * gives a number larger than the month has days — correct as "campaign-days",
 * and wrong under a column the reader will take as "days". It is the same
 * figure the table prints in that cell.
 */
const CAMPAIGN_HEADERS = [
  'Campaign',
  'Spend (INR)',
  'Cumulative impressions',
  'Projected leads',
  'Days recorded',
] as const;

export function campaignCsv(
  slices: readonly CampaignSlice<SpendAccruingField>[],
  totals: SpendTotals,
  days: number,
  label: string,
): string {
  return toCsvText([
    [...CAMPAIGN_HEADERS],
    ...slices.map((c) => [
      c.name,
      num(c.totals.ad_spend),
      num(c.totals.impressions),
      num(c.totals.projected_leads),
      String(c.rows),
    ]),
    [
      `${label} total`,
      num(totals.spend),
      num(totals.impressions),
      num(totals.leads),
      String(days),
    ],
  ]);
}
