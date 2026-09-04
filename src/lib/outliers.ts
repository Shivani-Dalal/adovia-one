/**
 * The typo guard for the daily entry grid.
 *
 * The failure this exists to catch is a stray keystroke — an extra zero, a
 * missing one, a number typed into the row above. `parseFigure` already rejects
 * anything that isn't a number; nothing until now asked whether the number was
 * *plausible*. In a product whose whole claim is that a human entered every
 * figure, a mistyped spend reaching a client costs more than any other bug
 * here, and it does so silently.
 *
 * The test is deliberately an order of magnitude and nothing cleverer. An extra
 * zero is exactly 10×, which is the error we are hunting; a tighter threshold
 * would fire on ordinary campaign swings and teach ops to click through the
 * warning without reading it. A guard that cries wolf is worse than no guard,
 * because it launders the one real warning in among fifty false ones.
 */

import { REPORT_FIELDS, type DailyReport, type ReportField } from './types';

/** How far off the recent norm a figure must sit before we stop and ask. */
const FACTOR = 10;

/** Fewer prior days than this and there is no norm worth comparing against. */
const MIN_SAMPLES = 3;

/** Days of history the baseline is drawn from. */
export const WINDOW_DAYS = 14;

export interface Outlier {
  clientId: string;
  clientName: string;
  /** Which campaign's cell this was, for naming it in the question. */
  campaignId: string | null;
  /** The campaign's name, or the unattributed label. Null when unsplit. */
  campaignName: string | null;
  field: ReportField;
  value: number;
  /** The median of this campaign's recent stated values for the field. */
  baseline: number;
  /** How many times larger or smaller than the baseline, or null when zeroed. */
  factor: number | null;
  direction: 'up' | 'down';
}

/** Median of the recent values for one client-campaign and field. */
export type Baselines = Map<string, Partial<Record<ReportField, number>>>;

/**
 * The baseline key: a client's campaign, not a client.
 *
 * Keying on the client alone would pool every campaign's history into one
 * median, and campaigns are exactly the thing that differ in scale — a ₹2,000
 * a day PR line and a ₹80,000 a day Google line share a client and share
 * nothing else. Their pooled median describes neither, so the guard would wave
 * through a real typo on the large campaign while stopping ops on ordinary
 * figures for the small one. Each campaign keeps its own sense of normal.
 *
 * Unattributed rows key on the empty string and so form their own baseline,
 * which is right: they are historical figures for a client that was not split,
 * and their scale is the whole client's.
 */
export function baselineKey(clientId: string, campaignId: string | null): string {
  return `${clientId}:${campaignId ?? ''}`;
}

/**
 * Median, not mean. One prior typo in the window would drag a mean far enough
 * to hide the next one — the median shrugs it off, which matters most on
 * exactly the days this guard is meant to work.
 */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function buildBaselines(history: DailyReport[]): Baselines {
  const collected = new Map<string, Partial<Record<ReportField, number[]>>>();

  for (const m of history) {
    const key = baselineKey(m.client_id, m.campaign_id);
    const acc = collected.get(key) ?? {};
    for (const f of REPORT_FIELDS) {
      const v = m[f];
      // Nulls are skipped rather than counted as zero. A client with three
      // blank days and one stated day has one sample, not four.
      if (typeof v === 'number') (acc[f] ??= []).push(v);
    }
    collected.set(key, acc);
  }

  const out: Baselines = new Map();
  for (const [key, fields] of collected) {
    const medians: Partial<Record<ReportField, number>> = {};
    for (const f of REPORT_FIELDS) {
      const xs = fields[f];
      if (!xs || xs.length < MIN_SAMPLES) continue;
      const m = median(xs);
      if (m !== null) medians[f] = m;
    }
    out.set(key, medians);
  }
  return out;
}

export interface Candidate {
  clientId: string;
  clientName: string;
  campaignId: string | null;
  /** Printed beside the client in the question. Null when the client is unsplit. */
  campaignName: string | null;
  /** Parsed cell values. Null means the cell is blank, which is never flagged. */
  values: Partial<Record<ReportField, number | null>>;
  /** The row as stored, so untouched cells can be skipped. */
  saved: Partial<Record<ReportField, number | null>> | null;
}

export function findOutliers(candidates: Candidate[], baselines: Baselines): Outlier[] {
  const out: Outlier[] = [];

  for (const c of candidates) {
    const medians = baselines.get(baselineKey(c.clientId, c.campaignId));
    if (!medians) continue;

    for (const f of REPORT_FIELDS) {
      const value = c.values[f];
      // Blank is "not yet entered" and always legitimate — clearing a figure is
      // how ops retracts one, and the guard must never stand in the way of that.
      if (typeof value !== 'number') continue;
      // Unchanged cells are not re-litigated. Re-saving a row because its note
      // changed should not reopen a figure that was already confirmed once.
      if (c.saved && c.saved[f] === value) continue;

      const baseline = medians[f];
      if (baseline === undefined || baseline === 0) continue;

      if (value === 0) {
        // Zero is a claim, not an absence: it says Adovia states nothing ran.
        // Worth confirming against a client that normally states a figure,
        // because it is what a cleared cell looks like when it goes wrong.
        out.push({
          clientId: c.clientId,
          clientName: c.clientName,
          campaignId: c.campaignId,
          campaignName: c.campaignName,
          field: f,
          value,
          baseline,
          factor: null,
          direction: 'down',
        });
        continue;
      }

      const up = value > baseline;
      const factor = up ? value / baseline : baseline / value;
      if (factor < FACTOR) continue;

      out.push({
        clientId: c.clientId,
        clientName: c.clientName,
        campaignId: c.campaignId,
        campaignName: c.campaignName,
        field: f,
        value,
        baseline,
        factor,
        direction: up ? 'up' : 'down',
      });
    }
  }

  return out;
}
