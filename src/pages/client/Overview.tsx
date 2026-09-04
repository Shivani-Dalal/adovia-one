import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../../auth/SessionProvider';
import { supabase, errorText } from '../../lib/supabase';
import { Blank, Card, Empty, ErrorNote, PageHead, Shell, Stat } from '../../components/Shell';
import { Figure } from '../../components/Figure';
import { DatePager } from '../../components/DatePager';
import { money, moneyExact, count } from '../../lib/format';
import {
  SPEND_COLS,
  SPEND_FIELDS,
  spendTotals,
  type SpendRow,
} from '../../lib/spendReport';
import { campaignNamer, isSplit, sliceByCampaign, sumFields } from '../../lib/campaigns';
import {
  addDays,
  businessToday,
  formatDate,
  formatDateLong,
  monthKey,
  monthLabel,
  monthStart,
  nextMonthStart,
  type ISODate,
} from '../../lib/dates';
import { rows as asRows, type Campaign, type DailyReport } from '../../lib/types';

/**
 * Exactly the Spend report's five columns, plus what the page needs to date
 * them. Selecting the actuals we don't render would leave a second set of
 * figures one console tab away from a client — narrowing the query is how the
 * "one set of figures" promise stops depending on the JSX.
 *
 * `campaign_id` is here because a row is one client-campaign-day. The four
 * figures on this page are sums across the day's campaigns, and a query that
 * omitted the id would still return every row but leave the page unable to say
 * which campaign each one came from.
 *
 * `updated_at` used to be here to feed the stamp under each figure. That stamp
 * is gone from the client's side, and by the rule above the column goes with
 * it: a timestamp nobody renders is still a timestamp sitting in a network
 * response, telling a reader how recently we were at our desks.
 */
type Row = Pick<
  DailyReport,
  | 'date'
  | 'campaign_id'
  | 'ad_spend'
  | 'impressions'
  | 'projected_leads'
  | 'projected_admissions'
  | 'client_note'
>;

const COLS =
  'date, campaign_id, ad_spend, impressions, projected_leads, projected_admissions, client_note';

/** One month's spend, with the number of days that figure actually rests on. */
interface MonthSpend {
  key: string;
  spend: number | null;
  /** Days in the month where a spend figure exists. Not the days elapsed. */
  days: number;
}

/**
 * Totals one month out of a two-month fetch.
 *
 * Deliberately routed through `spendTotals` rather than a local `reduce`: the
 * figure shown here has to be the same number the Spend report prints for the
 * same month, and the only way to guarantee that is to run the same function.
 * A local sum would agree today and diverge the first time either side changed
 * how a null is treated — surfacing as a client reading two different totals
 * off two of our own screens.
 */
function summarise(rows: SpendRow[], key: string): MonthSpend {
  const lines = rows.filter((r) => monthKey(r.date) === key);
  return {
    key,
    // Summing the stored rows is the same arithmetic as summing the folded
    // days — campaigns then days, or days then campaigns — so the total needs
    // no fold. The day COUNT does.
    spend: spendTotals(lines).spend,
    // Distinct dates, not rows. Counting rows would tell a client with three
    // campaigns that August covered 69 days of spend, and the sentence this
    // feeds ("covers 23 days of spend so far") is the one thing on the strip
    // that says how much of the month the total actually rests on.
    days: new Set(
      lines.filter((l) => typeof l.ad_spend === 'number').map((l) => l.date),
    ).size,
  };
}

/** "12 days of spend" — how much of the month the total actually rests on. */
function dayPhrase(m: MonthSpend): string {
  return m.days === 0 ? 'no days of spend' : `${m.days} day${m.days === 1 ? '' : 's'} of spend`;
}

/** One note the client was left, and which campaign it was left against. */
interface DayNote {
  key: string;
  campaign: string;
  text: string;
}

/**
 * Every note on the day, in the campaign order the breakdown uses.
 *
 * Whitespace-only notes are dropped rather than rendered as an empty card:
 * a heading saying "Note from your Adovia team" over nothing is worse than no
 * heading, because it reads as a message that failed to load.
 */
function dayNotes(rows: readonly Row[], campaigns: readonly Campaign[]): DayNote[] {
  const name = campaignNamer(campaigns);
  const rank = new Map(campaigns.map((c, i) => [c.id, i]));
  return rows
    .filter((r) => (r.client_note ?? '').trim() !== '')
    .sort(
      (a, b) =>
        (rank.get(a.campaign_id ?? '') ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.campaign_id ?? '') ?? Number.MAX_SAFE_INTEGER),
    )
    .map((r) => ({
      key: r.campaign_id ?? 'unattributed',
      campaign: name(r.campaign_id),
      text: (r.client_note ?? '').trim(),
    }));
}

export default function Overview() {
  const { client } = useSession();
  const clientId = client?.id;

  // Three dates, and they are not the same thing:
  //   latest  — the newest row that exists. The default view.
  //   earliest— the floor on the picker, so a client cannot page into blank
  //             months that predate their account.
  //   today   — the ceiling, from the server. Nobody browses the future.
  const [latest, setLatest] = useState<ISODate | null>(null);
  const [earliest, setEarliest] = useState<ISODate | null>(null);
  const [today, setToday] = useState<ISODate | null>(null);

  const [selected, setSelected] = useState<ISODate | null>(null);
  /**
   * Every row for the selected day — one per campaign that has an entry.
   *
   * This used to be a single row, because a day *was* a row. It is now a list
   * that the page folds, and the distinction is not cosmetic: the previous code
   * asked for the day with `.maybeSingle()`, which does not return the first of
   * several rows, it fails. The moment a client had two campaigns on one day
   * their Overview raised an error instead of showing their figures.
   */
  const [rows, setRows] = useState<Row[]>([]);
  /** Names for the breakdown. Every status — an archived campaign still ran. */
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  // The two month totals. Null means "not established yet" — either still
  // loading or the query failed — and the strip stays off screen in both cases.
  const [thisMonth, setThisMonth] = useState<MonthSpend | null>(null);
  const [lastMonth, setLastMonth] = useState<MonthSpend | null>(null);

  const [loading, setLoading] = useState(true);
  const [rowLoading, setRowLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Bootstrap: latest row, earliest date, server today -------------------

  useEffect(() => {
    if (!clientId) return;
    let alive = true;

    (async () => {
      setLoading(true);
      // The newest DATE, not the newest row. Asking for the newest row and
      // rendering it was the second half of the same bug: it succeeded, and
      // quietly showed one campaign's spend under the client's name as though
      // it were the whole day's. One column is safe to take singly — a date is
      // a date however many campaigns share it.
      const [latestRes, earliestRes, campRes, todayVal] = await Promise.all([
        supabase
          .from('daily_report')
          .select('date')
          .eq('client_id', clientId)
          .order('date', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('daily_report')
          .select('date')
          .eq('client_id', clientId)
          .order('date', { ascending: true })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('campaigns')
          .select('*')
          .eq('client_id', clientId)
          .order('name', { ascending: true }),
        businessToday(),
      ]);

      if (!alive) return;

      if (latestRes.error) {
        setError(errorText(latestRes.error));
        setLoading(false);
        return;
      }

      const newest = (latestRes.data as { date: ISODate } | null)?.date ?? null;
      setLatest(newest);
      setEarliest((earliestRes.data as { date: string } | null)?.date ?? null);
      // Names only. A failure here costs the breakdown its headings, not the
      // client their figures, so it is not allowed to fail the page.
      if (!campRes.error) setCampaigns(asRows<Campaign>(campRes.data));
      setToday(todayVal);

      // A second round trip, deliberately. The alternative — fetching the last
      // N rows and keeping whichever share the newest date — silently truncates
      // a day once a client has more campaigns than N, and the failure would be
      // a missing campaign rather than an error.
      if (newest) {
        setSelected(newest);
        const dayRes = await supabase
          .from('daily_report')
          .select(COLS)
          .eq('client_id', clientId)
          .eq('date', newest);
        if (!alive) return;
        if (dayRes.error) setError(errorText(dayRes.error));
        else setRows((dayRes.data ?? []) as Row[]);
      }

      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [clientId]);

  // --- This month and last, by spend ----------------------------------------

  /*
    A separate effect on purpose, rather than another leg of the bootstrap:
    it needs the server's `today` to know which months to ask for, and folding
    it in would make the hero figures wait on a secondary statistic. This fills
    in a beat later and the main figures render at the speed they did before.

    Anchored to today, not to the day in the pager. Paging back to March should
    not silently restate what "this month" means — each total carries its own
    month name so the two can never be confused.
  */
  useEffect(() => {
    if (!clientId || !today) return;
    let alive = true;

    (async () => {
      const thisKey = monthKey(today);
      const lastKey = monthKey(addDays(monthStart(today), -1));

      // Two months at most — about sixty rows. The upper bound keeps a
      // mistyped future date from landing in the current month's total.
      const res = await supabase
        .from('daily_report')
        .select(SPEND_COLS)
        .eq('client_id', clientId)
        .gte('date', `${lastKey}-01`)
        .lt('date', nextMonthStart(today));

      if (!alive) return;

      // A failure here leaves the strip off the page rather than raising an
      // error over the day's figures, which loaded fine. What it must never do
      // is fall through and render "Not yet entered" — that would report a
      // query we couldn't run as a month Adovia never spent in.
      if (res.error) return;

      const all = (res.data ?? []) as SpendRow[];
      setThisMonth(summarise(all, thisKey));
      setLastMonth(summarise(all, lastKey));
    })();

    return () => {
      alive = false;
    };
  }, [clientId, today]);

  // --- Fetch one specific day ----------------------------------------------

  const pick = useCallback(
    async (date: ISODate) => {
      if (!clientId) return;
      setSelected(date);
      setRowLoading(true);
      setError(null);

      // No `.maybeSingle()`. A day is as many rows as it has campaigns, and
      // asking PostgREST for one row when several match is an error response,
      // not a truncation — this line is what turned a second campaign into a
      // broken Overview.
      const dayRes = await supabase
        .from('daily_report')
        .select(COLS)
        .eq('client_id', clientId)
        .eq('date', date);

      setRowLoading(false);
      if (dayRes.error) {
        setError(errorText(dayRes.error));
        return;
      }
      // Empty is a real answer here, not a failure: no entry for that day. It
      // renders as its own state below rather than as four zeros.
      setRows((dayRes.data ?? []) as Row[]);
    },
    [clientId],
  );

  // --- The day, folded ------------------------------------------------------

  /**
   * The four figures, summed across the day's campaigns.
   *
   * Null-preserving throughout: a figure no campaign stated stays "Not yet
   * entered" rather than becoming a zero, and a figure two of three campaigns
   * stated is the sum of the two that did. That last case is a partial day and
   * it is real — the alternative would be withholding figures Adovia has
   * published because a sibling row is still blank.
   */
  const totals = useMemo(() => sumFields(rows, SPEND_FIELDS), [rows]);

  /** True when the day carries figures from more than one campaign. */
  const split = useMemo(() => isSplit(rows), [rows]);

  const breakdown = useMemo(
    () => (split ? sliceByCampaign(rows, SPEND_FIELDS, campaigns) : []),
    [split, rows, campaigns],
  );

  /**
   * The day's notes, one per campaign that left one.
   *
   * A note used to be a property of the day because a row was the day. It is
   * now per campaign, so a client can get two on the same date — and showing
   * only the first would drop a message their account manager believes they
   * sent. Each is labelled with its campaign when the day is split.
   */
  const notes = useMemo(() => dayNotes(rows, campaigns), [rows, campaigns]);

  if (loading) {
    return (
      <Shell>
        <div className="skeleton-page" />
      </Shell>
    );
  }

  // No rows at all — a brand new client, before ops' first entry.
  if (!latest) {
    return (
      <Shell>
        <PageHead title="Overview" />
        <Card>
          <Empty
            title="Nothing entered yet"
            body="Your Adovia team enters figures each working day. As soon as the first day is in, it shows up here."
          />
        </Card>
      </Shell>
    );
  }

  const onLatest = selected === latest;
  const isToday = selected === today;

  return (
    <Shell>
      <PageHead
        title="Overview"
        sub={
          onLatest
            ? isToday
              ? "Today's figures, as entered by Adovia."
              : `Most recent entry — ${formatDate(latest)}.`
            : `Figures for ${formatDateLong(selected!)}.`
        }
        actions={
          <DatePager
            value={selected!}
            min={earliest ?? latest}
            max={today ?? latest}
            latest={latest}
            busy={rowLoading}
            onChange={pick}
          />
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      {/*
        A date with no row is not an error and not a zero. Saying so plainly is
        cheaper than a client concluding their campaign stopped over a weekend.
      */}
      {rows.length === 0 ? (
        <Card>
          <Empty
            title={`No entry for ${formatDate(selected!)}`}
            body={
              <>
                Adovia didn&rsquo;t record figures for this day — commonly a weekend or a
                holiday. This is not a zero-spend day; it&rsquo;s a day with no entry.{' '}
                <button type="button" className="linkish" onClick={() => void pick(latest)}>
                  Back to {formatDate(latest)}
                </button>
              </>
            }
          />
        </Card>
      ) : (
        <>
          {/*
            These four are exactly the Spend report's columns, so a client
            comparing the two screens is reading the same set of figures rather
            than reconciling two different ones.

            Each one is the day's total across every campaign that ran, summed
            by the same module the Spend report folds with. The campaigns behind
            them are directly below rather than mixed in here: this row answers
            "how did today go", and a reader who wants "and where did it go" is
            one card away.
          */}
          <div className={`figures${rowLoading ? ' dim' : ''}`}>
            <Figure label="Ad spend" value={totals.ad_spend} format={money} hero />
            <Figure
              label="Cumulative impressions"
              value={totals.impressions}
              format={count}
              hero
            />
            <Figure label="Projected leads" value={totals.projected_leads} format={count} hero />
            <Figure
              label="Projected admissions"
              value={totals.projected_admissions}
              format={count}
              hero
            />
          </div>

          {/*
            Only when there is more than one campaign on the day. A single
            campaign would produce one line restating the four figures directly
            above it, which implies a split exists where none does.
          */}
          {breakdown.length > 0 && (
            <Card title="By campaign">
              <div className="tablewrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th className="num">Spend (₹)</th>
                      <th className="num">Cumulative impressions</th>
                      <th className="num">Projected leads</th>
                      <th className="num">Projected admissions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.map((c) => (
                      <tr key={c.id ?? 'unattributed'}>
                        <td>{c.name}</td>
                        <td className="num">{moneyExact(c.totals.ad_spend) ?? <Blank />}</td>
                        <td className="num">{count(c.totals.impressions) ?? <Blank />}</td>
                        <td className="num">{count(c.totals.projected_leads) ?? <Blank />}</td>
                        <td className="num">
                          {count(c.totals.projected_admissions) ?? <Blank />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {/*
                    Every column totals here, projections included — unlike the
                    Spend report's monthly footer, which leaves them blank. The
                    difference is the direction: within one day each campaign
                    carries its own forecast and their sum is the day's, whereas
                    down a month the same forecast is restated daily and adding
                    it up would multiply the target by the number of days.
                  */}
                  <tfoot>
                    <tr>
                      <th>{formatDate(selected!)} total</th>
                      <th className="num">{moneyExact(totals.ad_spend) ?? <Blank />}</th>
                      <th className="num">{count(totals.impressions) ?? <Blank />}</th>
                      <th className="num">{count(totals.projected_leads) ?? <Blank />}</th>
                      <th className="num">{count(totals.projected_admissions) ?? <Blank />}</th>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="muted mt sm">
                The figures at the top of this page are these lines added up. A dash is a
                campaign Adovia hasn&rsquo;t entered for this day — the total covers the
                ones they have, so it can describe part of a day rather than none of it.
              </p>
            </Card>
          )}

          {notes.length > 0 && (
            <Card
              title={
                notes.length === 1
                  ? 'Note from your Adovia team'
                  : 'Notes from your Adovia team'
              }
            >
              {notes.map((n) => (
                <div key={n.key} className="daynote">
                  {/*
                    Labelled only when the day is split. On a single-campaign
                    client the heading would be the client's only campaign name
                    printed above every note it ever receives.
                  */}
                  {split && <p className="muted sm">{n.campaign}</p>}
                  <p className="note">{n.text}</p>
                </div>
              ))}
            </Card>
          )}
        </>
      )}

      {/*
        Sits outside the day's figures because it is true regardless of them:
        a day with no entry still belongs to a month that has a total.
      */}
      {thisMonth && lastMonth && (
        <Card title="Spend by month">
          <div className="figures small">
            <Stat
              label={`${monthLabel(thisMonth.key)} so far`}
              value={money(thisMonth.spend)}
            />
            <Stat label={monthLabel(lastMonth.key)} value={money(lastMonth.spend)} />
          </div>
          <p className="muted mt">
            {monthLabel(thisMonth.key)} covers {dayPhrase(thisMonth)} so far and will
            keep filling in; {monthLabel(lastMonth.key)} covers {dayPhrase(lastMonth)} as
            recorded. Each total adds only the days Adovia entered — a day with no entry
            is left out rather than counted as a zero, so these figures match the Spend
            report exactly.
          </p>
        </Card>
      )}

      {/*
        The honesty bar. Says which day is on screen and, when that is not
        today, why — so "my numbers look stale" resolves before it becomes an
        email.
      */}
      <p className="asof">
        Showing {formatDateLong(selected!)}.{' '}
        {onLatest && !isToday && today
          ? `Today's figures (${formatDate(today)}) haven't been entered yet.`
          : onLatest
            ? 'This is the most recent entry.'
            : `The most recent entry is ${formatDate(latest)}.`}{' '}
        Every figure is for this day alone.{' '}
        {earliest && `History available from ${formatDate(earliest)}.`}
      </p>
    </Shell>
  );
}
