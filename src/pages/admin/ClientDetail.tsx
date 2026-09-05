import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase, errorText } from '../../lib/supabase';
import { Blank, Card, Empty, ErrorNote, PageHead, Shell, Stat } from '../../components/Shell';
import { money, moneyExact, count } from '../../lib/format';
import { download, fileSlug, num, toCsvText } from '../../lib/csv';
import {
  campaignCsv,
  monthRows,
  monthsWithCounts,
  spendCsv,
  spendTotals,
  SPEND_FIELDS,
  SPEND_ACCRUING_FIELDS,
} from '../../lib/spendReport';
import {
  campaignKey,
  campaignNamer,
  foldToDays,
  isSplit,
  pickCampaign,
  sliceByCampaign,
  CAMPAIGN_ALL,
} from '../../lib/campaigns';
import {
  formatDate,
  monthKey,
  monthLabel,
  relativeTime,
  formatTimestamp,
} from '../../lib/dates';
import {
  REPORT_COLS,
  rows as asRows,
  type Campaign,
  type Client,
  type Creative,
  type DailyReport,
  type Invoice,
  type DailyActuals,
} from '../../lib/types';
import { InvoiceTable } from '../../components/InvoiceTable';
import { CreativeList } from '../../components/CreativeList';
import { InvoiceUpload } from './InvoiceUpload';
import { InviteUser } from './InviteUser';
import { CampaignManager } from './CampaignManager';

/**
 * Which account of this client is on screen.
 *
 * These are not tabs over one dataset. `client` and `internal` are the two things
 * this product keeps apart: what Adovia *stated* to the client, and what Adovia
 * *measured*. Rendering them together was convenient for comparison and wrong for
 * everything else — an account manager on a screenshare had no way to show the
 * client their own figures without internal measurements in the same frame, and a
 * table whose columns alternate stated/measured is one mis-read row away from
 * quoting the wrong number back on a call.
 *
 * There was a third view here, `variance`, which rendered the gap between the two
 * and neither side's figures. It has been removed along with `lib/variance`. Note
 * what went with it: nothing in this product now compares what Adovia stated
 * against what Adovia measured. Both records are still kept, and a gap between
 * them is still a fact in the database, but no screen will point one out. Working
 * one out means exporting the two sheets and comparing them by hand.
 *
 * So the separation is at the page level rather than at the column level. You are
 * in exactly one of the two, it says which at the top, and nothing from the other
 * is rendered at all.
 */
type View = 'client' | 'internal';

const ACTUALS_HEADERS = [
  'Date',
  // Always present, even for a client who is not split. A column that appears
  // and disappears depending on the client makes two months of the same
  // client's exports impossible to stack, and the day a client IS split the
  // older files would be the ones missing the column that explains the
  // duplicate dates in the newer ones.
  'Campaign',
  'Actual impressions',
  'Actual leads',
  'Actual admissions',
  'Internal note',
] as const;

/**
 * The internal sheet as CSV — measured figures only, plus the note on them.
 *
 * Deliberately carries no "stated" column. This file is Adovia's own record; the
 * moment it also contains the published figures it becomes a document that is
 * dangerous to forward, and the client-facing numbers already have their own
 * export that the client can produce identically. Two files, two purposes.
 *
 * The note travels with the figures rather than being held back as the more
 * sensitive half. It is not: it is the sentence that stops a bare number being
 * misread six months later, and an impressions column exported without "platform
 * double-counted until we caught it" is the more dangerous file of the two.
 *
 * Rows are per campaign-day, so a date can appear several times. The campaign
 * column is what makes that legible — and what makes the file pivotable, which
 * is the only reason to export it rather than read the table.
 */
function actualsCsv(lines: DailyActuals[], name: (id: string | null) => string): string {
  return toCsvText([
    [...ACTUALS_HEADERS],
    ...lines.map((a) => [
      a.date,
      name(a.campaign_id),
      num(a.impressions),
      num(a.leads),
      num(a.admissions),
      a.note ?? '',
    ]),
  ]);
}

export default function ClientDetail() {
  const { id = '' } = useParams();

  const [client, setClient] = useState<Client | null>(null);
  const [reports, setReports] = useState<DailyReport[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [actuals, setActuals] = useState<DailyActuals[]>([]);
  /** This client's campaigns, for naming the rows below. Every status. */
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [actualsMonth, setActualsMonth] = useState<string | null>(null);
  const [reportMonth, setReportMonth] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Opens on the client's account, always.
   *
   * The safe default is the one that cannot leak: an admin who opens this page
   * while sharing their screen gets the client's own figures, and has to
   * deliberately switch to see anything the client cannot. Defaulting to the
   * internal side would make the private view the one you land on by accident.
   */
  const [view, setView] = useState<View>('client');

  const [uploading, setUploading] = useState(false);
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);

    const [cRes, mRes, iRes, krRes, aRes, cpRes] = await Promise.all([
      supabase.from('clients').select('*').eq('id', id).maybeSingle(),
      // Every client-facing row, unlimited, sliced by month in JS — the same
      // shape as the actuals query below and for the same reason. This used to
      // stop at 60 rows and be paired with a second, narrower query that fetched
      // the whole history for the export. One client has hundreds of days at
      // most, so fetching once and filtering here costs a page load nothing and
      // removes the thing that mattered: two queries over one table, either of
      // which could answer "which months exist" differently from the other.
      supabase
        .from('daily_report')
        .select(REPORT_COLS)
        .eq('client_id', id)
        .order('date', { ascending: false }),
      supabase
        .from('invoices')
        .select('*')
        .eq('client_id', id)
        .order('issue_date', { ascending: false }),
      supabase
        .from('creatives')
        .select('*')
        .eq('client_id', id)
        .order('created_at', { ascending: false }),
      // Every actual, unlimited, sliced by month in JS. One client has hundreds
      // of days at most, and fetching once is what makes the month dropdown
      // instant instead of a round trip per selection.
      supabase
        .from('daily_actuals')
        .select('*')
        .eq('client_id', id)
        .order('date', { ascending: false }),
      // Every status. An archived campaign still names rows in the history
      // below, and fetching only the active ones would label real figures
      // "no longer listed".
      supabase
        .from('campaigns')
        .select('*')
        .eq('client_id', id)
        .order('name', { ascending: true }),
    ]);

    if (cRes.error || mRes.error || iRes.error || krRes.error || aRes.error) {
      setError(
        errorText(cRes.error ?? mRes.error ?? iRes.error ?? krRes.error ?? aRes.error),
      );
      setLoading(false);
      return;
    }

    const days = asRows<DailyReport>(mRes.data);
    const measured = asRows<DailyActuals>(aRes.data);
    const bills = asRows<Invoice>(iRes.data);
    setClient((cRes.data as Client) ?? null);
    setReports(days);
    setInvoices(bills);
    setCreatives(asRows<Creative>(krRes.data));
    setActuals(measured);
    // Names only, and a failure costs names rather than figures — see the
    // fallback in `campaignNamer`. Not folded into the error gate above for
    // that reason.
    if (!cpRes.error) setCampaigns(asRows<Campaign>(cpRes.data));
    // Default each picker to the newest month that has data, not to the calendar
    // month — on a day nobody has entered yet those differ, and an empty sheet
    // reads as a fault rather than as an honest "nothing recorded". Kept as `m ??`
    // so a reload after saving a note doesn't yank ops back to the newest month.
    setActualsMonth((m) => m ?? (measured.length > 0 ? monthKey(measured[0].date) : null));
    // The report picker now scopes the invoice list too, so "newest month with
    // data" has to mean either kind. Without the invoice side, a client with
    // invoices but nothing entered yet would open on no month at all and the
    // one card it could have filled would be the one showing nothing. Both
    // queries come back newest-first, so this is the later of the two heads.
    setReportMonth(
      (m) =>
        m ??
        [
          ...(days.length > 0 ? [monthKey(days[0].date)] : []),
          ...(bills.length > 0 ? [monthKey(bills[0].issue_date)] : []),
        ].sort((a, b) => b.localeCompare(a))[0] ??
        null,
    );

    setLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Shell>
        <div className="skeleton-page" />
      </Shell>
    );
  }

  if (!client) {
    return (
      <Shell>
        <Card>
          <Empty title="Client not found" body={<Link to="/admin/clients">Back to clients</Link>} />
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <PageHead
        title={client.name}
        sub={
          <>
            {client.vertical ?? 'No vertical'} · <span className={`pill ${client.status}`}>{client.status}</span> ·{' '}
            <Link to="/admin/clients">All clients</Link>
          </>
        }
        actions={
          <>
            <button type="button" className="btn ghost" onClick={() => setInviting(true)}>
              Invite contact
            </button>
            <button type="button" className="btn" onClick={() => setUploading(true)}>
              Upload invoice
            </button>
          </>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      {inviting && <InviteUser client={client} onClose={() => setInviting(false)} />}
      {uploading && (
        <InvoiceUpload
          client={client}
          onClose={() => setUploading(false)}
          onUploaded={() => {
            setUploading(false);
            void load();
          }}
        />
      )}

      {/*
        The switch, and a sentence saying what you are looking at.

        The sentence is not decoration. "Adovia internal" is only meaningful if
        you know what it excludes, and an account manager who has just switched
        needs to be told in words — not by noticing a colour — that what is now
        on screen must not be read out on a call.
      */}
      <div className={`viewswitch ${view === 'client' ? 'open' : 'closed'}`}>
        <div className="segmented" role="group" aria-label="Which account to show">
          <button
            type="button"
            className={view === 'client' ? 'on' : undefined}
            aria-pressed={view === 'client'}
            onClick={() => setView('client')}
          >
            {client.name}&rsquo;s view
          </button>
          <button
            type="button"
            className={view === 'internal' ? 'on' : undefined}
            aria-pressed={view === 'internal'}
            onClick={() => setView('internal')}
          >
            Adovia internal
          </button>
        </div>
        <p className="viewnote">
          {view === 'client' && (
            <>
              Everything below is what {client.name} sees when they sign in — the same
              figures, the same order, the same download. Safe to show them.
            </>
          )}
          {view === 'internal' && (
            <>
              Everything below is Adovia&rsquo;s own — what we measured, and the note
              on each measurement. <strong>{client.name} sees none of it</strong>, and no
              figure they are shown is repeated here.
            </>
          )}
        </p>
      </div>

      {view === 'client' && (
        <ClientAccount
          client={client}
          reports={reports}
          campaigns={campaigns}
          month={reportMonth}
          onMonth={setReportMonth}
          invoices={invoices}
          onInvoiceDeleted={(i) => setInvoices((xs) => xs.filter((r) => r.id !== i.id))}
          onInvoiceUpdated={(i) => setInvoices((xs) => xs.map((r) => (r.id === i.id ? i : r)))}
          creatives={creatives}
          onCreativeDeleted={(c) => setCreatives((cs) => cs.filter((r) => r.id !== c.id))}
        />
      )}

      {view === 'internal' && (
        <InternalAccount
          client={client}
          actuals={actuals}
          campaigns={campaigns}
          month={actualsMonth}
          onMonth={setActualsMonth}
        />
      )}
    </Shell>
  );
}

/* -------------------------------------------------------------------------- */
/*  The client's account                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the client sees, and nothing else.
 *
 * Every figure rendered here is one the client can pull up themselves. That is
 * the whole contract of this component: if something appears in it that they
 * cannot see, the account manager reading it aloud has no way to know.
 *
 * Note there are no column groups any more. The old table needed a banner row
 * saying which of its ten columns the client could see; this one does not,
 * because the answer is all of them.
 */
function ClientAccount({
  client,
  reports,
  campaigns,
  month,
  onMonth,
  invoices,
  onInvoiceDeleted,
  onInvoiceUpdated,
  creatives,
  onCreativeDeleted,
}: {
  client: Client;
  reports: DailyReport[];
  campaigns: Campaign[];
  month: string | null;
  onMonth: (m: string) => void;
  invoices: Invoice[];
  onInvoiceDeleted: (i: Invoice) => void;
  onInvoiceUpdated: (i: Invoice) => void;
  creatives: Creative[];
  onCreativeDeleted: (c: Creative) => void;
}) {
  /** A campaign id, or one of the two sentinels. Corrected by `pickCampaign`. */
  const [campaign, setCampaign] = useState<string>(CAMPAIGN_ALL);

  /**
   * Every month this client has anything on this screen — a published day OR an
   * invoice — newest first, with the DAY count the label prints.
   *
   * The union is what makes the one picker safe to point at the invoice list
   * below. Built from report days alone this was fine, because it governed only
   * the day table; now that the same choice scopes the invoices, a month
   * holding an invoice and no published days would have no option to select and
   * its invoice would be unreachable from this page — not hidden, gone.
   *
   * That is the normal case rather than a corner one. An invoice is usually
   * raised the month AFTER the work it bills (see `Invoice.issue_date`), so in
   * the first days of a month the newest invoice routinely sits in a month with
   * nothing entered against it yet. Such a month shows "(0)" and an empty day
   * table, which is the honest reading: no days recorded, one invoice raised.
   */
  const months = useMemo(() => {
    const byDays = new Map(monthsWithCounts(reports));
    for (const i of invoices) {
      const k = monthKey(i.issue_date);
      if (!byDays.has(k)) byDays.set(k, 0);
    }
    return [...byDays.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [reports, invoices]);

  /**
   * The selected month's invoices, grouped by `issue_date`.
   *
   * This card used to print every invoice the client has ever had while the
   * month picker above it said "August", so the heading and the table were
   * answering different questions and the count in the title kept growing no
   * matter what was selected. Grouped by issue_date rather than created_at for
   * the same reason the client's own list is: "the August invoice" means the
   * one dated August, whatever day it was uploaded.
   */
  const monthInvoices = useMemo(
    () => (month ? invoices.filter((i) => monthKey(i.issue_date) === month) : invoices),
    [invoices, month],
  );

  /** The whole month, every campaign — what the filter and the breakdown read. */
  const monthAll = useMemo(() => (month ? monthRows(reports, month) : []), [reports, month]);

  /**
   * Every campaign the month has rows for — the filter's option list.
   *
   * Not gated on the month being split, which is the same correction the
   * client's own Spend report carries and for the same reason. A month with one
   * campaign in it used to produce an empty list and no dropdown at all, which
   * left this screen with nothing on it naming the one campaign every figure
   * came from. The control was suppressed as "a dropdown whose choices produce
   * the identical table" — true of the numbers, and beside the point: what it
   * offers is the campaign's NAME, and picking it puts that name on the card
   * heading, the total row and the export filename.
   *
   * Keeping the two sides in step matters more here than the control does. An
   * account manager reading this card and the client reading their own Spend
   * report should not find one of them able to name the campaign and the other
   * not — that is the disagreement this whole screen exists to rule out.
   *
   * Spend and impressions only — a presentation choice, not an arithmetic one.
   * A projection column sitting beside spend, per campaign, reads as leads
   * delivered by that campaign, which is a measurement this product does not
   * publish. The month's projection is totalled once, in the card above, where
   * the per-day column it sums is in view.
   */
  const campaignOptions = useMemo(
    () => sliceByCampaign(monthAll, SPEND_ACCRUING_FIELDS, campaigns),
    [monthAll, campaigns],
  );

  /**
   * The same slices, offered for export whenever the month has any.
   *
   * The same list as `campaignOptions`, aliased rather than re-sliced, so the
   * dropdown and the by-campaign export cannot come to disagree about what a
   * month contains.
   *
   * There used to be a gate suppressing a single-campaign export, on the
   * grounds that a one-line CSV restates the total beside it. The client's
   * Spend report no longer hides that card, and this is the file version of
   * the same table — a month an account manager can see broken down on the
   * client's screen and cannot export from ours is precisely the two-sides
   * disagreement this page exists to avoid. The one line names the campaign,
   * which is the whole reason it is worth printing.
   *
   * `isSplit` is still right further down this page, where it decides whether
   * the day tables carry a Campaign column: those tables list rows, so a row
   * with nothing in it still needs saying which campaign it sits under.
   */
  const breakdown = campaignOptions;

  /**
   * The month's rows, narrowed to the chosen campaign — and the choice itself,
   * corrected to something this month can show. The same call the client's own
   * Spend report makes, so an account manager filtering to PR is looking at the
   * rows the client would get by filtering to PR.
   *
   * Corrected against `campaignOptions`, not `breakdown`. Passing the gated list
   * would make a single-campaign month reject its own only campaign and silently
   * fall back to "All campaigns" — the dropdown would show a name and the table
   * would ignore it.
   */
  const pick = useMemo(
    () => pickCampaign(monthAll, campaignOptions, campaign),
    [monthAll, campaignOptions, campaign],
  );
  const { key: picked, slice: pickedSlice, rows: raw } = pick;

  // `raw` is printed one line per campaign-day by the table, folded into days
  // for the client-facing export, and summed for the total. All three from one
  // filter, which is what stops them from ever describing different sets of
  // days. `SPEND_FIELDS` is safe in the fold because `foldToDays` groups by
  // date: the projections are summed across a day's campaigns, never across
  // days.
  const lines = useMemo(() => foldToDays(raw, SPEND_FIELDS), [raw]);
  const totals = useMemo(() => spendTotals(raw), [raw]);
  const spendDays = lines.filter((l) => typeof l.totals.ad_spend === 'number').length;

  /** What is on screen, in words — heading, total row, CSV label and file name. */
  const monthName = month ? monthLabel(month) : 'this month';
  const label = pickedSlice ? `${pickedSlice.name} — ${monthName}` : monthName;

  /**
   * Whether this client's history has more than one line per day.
   *
   * Drives one column and one sentence, and both matter: on a split client the
   * table below is one row per campaign-day, which is NOT what the client sees
   * on their Overview. Without the campaign name beside each figure the same
   * date appears two or three times with different numbers under it and no
   * stated reason, which reads as a bug in the very screen an account manager
   * opens to prove there isn't one.
   *
   * Asked of the whole history, not the selected month, and that is on purpose.
   * A client split in July but not in June would otherwise gain and lose a
   * column as the month changed, so the same table would be a different shape
   * each time it was opened — and a reader who saw it without the column once
   * has no reason to think it was ever there.
   */
  const split = useMemo(() => isSplit(reports), [reports]);
  const nameOf = useMemo(() => campaignNamer(campaigns), [campaigns]);

  return (
    <>
      {/*
        Every row of the selected month, not the most recent handful.

        This card used to show the last 60 rows and call itself "Recent days".
        On a client split across three campaigns that is twenty days, so an
        account manager asked about the 4th of last month was told, in effect,
        that the figure did not exist — the truncation was invisible and read
        as absence. A month is also the unit every other artefact here uses:
        the client's own Spend report, the invoice, the conversation. Scoping
        to it means the question "what did we publish in August" has one
        answer on this screen rather than "the part of August that fitted".

        One pair of pickers governs this card and the export below it,
        deliberately. Two month selectors would let the table say August while
        the CSV button hands over July, which is the exact class of
        disagreement this screen exists to rule out — and the same argument
        applies to the campaign, which is why there is one of those too.
      */}
      <Card
        title={pickedSlice ? `Published figures — ${pickedSlice.name}` : 'Published figures'}
        aside={
          months.length > 0 && (
            <div className="card-actions">
              <div className="field inline">
                <label htmlFor="report-month">Month</label>
                <select id="report-month" value={month ?? ''} onChange={(e) => onMonth(e.target.value)}>
                  {months.map(([k, n]) => (
                    <option key={k} value={k}>
                      {monthLabel(k)} ({n})
                    </option>
                  ))}
                </select>
              </div>
              {/*
                Offered whenever the month has a campaign in it at all, one
                included — see `campaignOptions`. "All campaigns" stays on the
                list even then: it is the default selection, and dropping it
                would leave `picked` pointing at an option that isn't there.
              */}
              {campaignOptions.length > 0 && (
                <div className="field inline">
                  <label htmlFor="report-campaign">Campaign</label>
                  <select
                    id="report-campaign"
                    value={picked}
                    onChange={(e) => setCampaign(e.target.value)}
                  >
                    <option value={CAMPAIGN_ALL}>All campaigns</option>
                    {campaignOptions.map((c) => (
                      <option key={campaignKey(c.id)} value={campaignKey(c.id)}>
                        {c.name} ({c.rows})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )
        }
      >
        {reports.length === 0 ? (
          <Empty
            title="No figures entered yet"
            body="This fills in as figures are entered on the Daily entry page."
          />
        ) : raw.length === 0 ? (
          <Empty title={`No days recorded in ${monthName}`} />
        ) : (
          <>
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    {split && <th>Campaign</th>}
                    <th className="num">Spend</th>
                    <th className="num">Impr.</th>
                    <th className="num">Proj. leads</th>
                    <th className="num">Proj. adm.</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {raw.map((m) => (
                    <tr key={m.id}>
                      <td>{formatDate(m.date)}</td>
                      {/*
                        The campaign, not a total. Each line is one campaign's
                        own figure as ops entered it, which is what makes this
                        table the one to open when a client asks why a day moved
                        — the client's own sheet shows the day added up and
                        cannot answer which line changed.
                      */}
                      {split && <td className="muted">{nameOf(m.campaign_id)}</td>}
                      <td className="num">{money(m.ad_spend) ?? <Blank />}</td>
                      <td className="num">{count(m.impressions) ?? <Blank />}</td>
                      <td className="num">{count(m.projected_leads) ?? <Blank />}</td>
                      <td className="num">{count(m.projected_admissions) ?? <Blank />}</td>
                      <td className="muted" title={formatTimestamp(m.updated_at)}>
                        {relativeTime(m.updated_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="asof">
              Every row Adovia has published for {label}
              {split ? (
                <>
                  , one line per campaign — {client.name} sees each day added up across its
                  campaigns, and their own breakdown splits it back out under the same
                  names. Nothing here is hidden from them; it is the same numbers at the
                  grain Adovia enters them.
                </>
              ) : (
                <>
                  {' '}
                  — the same figures {client.name} sees on their Overview. The Updated
                  column is ours alone; their side shows the numbers without saying when
                  we last touched them.
                </>
              )}{' '}
              A dash means Adovia has not stated that figure yet, which is what they see
              too; it is never a zero.
            </p>
          </>
        )}
      </Card>

      {/*
        The client's own report, downloadable from this side.

        Same five columns, same totals, same file — it comes from the same
        `spendCsv` the client's Spend report calls, so an account manager on a
        call is looking at the identical sheet the client has open. The whole
        value of this card is that it is NOT a second, admin-flavoured export;
        the moment the two files could disagree, it would create the argument it
        was added to settle.

        Both buttons the client has, for the same reason. The client can filter
        their sheet to one campaign and download that, and can download the
        by-campaign table whole. An account manager who could only produce the
        month would be sending a different attachment from the one the client
        is asking about, and the gap would show up mid-call.
      */}
      <Card
        title="Client-facing report"
        aside={
          months.length > 0 && (
            <div className="card-actions">
              <button
                type="button"
                className="btn ghost sm"
                disabled={lines.length === 0}
                onClick={() =>
                  month &&
                  download(
                    spendCsv(lines, totals, label),
                    `adovia-spend-${client.slug}-${month}${
                      pickedSlice ? `-${fileSlug(pickedSlice.name)}` : ''
                    }.csv`,
                  )
                }
              >
                Download CSV
              </button>
              {picked === CAMPAIGN_ALL && breakdown.length > 0 && (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    month &&
                    download(
                      campaignCsv(breakdown, totals, spendDays, monthName),
                      `adovia-spend-${client.slug}-${month}-by-campaign.csv`,
                    )
                  }
                >
                  By campaign CSV
                </button>
              )}
            </div>
          )
        }
      >
        {reports.length === 0 ? (
          <Empty
            title="Nothing entered yet"
            body="This fills in as figures are entered on the Daily entry page."
          />
        ) : lines.length === 0 ? (
          <Empty title={`No days recorded in ${monthName}`} />
        ) : (
          <>
            <div className="figures small">
              <Stat label="Ad spend" value={moneyExact(totals.spend)} />
              <Stat label="Cumulative impressions" value={count(totals.impressions)} />
              <Stat label="Projected leads" value={count(totals.leads)} />
              {/*
                Only when a row actually states it. Every other figure here is
                worth a "Not yet entered" placeholder because ops is expected to
                fill it; admissions is null in every row ever stored, so a
                permanent placeholder would be a standing prompt to enter
                something nobody has decided to collect. It appears the day one
                is entered.
              */}
              {totals.admissions !== null && (
                <Stat label="Projected admissions" value={count(totals.admissions)} />
              )}
              <Stat label="Days recorded" value={`${spendDays} of ${lines.length}`} />
            </div>
            <p className="asof">
              The five columns {client.name} sees on their Spend report, for {label} — the
              month and campaign picked above, so this and the table can never be reporting
              different things. The download is the same file they can produce themselves —
              same columns, same totals — so there is never a second version of the numbers
              in circulation.{' '}
              {picked === CAMPAIGN_ALL && breakdown.length > 0 && (
                <>
                  &ldquo;By campaign CSV&rdquo; is the other file they can produce: this
                  month split by campaign, spend and impressions only.{' '}
                </>
              )}
              Projected leads are totalled here because the stored figure moves with each
              day&rsquo;s spend rather than restating one standing target — the same total,
              from the same function, that {client.name} now reads in their own footer.
              Projected admissions total the same way and show above only once a day states
              one; no row ever has, so today that figure is absent rather than zero.
            </p>
          </>
        )}
      </Card>

      {/*
        Scoped to the month picked at the top of the page, like everything else
        on this screen. One picker governs the day table, both exports and this
        list, so an account manager reading "August" down the page is reading
        one month throughout rather than a month of figures beside every invoice
        the client has ever been sent.
      */}
      <Card title={`Invoices — ${monthName} (${monthInvoices.length})`}>
        {invoices.length === 0 ? (
          <Empty title="No invoices yet" />
        ) : monthInvoices.length === 0 ? (
          // Distinct from "none at all", because the two call for different
          // next actions: raise one, versus change the month to find it.
          <Empty
            title={`No invoices dated ${monthName}`}
            body="Invoices are grouped by the date printed on them, which is often the month after the work they bill. Every month holding one is offered in the Month picker above."
          />
        ) : (
          // `onDeleted` is what puts the delete column on screen, and passing it
          // only here is why the client's own invoice list does not get one.
          <InvoiceTable
            rows={monthInvoices}
            onDeleted={onInvoiceDeleted}
            onUpdated={onInvoiceUpdated}
          />
        )}
      </Card>

      {/* Creatives come the other way — the client sends these to us. */}
      <Card title={`Creatives from ${client.name} (${creatives.length})`}>
        {creatives.length === 0 ? (
          <Empty
            title="Nothing sent yet"
            body="Artwork this client uploads from their Creatives page lands here."
          />
        ) : (
          <CreativeList rows={creatives} onDeleted={onCreativeDeleted} />
        )}
      </Card>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Adovia's account                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Adovia's own record of this client: what was measured, and why it reads that
 * way. One table, not two.
 *
 * This used to carry a second card — the `daily_report_notes` note per published
 * row, and a History modal over `daily_report_history`. Both are gone from the
 * UI. Neither table was touched, so the rows and the full audit trail are still
 * in the database and still admin-only; there is simply no screen that reads
 * them. If the change history is wanted back, `daily_report_history` has lost
 * nothing and the modal was a self-contained component.
 *
 * No stated figure appears anywhere in here, including in the CSV. Setting
 * measured beside published in one row made the gap easy to read, and made every
 * other use of this view worse: the table could not be shown to anyone, the
 * export could not be forwarded, and the two kinds of number were one column
 * apart at the exact moment somebody was scanning across a row. If a variance
 * needs to be worked out, it is worked out from two exports that each say plainly
 * what they are.
 */
function InternalAccount({
  client,
  actuals,
  campaigns,
  month,
  onMonth,
}: {
  client: Client;
  actuals: DailyActuals[];
  campaigns: Campaign[];
  month: string | null;
  onMonth: (m: string) => void;
}) {
  const months = useMemo(() => monthsWithCounts(actuals), [actuals]);
  const lines = useMemo(
    () => (month ? actuals.filter((a) => monthKey(a.date) === month) : []),
    [actuals, month],
  );
  const nameOf = useMemo(() => campaignNamer(campaigns), [campaigns]);
  // Split on the measurements' own grain, not the published one. A client can
  // be split for one and not the other — ops measures a campaign before it is
  // ever reported on — and the column belongs wherever the duplicate dates are.
  const split = useMemo(() => isSplit(actuals), [actuals]);

  return (
    <>
      {/*
        Campaign setup sits on the internal side because it is configuration,
        not figures — it decides which lines ops is asked to fill in. The names
        it manages are nonetheless client-facing, which the card says plainly.
      */}
      <CampaignManager client={client} />

      {/*
        What Adovia measured. Nothing here reaches a client — the RLS policy on
        this table admits admins only, so the read fails at the database rather
        than depending on this page never rendering it.
      */}
      <Card
        title="Adovia's actuals"
        aside={
          months.length > 0 && (
            <div className="card-actions">
              <div className="field inline">
                <label htmlFor="actuals-month">Month</label>
                <select id="actuals-month" value={month ?? ''} onChange={(e) => onMonth(e.target.value)}>
                  {months.map(([k, n]) => (
                    <option key={k} value={k}>
                      {monthLabel(k)} ({n})
                    </option>
                  ))}
                </select>
              </div>
              {/*
                Exports exactly the month on screen. The file and the table
                should never disagree about what they cover.
              */}
              <button
                type="button"
                className="btn ghost sm"
                disabled={lines.length === 0}
                onClick={() =>
                  month &&
                  download(
                    actualsCsv(lines, nameOf),
                    `adovia-actuals-${client.slug}-${month}.csv`,
                  )
                }
              >
                Download CSV
              </button>
            </div>
          )
        }
      >
        {actuals.length === 0 ? (
          <Empty
            title="No actuals recorded yet"
            body="Enter these on the Daily entry page, in the internal grid below the client figures."
          />
        ) : lines.length === 0 ? (
          <Empty title={`Nothing measured in ${month ? monthLabel(month) : 'this month'}`} />
        ) : (
          <div className="tablewrap">
            {/* `t-internal`, not `internal` — that one is already the class on the
                internal-note input, and a descendant selector would repaint every
                one of them. Same reason the column groups use `c-`. */}
            <table className="table t-internal">
              <thead>
                <tr>
                  <th>Date</th>
                  {split && <th>Campaign</th>}
                  <th className="num">Impr.</th>
                  <th className="num">Leads</th>
                  <th className="num">Adm.</th>
                  {/* Plain "Internal note", matching the column ops types into
                      on Daily entry — the same field should not answer to two
                      names depending on which screen you are looking at.

                      This heading was briefly "Note on the measurement", to keep
                      it apart from a second internal per-day note that lived in
                      a card below this one. That card is gone, so the only
                      internal note on this screen is this one and the plain name
                      is free again. Anything reinstating a `daily_report_notes`
                      UI here needs to name it something other than this. */}
                  <th>Internal note</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((a) => (
                  <tr key={a.id}>
                    <td className="daycell">{formatDate(a.date)}</td>
                    {split && <td className="muted">{nameOf(a.campaign_id)}</td>}
                    <td className="num">{count(a.impressions) ?? <Blank />}</td>
                    <td className="num">{count(a.leads) ?? <Blank />}</td>
                    <td className="num">{count(a.admissions) ?? <Blank />}</td>
                    {/* Read-only here. This page is the record; the note is
                        written where the measurement is, on Daily entry, so
                        there is one place a figure and its explanation can get
                        out of step instead of two. */}
                    <td className="notecell">{a.note ?? <Blank />}</td>
                    <td className="muted daycell" title={formatTimestamp(a.updated_at)}>
                      {relativeTime(a.updated_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="asof">
          Measured, not stated. Never shown to {client.name} on any screen and never part of
          their spend report. A dash is &ldquo;not measured&rdquo;, not zero — the CSV leaves
          those cells empty so a spreadsheet won&rsquo;t average them as zeroes.
        </p>
      </Card>

    </>
  );
}
