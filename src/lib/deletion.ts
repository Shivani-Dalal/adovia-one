/**
 * What a delete would actually destroy, asked before the delete is offered.
 *
 * Every screen that removes a client or a campaign asks these questions first,
 * from here, so the answer is the same one everywhere. The alternative — a
 * delete button that just tries it — pushes the check into the database, and
 * what comes back is a foreign-key violation: a message that is true, useless to
 * the person reading it, and arrives only once the click has been made. The
 * point of this module is that the UI can say what will happen *before* asking
 * anyone to confirm it.
 *
 * The operations are not symmetrical, and the asymmetry is the schema's, not
 * a choice made here:
 *
 *   - A CAMPAIGN cannot be deleted once it carries a figure. `daily_report` and
 *     `daily_actuals` both point at it `on delete restrict`, so the database
 *     refuses. That is the right refusal — deleting the campaign would mean
 *     deleting figures the client has already been shown — and `campaignUsage`
 *     exists so a screen can disable the button and say why instead of throwing
 *     the client a database error. Archiving is the operation for a campaign
 *     that ran.
 *
 *     There is now a way through that refusal, and it is deliberately not a
 *     softening of it. `deleteCampaignData` removes a campaign's figures a month
 *     at a time; once none are left the campaign is free and `deleteCampaign`
 *     succeeds on its own. The database's rule is unchanged — you still cannot
 *     destroy a campaign and keep its figures, or destroy it without noticing
 *     they went. What changed is that destroying the figures is now a separate,
 *     named, counted operation instead of an error message, because "this test
 *     campaign should never have existed" is a real thing to want and the
 *     alternative was a hand-written DELETE against production.
 *
 *   - A CLIENT deletes everything. `daily_report`, `daily_actuals`, `campaigns`,
 *     `invoices` and `creatives` all cascade, so one row disappearing takes the
 *     entire account with it: every day of figures, every invoice, every file.
 *     Nothing here can soften that, so `clientUsage` counts it precisely and the
 *     UI is expected to print the count and make the admin type the name.
 *
 *   - An INVOICE deletes freely — nothing references it — which is exactly why
 *     `deleteInvoice` carries a warning instead of a check. The database has no
 *     objection to destroying a document a client has already been sent, so the
 *     restraint has to come from the screen. See the note on that function.
 *
 * The one thing that stops a client delete outright is `profiles.client_id`,
 * which is `on delete restrict`: a client somebody can still log in as cannot be
 * removed. That one is NOT counted up front, and the reason is worth stating,
 * because the obvious code here would be wrong. RLS on `profiles` is `id =
 * auth.uid()` — every user, admin included, can read exactly their own row — so
 * a count of the profiles pointing at a client comes back as 0 for a client with
 * five logins. Counting it would produce a confident, wrong "nobody can sign in
 * as this client" and a delete that then fails on a foreign key. So the database
 * is left to answer the question it is the only one able to answer, and
 * `deleteClient` translates that refusal into a sentence. If admins are ever
 * given read access to profiles, this can become an up-front check; until then a
 * count would be a guess wearing a fact's clothes.
 */

import { monthKey, monthStart, nextMonthStart } from './dates';
import { supabase, errorText } from './supabase';
import type { Client } from './types';

/** A stored file, and the bucket it lives in. Cascades do not reach storage. */
export interface StoredFile {
  bucket: 'invoices' | 'creatives';
  path: string;
}

/**
 * Counts rows, and treats "I could not count" as different from "none".
 *
 * PostgREST returns the count in a header, and a null count with no error is
 * not zero — it is an unanswered question. Reading it as zero here would light
 * up a delete button on the strength of a query that failed, which is the exact
 * shape of bug this module exists to prevent.
 */
async function countRows(
  table: string,
  column: string,
  value: string,
): Promise<{ count: number | null; error: string | null }> {
  const { count, error } = await supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq(column, value);

  if (error) return { count: null, error: errorText(error) };
  if (typeof count !== 'number') {
    return { count: null, error: `Could not count ${table} rows for this ${column}.` };
  }
  return { count, error: null };
}

/** What a campaign carries, and therefore whether it can go. */
export interface CampaignUsage {
  /** Client-facing rows — days this campaign has published figures for. */
  report: number;
  /** Internal measurement rows. Invisible to the client, still a blocker. */
  actuals: number;
  /** True only when nothing points here, which is when the database will allow it. */
  free: boolean;
}

export async function campaignUsage(
  campaignId: string,
): Promise<{ usage: CampaignUsage | null; error: string | null }> {
  const [rep, act] = await Promise.all([
    countRows('daily_report', 'campaign_id', campaignId),
    countRows('daily_actuals', 'campaign_id', campaignId),
  ]);

  const err = rep.error ?? act.error;
  if (err !== null || rep.count === null || act.count === null) {
    return { usage: null, error: err ?? 'Could not check what this campaign carries.' };
  }

  return {
    usage: { report: rep.count, actuals: act.count, free: rep.count + act.count === 0 },
    error: null,
  };
}

/**
 * Deletes a campaign, and only ever one that carries nothing.
 *
 * The usage check is repeated here rather than trusted from the caller. It is
 * one round trip against a race that is entirely plausible on this product —
 * two admins on the daily grid, one entering the first figure against a new
 * campaign while the other tidies it away — and losing that race means the
 * delete fails on a foreign key, which is at least safe. The check turns that
 * into a sentence instead.
 */
export async function deleteCampaign(campaignId: string): Promise<{ error: string | null }> {
  const { usage, error } = await campaignUsage(campaignId);
  if (error !== null || !usage) return { error: error ?? 'Could not check this campaign.' };
  if (!usage.free) {
    return {
      error:
        'This campaign now has figures against it. It can be archived, but not deleted — deleting it would delete those figures too.',
    };
  }

  // `.select()` so the deleted row comes back. Without it a delete that RLS
  // filtered to nothing returns success with no error, and the screen would
  // report a campaign gone that is still there — the one failure mode worse
  // than a delete that fails loudly.
  const { data, error: err } = await supabase
    .from('campaigns')
    .delete()
    .eq('id', campaignId)
    .select('id');
  if (err) return { error: errorText(err) };
  if ((data ?? []).length === 0) {
    return { error: 'Nothing was deleted. The campaign may already be gone, or not yours to remove.' };
  }
  return { error: null };
}

/* ------------------------------------------------- a campaign's figures --- */

/**
 * One month of what a campaign holds, and therefore what deleting it destroys.
 *
 * `spend` is here because it is the sentence that stops the wrong click. "31
 * days" is a quantity of rows and reads as housekeeping; "31 days and
 * ₹80,02,932 of spend the client has been shown" is the same fact in the terms
 * the person deciding actually thinks in. It is summed from the stated values
 * only — a month that states no spend reports null, not 0, for the same reason
 * every other total in this product does.
 *
 * `clientNotes` counts prose somebody wrote for this client about these days,
 * and `internalNotes` counts the admin-only ones in `daily_report_notes`, which
 * cascade from the report row without any screen mentioning them. Figures can be
 * re-imported from the sheet they came from. A note cannot — it was typed once,
 * from something somebody knew at the time, and nothing else in the system holds
 * a copy. Counting them separately is what lets the dialog say so.
 */
export interface CampaignMonth {
  /** 'YYYY-MM'. */
  month: string;
  reportRows: number;
  reportDays: number;
  actualRows: number;
  spend: number | null;
  clientNotes: number;
  internalNotes: number;
}

/**
 * `.in()` in batches, because a filter is a URL.
 *
 * Every id goes into the query string, so one request for a campaign with two
 * years of days is a ~27KB URL — over the limit of several proxies, and the
 * failure is a 414 rather than anything this code would recognise. Chunking
 * keeps it to four short requests a year instead of one that works in testing
 * and breaks on the first campaign anybody has actually run for a while.
 */
async function notedIds(ids: readonly string[]): Promise<{ noted: Set<string>; error: string | null }> {
  const noted = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase
      .from('daily_report_notes')
      .select('metric_id')
      .in('metric_id', ids.slice(i, i + 100));
    if (error) return { noted, error: errorText(error) };
    for (const r of (data ?? []) as { metric_id: string }[]) noted.add(r.metric_id);
  }
  return { noted, error: null };
}

/**
 * Every month this campaign has figures in, newest first.
 *
 * Both tables are read in full rather than counted per month, because the month
 * grouping has to happen somewhere and PostgREST will not do it. The volume is
 * bounded by days of operation — a campaign running for five years is under two
 * thousand rows — and the alternative is a `group by` that would need a database
 * function, which is a lot of moving parts for a dialog that opens rarely.
 *
 * A campaign holding nothing returns an empty list, and that is the answer that
 * means "this one can simply be deleted", not an error.
 */
export async function campaignMonths(
  campaignId: string,
): Promise<{ months: CampaignMonth[]; error: string | null }> {
  const [rep, act] = await Promise.all([
    supabase
      .from('daily_report')
      .select('id, date, ad_spend, client_note')
      .eq('campaign_id', campaignId),
    supabase.from('daily_actuals').select('date').eq('campaign_id', campaignId),
  ]);

  if (rep.error) return { months: [], error: errorText(rep.error) };
  if (act.error) return { months: [], error: errorText(act.error) };

  type Row = { id: string; date: string; ad_spend: number | null; client_note: string | null };
  const reports = (rep.data ?? []) as Row[];
  const actuals = (act.data ?? []) as { date: string }[];

  const { noted, error: noteErr } = await notedIds(reports.map((r) => r.id));
  if (noteErr !== null) return { months: [], error: noteErr };

  const by = new Map<string, CampaignMonth & { days: Set<string> }>();
  const at = (date: string) => {
    const k = monthKey(date);
    let m = by.get(k);
    if (!m) {
      m = {
        month: k,
        reportRows: 0,
        reportDays: 0,
        actualRows: 0,
        spend: null,
        clientNotes: 0,
        internalNotes: 0,
        days: new Set<string>(),
      };
      by.set(k, m);
    }
    return m;
  };

  for (const r of reports) {
    const m = at(r.date);
    m.reportRows++;
    m.days.add(r.date);
    // null stays null until something states a figure — a month of blank spend
    // reports "not stated", not zero.
    if (typeof r.ad_spend === 'number') m.spend = (m.spend ?? 0) + r.ad_spend;
    if (r.client_note !== null && r.client_note.trim() !== '') m.clientNotes++;
    if (noted.has(r.id)) m.internalNotes++;
  }
  for (const a of actuals) at(a.date).actualRows++;

  const months = [...by.values()]
    .map(({ days, ...m }): CampaignMonth => ({ ...m, reportDays: days.size }))
    .sort((a, b) => b.month.localeCompare(a.month));

  return { months, error: null };
}

/** What a data delete actually removed, counted from what came back. */
export interface DataDeletion {
  error: string | null;
  reportRows: number;
  actualRows: number;
}

/**
 * Deletes a campaign's figures, for one month or for all of them.
 *
 * This is the only operation in the product that destroys figures a client has
 * already read, so two things about it are deliberate.
 *
 * It is scoped by `campaign_id` and never by client alone. A month filter with
 * no campaign would be one missing argument away from clearing every campaign's
 * August, and the screens that would call it are the ones with a month dropdown
 * already on them.
 *
 * `month` is 'YYYY-MM' or null for everything, and null is spelled out by the
 * caller rather than arrived at by an empty string or an undefined variable —
 * `deleteCampaignData(id, undefined)` would otherwise be a plausible typo that
 * silently means "all of it".
 *
 * `daily_report_history` is not touched. It has no foreign key here and records
 * who changed which figure and when; an account correcting its data is not a
 * reason for the record of the correction to vanish. It is admin-only and
 * unreachable from any client screen. It is NOT a backup — a row imported once
 * and never edited has no history at all — so nothing here or in the UI offers
 * it as one.
 */
export async function deleteCampaignData(
  campaignId: string,
  month: string | null,
): Promise<DataDeletion> {
  const scope = <T extends { gte: (c: string, v: string) => T; lt: (c: string, v: string) => T }>(
    q: T,
  ): T => {
    if (month === null) return q;
    const from = monthStart(`${month}-01`);
    return q.gte('date', from).lt('date', nextMonthStart(from));
  };

  // Report rows first: they are the client-facing ones, so if only one of the
  // two deletes lands, the half that ran is the half that changes what a client
  // sees — and the leftover actuals are internal and visible to the retry.
  //
  // `.select('id')` on both, for the reason every delete here does it: an
  // RLS-filtered delete returns success with no rows and no error, and
  // reporting "31 days deleted" for a delete that touched nothing is worse than
  // any failure. The counts printed to the admin are these, not the ones the
  // preview predicted.
  const rep = await scope(supabase.from('daily_report').delete().eq('campaign_id', campaignId))
    .select('id');
  if (rep.error) return { error: errorText(rep.error), reportRows: 0, actualRows: 0 };

  const act = await scope(supabase.from('daily_actuals').delete().eq('campaign_id', campaignId))
    .select('id');
  const reportRows = (rep.data ?? []).length;
  if (act.error) {
    return {
      error: `${reportRows} report row${reportRows === 1 ? '' : 's'} were deleted, but the internal actuals could not be: ${errorText(act.error)}`,
      reportRows,
      actualRows: 0,
    };
  }

  return { error: null, reportRows, actualRows: (act.data ?? []).length };
}

/** The outcome of an invoice delete: gone, plus whether the PDF went with it. */
export interface InvoiceDeletion {
  error: string | null;
  /** True when the row went but the PDF did not. Not a failure — see below. */
  orphaned: boolean;
}

/**
 * Deletes one invoice, and the PDF behind it.
 *
 * This is the odd one out in this module, because deleting an invoice is not
 * usually the right operation and the UI is expected to say so. An invoice that
 * was issued is a document a client may already hold a copy of, and `void` is
 * how this product retracts one — see the note `InvoiceTable` prints under a
 * voided row. Delete is for the upload that should never have happened: the
 * wrong PDF, the wrong client, a number typed twice. Those leave nothing worth
 * keeping a record of, and `unique (client_id, number)` means a mistyped number
 * genuinely does have to go before it can be reused.
 *
 * Row first, then the file, for the reason `deleteClient` gives at length: of
 * the two ways to fail halfway, only one is visible to a client. A file with no
 * row is unreachable — every download is a signed URL minted from
 * `invoices.storage_path` — so it costs bytes. A row with no file is an invoice
 * sitting in the client's list that 404s when they click it.
 *
 * `orphaned` is reported rather than swallowed so the screen can say "deleted,
 * but the file is still in the bucket" instead of quietly leaving litter that
 * only shows up on a storage bill.
 */
export async function deleteInvoice(invoice: {
  id: string;
  number: string;
  storage_path: string;
}): Promise<InvoiceDeletion> {
  // `.select()` for the same reason as the two deletes below: a delete that RLS
  // filtered to nothing comes back successful and empty, and reporting an
  // invoice gone while it is still on the client's screen is worse than failing.
  const { data, error } = await supabase
    .from('invoices')
    .delete()
    .eq('id', invoice.id)
    .select('id');

  if (error) return { error: errorText(error), orphaned: false };
  if ((data ?? []).length === 0) {
    return {
      error: `Nothing was deleted. Invoice ${invoice.number} may already be gone, or not yours to remove.`,
      orphaned: false,
    };
  }

  // Best effort, and deliberately not an error. The row is what made the file
  // reachable; without it the object is dead weight rather than an exposure.
  const { data: removed, error: rmErr } = await supabase.storage
    .from('invoices')
    .remove([invoice.storage_path]);

  return { error: null, orphaned: Boolean(rmErr) || (removed?.length ?? 0) === 0 };
}

/** Everything a client delete would take with it. */
export interface ClientUsage {
  /** Client-facing rows. Several per day when the client is split by campaign. */
  reportRows: number;
  /** Distinct dates behind those rows — the "days of figures" a person counts in. */
  reportDays: number;
  actualRows: number;
  campaigns: number;
  invoices: number;
  creatives: number;
  /** The files behind the invoices and creatives, which no cascade will remove. */
  files: StoredFile[];
}

export async function clientUsage(
  clientId: string,
): Promise<{ usage: ClientUsage | null; error: string | null }> {
  // `daily_report` comes back as dates rather than as a count, because a person
  // deciding whether to destroy an account thinks in days, not in rows: "94 days
  // of figures" is the fact, and "228 rows" is our storage grain leaking into a
  // confirmation dialog. Both are reported; the days are the ones to print.
  const [rep, act, camps, invs, creas] = await Promise.all([
    supabase.from('daily_report').select('date').eq('client_id', clientId),
    countRows('daily_actuals', 'client_id', clientId),
    countRows('campaigns', 'client_id', clientId),
    supabase.from('invoices').select('storage_path').eq('client_id', clientId),
    supabase.from('creatives').select('storage_path').eq('client_id', clientId),
  ]);

  const err =
    (rep.error && errorText(rep.error)) ??
    act.error ??
    camps.error ??
    (invs.error && errorText(invs.error)) ??
    (creas.error && errorText(creas.error)) ??
    null;
  if (err !== null || act.count === null || camps.count === null) {
    return { usage: null, error: err ?? 'Could not check what this client holds.' };
  }

  const dates = (rep.data ?? []) as { date: string }[];
  const invoices = (invs.data ?? []) as { storage_path: string }[];
  const creatives = (creas.data ?? []) as { storage_path: string }[];

  return {
    usage: {
      reportRows: dates.length,
      reportDays: new Set(dates.map((d) => d.date)).size,
      actualRows: act.count,
      campaigns: camps.count,
      invoices: invoices.length,
      creatives: creatives.length,
      files: [
        ...invoices
          .filter((i) => i.storage_path)
          .map((i): StoredFile => ({ bucket: 'invoices', path: i.storage_path })),
        ...creatives
          .filter((c) => c.storage_path)
          .map((c): StoredFile => ({ bucket: 'creatives', path: c.storage_path })),
      ],
    },
    error: null,
  };
}

/** The outcome of a client delete: gone, plus whatever could not be tidied up. */
export interface ClientDeletion {
  error: string | null;
  /** Files the cascade left behind and this could not remove. Not a failure. */
  orphaned: number;
}

/**
 * Deletes a client, then the files their rows pointed at.
 *
 * The order matters and it is the less obvious one. Removing the storage
 * objects first would mean that a failure between the two steps leaves a live
 * client whose invoices download as 404s — a broken account, on screen, for a
 * paying customer. Doing the row first means a failure between the steps leaves
 * files in a bucket that nothing references: invisible, costs a few kilobytes,
 * and reported back as `orphaned` so it can be said out loud rather than
 * discovered. Of the two ways to fail, only one of them is visible to a client.
 *
 * The paths have to be read before the delete, since the cascade takes the rows
 * that name them — hence `files`, which the caller gets from `clientUsage`.
 *
 * Not removed: `daily_report_history`, which has no foreign key here and so
 * survives. That is deliberate on the schema's part — it is the audit trail of
 * who changed which figure, and an account being deleted is not a reason for the
 * record of its edits to disappear. It is admin-only and unreachable from any
 * client screen.
 */
export async function deleteClient(
  client: Client,
  files: readonly StoredFile[],
): Promise<ClientDeletion> {
  // `.select()` for the same reason as the campaign delete: an RLS-filtered
  // delete is silent, and "deleted" is not something to report on faith.
  const { data, error: err } = await supabase
    .from('clients')
    .delete()
    .eq('id', client.id)
    .select('id');
  if (err) {
    // 23503 on this delete has exactly one cause: `profiles.client_id` is the
    // only thing left pointing here that does not cascade. Said in the admin's
    // terms rather than the database's, and said as an instruction — the block
    // is removable, by removing the login first, which is a separate decision
    // somebody has to make on purpose.
    const code = (err as { code?: string }).code;
    if (code === '23503') {
      return {
        error: `Somebody can still sign in as ${client.name}, so the database will not remove them. Nothing was deleted. Remove that login first, then delete the client.`,
        orphaned: 0,
      };
    }
    return { error: errorText(err), orphaned: 0 };
  }
  if ((data ?? []).length === 0) {
    return {
      error: 'Nothing was deleted. The client may already be gone, or not yours to remove.',
      orphaned: 0,
    };
  }

  let orphaned = 0;
  for (const bucket of ['invoices', 'creatives'] as const) {
    const paths = files.filter((f) => f.bucket === bucket).map((f) => f.path);
    if (paths.length === 0) continue;
    const { data, error } = await supabase.storage.from(bucket).remove(paths);
    // `remove` reports per-file, so a partial success is possible: count what
    // did not come back as removed rather than assuming all-or-nothing.
    if (error) orphaned += paths.length;
    else orphaned += paths.length - (data?.length ?? 0);
  }

  return { error: null, orphaned };
}
