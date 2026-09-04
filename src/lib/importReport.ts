/**
 * Turning a spreadsheet into a set of proposed changes to `daily_report`.
 *
 * Nothing here writes. Everything here is about producing a plan somebody can
 * read before it happens, because an import is the one operation in this
 * product that can publish a hundred figures to a client in a single click —
 * and the daily grid, which publishes four at a time, stops to ask about a
 * single suspicious number. An importer that wrote first and reported after
 * would be the loudest exception to the rule the rest of the app is built on.
 *
 * THE ONE RULE THAT MATTERS MOST. A blank cell states nothing, and a column
 * nobody mapped states nothing, and neither may overwrite a figure that is
 * already there. This is not the same rule the entry grid follows: on the grid
 * a cleared cell means "un-state this", because the grid always shows the whole
 * row and clearing it is deliberate. A spreadsheet is a partial document — it
 * carries the columns somebody happened to export — so absence in a file means
 * silence, not retraction. The consequence is that an import can never clear a
 * figure; that stays a thing you do on the grid, where you can see what you are
 * removing.
 *
 * It follows that every write is a MERGE onto the row already stored, not a
 * replacement of it. `payloadFor` reassembles all eight figures and the client
 * note from what exists, overlays only what the file states, and sends the lot
 * — so a sheet of nothing but spend leaves the projections beside it untouched
 * rather than blanking them.
 */

import { parseFigure } from './format';
import { nameClash } from './campaigns';
import {
  REPORT_FIELDS,
  type Campaign,
  type DailyReport,
  type ReportField,
} from './types';

/**
 * The figures an import may write: the same four the entry grid asks for.
 *
 * `clicks`, `leads`, `admissions` and `projected_impressions` are deliberately
 * not importable even though the columns exist. They were retired from the grid
 * because no screen renders them, and a bulk loader is the wrong place to start
 * filling a column nobody reads — it would put figures into the client's
 * history that the client is never shown and ops never sees again. They are
 * still carried through every write untouched; see `payloadFor`.
 */
export const IMPORT_FIELDS = [
  'ad_spend',
  'impressions',
  'projected_leads',
  'projected_admissions',
] as const satisfies readonly ReportField[];

export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Which column of the sheet holds what. `null` means "not in this file". */
export interface Mapping {
  date: number | null;
  /** Null when the sheet has no campaign column — every row is unattributed. */
  campaign: number | null;
  fields: Partial<Record<ImportField, number>>;
}

/* -------------------------------------------------------------- headers --- */

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Words that mark a column as a forecast rather than a measurement. */
const PROJECTED = /^(projected|proj|target|forecast|planned|expected|est|estimated|goal)/;

const SYNONYMS: Record<'date' | 'campaign' | ImportField, string[]> = {
  date: ['date', 'day', 'reportdate', 'reportingdate', 'dateist', 'entrydate', 'date_'],
  campaign: [
    'campaign',
    'campaignname',
    'campaigns',
    'adset',
    'adsetname',
    'channel',
    'source',
    'platform',
    'lineitem',
    'medium',
  ],
  ad_spend: [
    'adspend',
    'spend',
    'spends',
    'cost',
    'amountspent',
    'totalspend',
    'spendinr',
    'spendrs',
    'adspendinr',
    'budgetspent',
  ],
  impressions: ['impressions', 'impr', 'imps', 'impressioncount', 'totalimpressions'],
  projected_leads: [
    'projectedleads',
    'projleads',
    'targetleads',
    'forecastleads',
    'leadtarget',
    'leadstarget',
    'plannedleads',
    'expectedleads',
  ],
  projected_admissions: [
    'projectedadmissions',
    'projadmissions',
    'projadm',
    'targetadmissions',
    'forecastadmissions',
    'admissiontarget',
    'admissionstarget',
    'plannedadmissions',
    'expectedadmissions',
  ],
};

/**
 * A first guess at which column is which, to be corrected on screen.
 *
 * A guess, and presented as one — every mapping is a dropdown ops can change,
 * and the preview underneath shows what the guess produced. The alternative is
 * an importer that silently decides "Spend" meant projected spend, and the only
 * evidence is a client's report a week later.
 *
 * Conservative in one specific direction: a bare "Leads" or "Admissions" column
 * maps to NOTHING. Those are real column names in every platform export and
 * they mean measured leads, which this product does not publish — mapping them
 * onto the projection columns would file a measurement as a forecast. Ops can
 * still point a projection at that column deliberately; the guess will not do
 * it for them.
 */
export function guessMapping(header: readonly string[]): Mapping {
  const taken = new Set<number>();
  const findOne = (key: keyof typeof SYNONYMS): number | null => {
    const list = SYNONYMS[key];
    const wantProjection = key.startsWith('projected_');

    // Exact first, across the whole header, before any loose match is tried —
    // otherwise a sheet with both "Spend" and "Spend (projected)" resolves to
    // whichever sits further left.
    for (const pass of ['exact', 'loose'] as const) {
      for (let i = 0; i < header.length; i++) {
        if (taken.has(i)) continue;
        const h = norm(header[i]);
        if (h === '') continue;
        // A projection column must say so, and a measurement column must not.
        // This is the check that keeps "Projected leads" out of `impressions`
        // and "Spend" out of `projected_leads`.
        if (PROJECTED.test(h) !== wantProjection && key !== 'date' && key !== 'campaign') continue;
        const hit =
          pass === 'exact' ? list.includes(h) : list.some((s) => h.startsWith(s) || h.includes(s));
        if (hit) {
          taken.add(i);
          return i;
        }
      }
    }
    return null;
  };

  const date = findOne('date');
  const campaign = findOne('campaign');
  const fields: Partial<Record<ImportField, number>> = {};
  for (const f of IMPORT_FIELDS) {
    const at = findOne(f);
    if (at !== null) fields[f] = at;
  }
  return { date, campaign, fields };
}

/**
 * Which row holds the headings.
 *
 * Sheets that people keep by hand almost always open with a title line — the
 * client's name, the month — and sometimes a blank row after it. Taking row one
 * on faith would make the title the header and the real headings the first row
 * of data, which then fails to parse as a date and reports the whole file as
 * broken. So: the first row that has at least two filled cells, most of which
 * do not look like numbers.
 */
export function guessHeaderRow(cells: readonly (readonly string[])[]): number {
  for (let i = 0; i < Math.min(cells.length, 20); i++) {
    const filled = cells[i].filter((c) => c.trim() !== '');
    if (filled.length < 2) continue;
    const wordy = filled.filter((c) => !Number.isFinite(Number(c.trim().replace(/,/g, ''))));
    if (wordy.length * 2 >= filled.length) return i;
  }
  return 0;
}

/* ---------------------------------------------------------------- dates --- */

export type DateStyle = 'dmy' | 'mdy';

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

/** True only if this really is a day in this month of this year. */
function assemble(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2200) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // 31 April parses happily as 1 May in almost every date library there is.
  // Rebuilding the string from a UTC Date and demanding it match is what makes
  // an impossible date report itself instead of quietly moving.
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Two-digit years: 26 is 2026, 98 is 1998. Nothing here dates from either. */
function fullYear(n: number): number {
  if (n >= 100) return n;
  return n < 80 ? 2000 + n : 1900 + n;
}

/**
 * One cell to an IST calendar date, or null.
 *
 * Real Excel date cells arrive as ISO already — `xlsx.ts` resolved them from
 * the serial number — so the interesting case is text, which is where the
 * ambiguity lives. See `inferDateStyle`.
 */
export function parseSheetDate(raw: string, style: DateStyle): string | null {
  const s = raw.trim();
  if (s === '') return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (iso) return assemble(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // '1 Sep 2026', '1-Sep-26', 'Sep 1, 2026' — a month name settles the order,
  // so these never consult `style`.
  const named = /^(\d{1,2})[\s\-/]*([a-z]{3,})[\s\-/,]*(\d{2,4})$/i.exec(s);
  if (named) {
    const m = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase());
    if (m >= 0) return assemble(fullYear(Number(named[3])), m + 1, Number(named[1]));
  }
  const named2 = /^([a-z]{3,})[\s\-/]*(\d{1,2})[\s\-/,]*(\d{2,4})$/i.exec(s);
  if (named2) {
    const m = MONTHS.indexOf(named2[1].slice(0, 3).toLowerCase());
    if (m >= 0) return assemble(fullYear(Number(named2[3])), m + 1, Number(named2[2]));
  }

  const numeric = /^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})$/.exec(s);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const c = Number(numeric[3]);
    // 'YYYY/MM/DD' is unambiguous from its shape alone.
    if (numeric[1].length === 4) return assemble(a, b, c);
    return style === 'dmy'
      ? assemble(fullYear(c), b, a)
      : assemble(fullYear(c), a, b);
  }

  return null;
}

/**
 * Whether the file's own dates decide day-first or month-first, and whether we
 * are guessing.
 *
 * This is the single most dangerous ambiguity in importing a spreadsheet, and
 * it is dangerous precisely because it never fails loudly: 03/09/2026 is a
 * valid date read either way, so a whole month of figures lands on the wrong
 * days and every one of them looks fine. Adovia is in India and writes
 * day-first; a platform export from a US account writes month-first; the file
 * itself carries no statement of which.
 *
 * So the file is asked. Any date with a first part over 12 can only be
 * day-first; any with a second part over 12 can only be month-first. One
 * example is proof for the whole column. When the column contains no such date
 * — a fortnight that happens to sit inside the first twelve days of a month —
 * nothing can be proved, `certain` is false, and the screen stops and makes ops
 * say which it is rather than defaulting quietly to the answer that is usually
 * right.
 */
export function inferDateStyle(raws: readonly string[]): {
  style: DateStyle;
  certain: boolean;
  /** True when the file contains evidence for BOTH readings — a broken column. */
  conflict: boolean;
} {
  let dmy = false;
  let mdy = false;
  let sawNumeric = false;

  for (const raw of raws) {
    const m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(raw.trim());
    if (!m) continue;
    sawNumeric = true;
    if (Number(m[1]) > 12) dmy = true;
    if (Number(m[2]) > 12) mdy = true;
  }

  if (dmy && mdy) return { style: 'dmy', certain: false, conflict: true };
  if (dmy) return { style: 'dmy', certain: true, conflict: false };
  if (mdy) return { style: 'mdy', certain: true, conflict: false };
  // No ambiguous text dates at all — every date was ISO or named, so the style
  // is never consulted and there is nothing to be uncertain about.
  return { style: 'dmy', certain: !sawNumeric, conflict: false };
}

/* ----------------------------------------------------------------- plan --- */

export type RowStatus = 'new' | 'changed' | 'unchanged' | 'blank' | 'blocked';

export interface Change {
  field: ImportField;
  from: number | null;
  to: number;
}

export interface PlannedRow {
  /** The row's own number in the sheet, 1-based, so the screen can point at it. */
  line: number;
  date: string | null;
  /** What was in the date cell, for naming it when it would not parse. */
  rawDate: string;
  /** As written in the file. Empty string means the unattributed line. */
  campaignName: string;
  /** Resolved campaign, or null for unattributed. Undefined when unmatched. */
  campaignId: string | null | undefined;
  status: RowStatus;
  /** Why this row cannot be written. Empty unless `status` is 'blocked'. */
  problem: string;
  changes: Change[];
  /** The stored row this one lands on, if there is one. */
  existing: DailyReport | null;
  /** Only the figures the file actually states. */
  stated: Partial<Record<ImportField, number>>;
}

export interface Plan {
  rows: PlannedRow[];
  /** Campaign names in the file that this client does not have, deduped. */
  unknownCampaigns: string[];
  counts: Record<RowStatus, number>;
  /** Dates the file touches, earliest first — what the preview summarises. */
  dates: string[];
}

export interface PlanInput {
  cells: readonly (readonly string[])[];
  headerRow: number;
  mapping: Mapping;
  dateStyle: DateStyle;
  campaigns: readonly Campaign[];
  /** Rows already stored for this client across the file's date range. */
  existing: readonly DailyReport[];
  /** The latest date that may be written — the server's business day. */
  maxDate: string;
  /** Campaign names ops has agreed to create, normalised the same way. */
  willCreate?: ReadonlySet<string>;
}

const keyOf = (date: string, campaignId: string | null) => `${date}:${campaignId ?? ''}`;

/**
 * Reads the sheet against what is already stored and says what would change.
 *
 * Every row lands in exactly one of five states, and the screen shows all five
 * — including `unchanged`, because "47 rows already match" is the sentence that
 * tells ops they are re-importing a file they have already run, which is
 * otherwise indistinguishable from an import that did nothing.
 */
export function buildPlan(input: PlanInput): Plan {
  const { cells, headerRow, mapping, dateStyle, campaigns, existing, maxDate, willCreate } =
    input;

  const stored = new Map<string, DailyReport>();
  for (const r of existing) stored.set(keyOf(r.date, r.campaign_id), r);

  const rows: PlannedRow[] = [];
  const unknown = new Map<string, string>();
  // (date, campaign) pairs already claimed by an earlier row of this same file.
  const seen = new Map<string, number>();

  for (let i = headerRow + 1; i < cells.length; i++) {
    const row = cells[i];
    const line = i + 1;
    const cell = (at: number | null | undefined) =>
      at === null || at === undefined ? '' : (row[at] ?? '').trim();

    const rawDate = cell(mapping.date);
    const campaignName = cell(mapping.campaign);

    // Only the cells that actually say something. A blank is silence, and
    // silence must not travel any further than this loop — see the module note.
    const statedRaw: Partial<Record<ImportField, string>> = {};
    for (const f of IMPORT_FIELDS) {
      const v = cell(mapping.fields[f]);
      if (v !== '') statedRaw[f] = v;
    }

    const blank = rawDate === '' && campaignName === '' && Object.keys(statedRaw).length === 0;
    if (blank) continue; // A spacer row in the sheet. Not worth reporting.

    const head = { line, rawDate, campaignName };
    const block = (problem: string, date: string | null = null): PlannedRow => ({
      ...head,
      date,
      campaignId: undefined,
      status: 'blocked',
      problem,
      changes: [],
      existing: null,
      stated: {},
    });

    const date = parseSheetDate(rawDate, dateStyle);
    if (date === null) {
      rows.push(block(rawDate === '' ? 'No date on this row.' : `“${rawDate}” is not a date.`));
      continue;
    }
    if (date > maxDate) {
      rows.push(
        block(`${date} has not happened yet — figures cannot be stated for a future day.`, date),
      );
      continue;
    }

    /*
      Campaign resolution.

      `nameClash` is the same normaliser the create and rename screens use for
      "are these the same campaign", so an imported "google ads " matches the
      "Google Ads" ops created, exactly as a retyped one would. Sharing it is
      the point: a second notion of sameness here would let an import create a
      duplicate that `CampaignManager` would have refused.

      A name this client does not have is BLOCKED, not created. A typo in a
      spreadsheet would otherwise become a campaign — and campaign names are
      client-facing copy that lands in their breakdown, so "Goggle Ads" beside
      "Google Ads" is two rows a client cannot tell apart. Creating them is
      available, but only as something ops opts into after reading the list.
    */
    let campaignId: string | null | undefined = null;
    /** This row's identity within the file, for spotting the same slot twice. */
    let slot: string | null = null;

    if (campaignName !== '') {
      const key = campaignName.toLowerCase();
      const match = nameClash(campaigns, campaignName);
      if (match) {
        campaignId = match.id;
        slot = match.id;
      } else {
        unknown.set(key, campaignName);
        if (!willCreate?.has(key)) {
          rows.push(block(`This client has no campaign called “${campaignName}”.`, date));
          continue;
        }
        // Agreed to be created. It has no id until the write happens, which is
        // what `undefined` means here — distinct from the `null` of a row that
        // genuinely belongs to no campaign.
        campaignId = undefined;
        slot = `new:${key}`;
      }
    }

    const dupKey = keyOf(date, slot);
    const dup = seen.get(dupKey);
    if (dup !== undefined) {
      rows.push(
        block(
          `The same day and campaign is also on row ${dup}. Consolidate them in the sheet — ` +
            'this will not add them together, and it will not guess which one you meant.',
          date,
        ),
      );
      continue;
    }
    seen.set(dupKey, line);

    const parsed: Partial<Record<ImportField, number>> = {};
    let bad: string | null = null;
    for (const f of IMPORT_FIELDS) {
      const raw = statedRaw[f];
      if (raw === undefined) continue;
      const n = parseFigure(raw);
      if (n === null) {
        bad = `“${raw}” is not a figure this can store. Figures cannot be negative or text.`;
        break;
      }
      parsed[f] = n;
    }
    if (bad) {
      rows.push(block(bad, date));
      continue;
    }

    if (Object.keys(parsed).length === 0) {
      // A row naming a day and a campaign and stating no figure. Not an error
      // — a sheet often carries the shape of a month before it is filled in —
      // but nothing to write either.
      rows.push({
        ...head,
        date,
        campaignId,
        status: 'blank',
        problem: '',
        changes: [],
        existing: null,
        stated: {},
      });
      continue;
    }

    // A campaign that does not exist yet cannot have a stored row, so this
    // lookup correctly misses and the row reads as new.
    const prior = campaignId === undefined ? null : (stored.get(keyOf(date, campaignId)) ?? null);
    const changes: Change[] = [];
    for (const f of IMPORT_FIELDS) {
      const to = parsed[f];
      if (to === undefined) continue;
      const from = prior ? prior[f] : null;
      if (from !== to) changes.push({ field: f, from, to });
    }

    rows.push({
      ...head,
      date,
      campaignId,
      status: prior === null ? 'new' : changes.length === 0 ? 'unchanged' : 'changed',
      problem: '',
      existing: prior,
      stated: parsed,
      changes,
    });
  }

  const counts: Record<RowStatus, number> = {
    new: 0,
    changed: 0,
    unchanged: 0,
    blank: 0,
    blocked: 0,
  };
  for (const r of rows) counts[r.status]++;

  const dates = [...new Set(rows.filter((r) => r.date).map((r) => r.date as string))].sort();

  return { rows, unknownCampaigns: [...unknown.values()].sort(), counts, dates };
}

/* -------------------------------------------------------------- payload --- */

/**
 * The rows to send, merged onto what is already stored.
 *
 * Every one of the eight figures and the client note is present in every
 * object, taken from the stored row unless the file states otherwise. That is
 * what stops an import of two columns from blanking the six it says nothing
 * about — an upsert replaces the columns it names, so naming only the imported
 * ones and letting the rest default would clear them.
 *
 * `id` is deliberately absent. The conflict target `(client_id, campaign_id,
 * date)` already identifies the row, and including a fresh `id` on a row that
 * turns out to collide would rewrite the stored row's primary key — which
 * `daily_report_notes` points at.
 */
export function payloadFor(
  rows: readonly PlannedRow[],
  clientId: string,
  resolveCampaign: (name: string) => string | null,
): Record<string, unknown>[] {
  return rows
    .filter((r) => (r.status === 'new' || r.status === 'changed') && r.date !== null)
    .map((r) => {
      const prior = r.existing;
      const figures = REPORT_FIELDS.reduce(
        (acc, f) => {
          const stated = (r.stated as Partial<Record<ReportField, number>>)[f];
          acc[f] = stated !== undefined ? stated : (prior?.[f] ?? null);
          return acc;
        },
        {} as Record<ReportField, number | null>,
      );

      return {
        client_id: clientId,
        campaign_id:
          r.campaignId === undefined
            ? (r.campaignName === '' ? null : resolveCampaign(r.campaignName))
            : r.campaignId,
        date: r.date,
        ...figures,
        // Never written by an import, only carried. A note is prose somebody
        // wrote for this client about this day; a spreadsheet has no column
        // for it and must not silently erase one.
        client_note: prior?.client_note ?? null,
      };
    });
}
