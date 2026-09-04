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
 * The two operations are not symmetrical, and the asymmetry is the schema's, not
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
 *   - A CLIENT deletes everything. `daily_report`, `daily_actuals`, `campaigns`,
 *     `invoices` and `creatives` all cascade, so one row disappearing takes the
 *     entire account with it: every day of figures, every invoice, every file.
 *     Nothing here can soften that, so `clientUsage` counts it precisely and the
 *     UI is expected to print the count and make the admin type the name.
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
