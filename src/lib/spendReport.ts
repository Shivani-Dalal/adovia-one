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
 * The subset of `SPEND_FIELDS` that may be summed across MORE THAN ONE DAY.
 *
 * Use this — never `SPEND_FIELDS` — whenever the rows being folded span a date
 * range rather than a single date. Spend and impressions are quantities a day
 * produced, so a week or a month of them adds up. The two projection columns are
 * a standing forecast that ops restates every day, so adding them across days
 * reports the target several times over. The same distinction is enforced for
 * the month total by `spendTotals`; this constant is how it is enforced for any
 * other multi-day grouping, such as the by-campaign breakdown.
 *
 * Within a single day the rule inverts and `SPEND_FIELDS` is correct: each
 * campaign carries its own forecast, and the day's forecast is their sum.
 */
export const SPEND_ACCRUING_FIELDS = ['ad_spend', 'impressions'] as const;

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
 * Month totals for the two columns it is safe to add up.
 *
 * Spend and impressions are quantities the day produced, so a month's worth of
 * them sums. The projections are not: ops prefills each day's projected leads
 * and admissions from the day before, so they behave as a standing forecast
 * that is restated daily rather than accrued. Adding thirty copies of one
 * forecast would report thirty times the target, so those cells stay empty in
 * both the table and the export.
 */
export interface SpendTotals {
  spend: number | null;
  impressions: number | null;
}

/** Sums the stated values, and returns null when the month states none. */
function sumSpend(rows: SpendRow[], key: 'ad_spend' | 'impressions'): number | null {
  const vals = rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number');
  return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
}

export function spendTotals(rows: SpendRow[]): SpendTotals {
  return { spend: sumSpend(rows, 'ad_spend'), impressions: sumSpend(rows, 'impressions') };
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
    // Only spend and impressions are summed. The two projection columns are
    // left empty on purpose — see the note on SpendTotals.
    [`${label} total`, num(totals.spend), num(totals.impressions), '', ''],
  ]);
}

/**
 * The month's split across campaigns as CSV — the by-campaign card, downloaded.
 *
 * Two columns, not four, and that is the whole reason this is a separate
 * function rather than `spendCsv` with a different first column. The projection
 * columns cannot appear here: each slice spans the month, and a standing
 * forecast restated daily would arrive in the file as the target multiplied by
 * the number of days the campaign ran. A spreadsheet cannot tell that from a
 * real number, and the person who opens it did not watch it being built. The
 * screen leaves those cells out for the same reason; a file that carried them
 * would be the version that gets forwarded.
 *
 * `days` is passed in rather than summed from the slices on purpose. Two
 * campaigns running on one day contribute two rows, so adding the slice counts
 * gives a number larger than the month has days — correct as "campaign-days",
 * and wrong under a column the reader will take as "days". It is the same
 * figure the table prints in that cell.
 */
const CAMPAIGN_HEADERS = ['Campaign', 'Spend (INR)', 'Cumulative impressions', 'Days recorded'] as const;

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
      String(c.rows),
    ]),
    [`${label} total`, num(totals.spend), num(totals.impressions), String(days)],
  ]);
}
