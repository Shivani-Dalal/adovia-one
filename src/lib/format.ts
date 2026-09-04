/**
 * Number formatting. Every function here treats `null` as "not yet entered" and
 * returns null for it, so callers are forced to choose a rendering rather than
 * falling into a zero by accident. That distinction is the product's whole
 * claim; see `Figure`.
 */

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const INR_PAISE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// en-IN groups as 12,34,567 — lakhs and crores. A client reading a spend figure
// checks it against their own records at a glance, and Western grouping makes
// them stop and count digits.
const COUNT = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export function money(n: number | null | undefined): string | null {
  return n === null || n === undefined ? null : INR.format(n);
}

/** Paise shown. For invoice amounts, where the exact figure is the point. */
export function moneyExact(n: number | null | undefined): string | null {
  return n === null || n === undefined ? null : INR_PAISE.format(n);
}

export function count(n: number | null | undefined): string | null {
  return n === null || n === undefined ? null : COUNT.format(n);
}

/**
 * Compact form for chart axes only — '₹1.2L', '4.5Cr'. Never used for a headline
 * figure: a client checking ₹1.2L against their own ₹1,23,400 cannot tell
 * whether it matches.
 */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return COUNT.format(n);
}

/**
 * Month-over-month delta. Returns null when there is nothing honest to say —
 * no prior figure, or a prior figure of zero, where the percentage is either
 * undefined or infinite.
 */
export function delta(
  current: number | null,
  previous: number | null,
): { pct: number; direction: 'up' | 'down' | 'flat' } | null {
  if (current === null || previous === null || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  return {
    pct: Math.abs(pct),
    direction: pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat',
  };
}

/**
 * Parses a figure typed into the entry grid.
 *
 * Empty string means null — cleared, not zero. Ops must be able to un-state a
 * number they entered by mistake, and the only way back to "not yet entered" is
 * for a blank cell to round-trip as null.
 */
export function parseFigure(raw: string): number | null {
  const s = raw.trim().replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** True when the string is present but not a number we would store. */
export function isBadFigure(raw: string): boolean {
  const s = raw.trim().replace(/,/g, '');
  if (s === '') return false;
  const n = Number(s);
  return !Number.isFinite(n) || n < 0;
}

/** Plain digits for an <input>, so editing does not fight the grouping. */
export function toInput(n: number | null | undefined): string {
  return n === null || n === undefined ? '' : String(n);
}

/**
 * Formats a figure the way its own field should read — rupees for spend, plain
 * counts for everything else.
 *
 * The branch is here rather than at each call site because the two places that
 * render a figure generically (the outlier prompt and the history diff) were
 * each deciding it themselves, and a spend shown without its ₹ in a dialog
 * asking "is this number right?" is the one place the unit has to be obvious.
 */
export function byField(
  field: string,
  n: number | null | undefined,
): string | null {
  return field === 'ad_spend' ? money(n) : count(n);
}
