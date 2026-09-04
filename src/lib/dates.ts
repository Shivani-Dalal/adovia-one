import { supabase } from './supabase';

/**
 * Dates in this app are plain IST calendar dates carried as 'YYYY-MM-DD'
 * strings, never as Date objects. Two rules, both learned the hard way:
 *
 *   - `new Date()` follows whoever is travelling.
 *   - `.toISOString().slice(0, 10)` is UTC, and between 00:00 and 05:30 IST it
 *     names yesterday — the identical off-by-one that business_today() exists
 *     to prevent on the server.
 *
 * Where arithmetic is needed we parse the string into a UTC midnight Date, do
 * the sum there, and format it straight back out. UTC is safe *as a container*
 * precisely because no timezone conversion ever happens on the way in or out.
 */

export type ISODate = string; // 'YYYY-MM-DD'

const IST = 'Asia/Kolkata';

/**
 * Today in IST, computed in the browser. Use this only for immediate UI needs
 * (the max on a date input before the RPC resolves). Anything that decides what
 * data exists asks the server — see `businessToday`.
 */
export function istTodayLocal(): ISODate {
  // 'en-CA' formats as YYYY-MM-DD, which is the one thing it is good for.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** The server's business day. One round trip, cached for the session. */
let cachedToday: ISODate | null = null;
export async function businessToday(): Promise<ISODate> {
  if (cachedToday) return cachedToday;
  const { data, error } = await supabase.rpc('business_today');
  // A failed RPC should not take down a screen over a date input's max
  // attribute; the browser's IST answer differs only if the clock is wrong.
  cachedToday = error || !data ? istTodayLocal() : (data as ISODate);
  return cachedToday;
}

function toUTC(d: ISODate): Date {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

function fromUTC(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: ISODate, n: number): ISODate {
  const d = toUTC(date);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTC(d);
}

/** First day of `date`'s month. */
export function monthStart(date: ISODate): ISODate {
  return `${date.slice(0, 7)}-01`;
}

/** First day of the month after `date`'s — the exclusive end of a month range. */
export function nextMonthStart(date: ISODate): ISODate {
  const d = toUTC(monthStart(date));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return fromUTC(d);
}

/** 'YYYY-MM' — the key the invoice month dropdown is built on. */
export function monthKey(date: ISODate): string {
  return date.slice(0, 7);
}

/** 'August 2026' from either a full date or a 'YYYY-MM' key. */
export function monthLabel(dateOrKey: string): string {
  const iso = dateOrKey.length === 7 ? `${dateOrKey}-01` : dateOrKey;
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    month: 'long',
    year: 'numeric',
  }).format(toUTC(iso));
}

/** '1 Sep 2026' — the label under every client-facing figure. */
export function formatDate(date: ISODate): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(toUTC(date));
}

/** 'Monday, 1 September' — used where the date is the heading. */
export function formatDateLong(date: ISODate): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(toUTC(date));
}

/**
 * The freshness stamp. Takes a real timestamptz — not a calendar date — so
 * ordinary Date maths is correct here.
 *
 * Deliberately vague past a day: "updated 3 days ago" is the honest reading of a
 * row nobody has touched, and rounding it to "last week" would soften exactly
 * the signal this product exists to show.
 */
export function relativeTime(ts: string): string {
  const then = new Date(ts).getTime();
  const mins = Math.round((Date.now() - then) / 60_000);

  if (!Number.isFinite(mins)) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;

  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;

  const days = Math.round(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;

  return `on ${formatDate(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: IST,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ts)),
  )}`;
}

/** Absolute IST timestamp for the `title` attribute under a relative stamp. */
export function formatTimestamp(ts: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ts));
}
