import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../../auth/SessionProvider';
import { supabase, errorText } from '../../lib/supabase';
import { Blank, Card, Empty, ErrorNote, PageHead, Shell } from '../../components/Shell';
import { money, moneyExact, count } from '../../lib/format';
import { download, fileSlug } from '../../lib/csv';
import {
  campaignCsv,
  monthRows,
  monthsWithCounts,
  spendCsv,
  spendTotals,
  SPEND_COLS,
  SPEND_FIELDS,
  SPEND_ACCRUING_FIELDS,
  type SpendField,
  type SpendRow as Row,
  type SpendTotals as Totals,
} from '../../lib/spendReport';
import {
  campaignKey,
  foldToDays,
  isSplit,
  pickCampaign,
  sliceByCampaign,
  CAMPAIGN_ALL,
  type DayTotals,
} from '../../lib/campaigns';
import { rows as asRows, type Campaign } from '../../lib/types';
import { businessToday, formatDate, monthKey, monthLabel, type ISODate } from '../../lib/dates';

/**
 * The day-by-day spend sheet: one row per day Adovia entered, five columns.
 *
 * Every column is that day's own figure. Nothing on a line is a running total,
 * so two lines can be compared directly and one can be quoted on its own
 * without carrying the rest of the month with it.
 *
 * A day is now the sum of its campaigns. Stored rows are one per
 * client-campaign-day, and they are folded before anything is printed — the
 * table's shape is unchanged, but each figure in it is a total rather than a
 * stored column. The month's split across campaigns is shown separately below,
 * so the sheet stays readable as a calendar and the breakdown answers "where
 * did it go" without interleaving the two questions.
 *
 * A campaign is chosen with a filter, not with an extra column, and the
 * distinction is the design. Adding a Campaign column would put the same date
 * on two or three consecutive lines with different numbers under each, so the
 * one question this sheet answers cleanly — "what happened on the 14th" — would
 * need the reader to add three rows by eye first. Filtering keeps every line a
 * whole day of whatever is selected: the client's day when that is everything,
 * PR's day when that is PR. The heading, the total row, the CSV and its
 * filename all move together with it, so a file cannot leave here labelled as
 * the month while holding one campaign's figures.
 */
export default function SpendReport() {
  const { client } = useSession();
  const clientId = client?.id;

  const [rows, setRows] = useState<Row[]>([]);
  /**
   * The client's campaigns, for names only.
   *
   * Every status, not just active: an archived campaign's figures are still the
   * client's and still appear in the months it ran, so fetching only the active
   * ones would print "Campaign no longer listed" over real history.
   */
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [month, setMonth] = useState<string | null>(null);
  /** A campaign id, or one of the two sentinels. Corrected by `pickCampaign`. */
  const [campaign, setCampaign] = useState<string>(CAMPAIGN_ALL);
  const [today, setToday] = useState<ISODate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    let alive = true;

    (async () => {
      setLoading(true);
      setError(null);

      // Every day in one query, sliced by month in JS. A client has hundreds of
      // rows at most, and fetching once makes the month dropdown instant.
      const [res, camps, t] = await Promise.all([
        supabase
          .from('daily_report')
          .select(SPEND_COLS)
          .eq('client_id', clientId)
          .order('date', { ascending: false }),
        supabase
          .from('campaigns')
          .select('*')
          .eq('client_id', clientId)
          .order('name', { ascending: true }),
        businessToday(),
      ]);

      if (!alive) return;
      if (res.error) {
        setError(errorText(res.error));
        setLoading(false);
        return;
      }

      const all = (res.data ?? []) as Row[];
      setRows(all);
      // A failed campaign fetch costs names, not figures: `campaignNamer` falls
      // back for unknown ids and the sheet above is unaffected. Failing the
      // whole page over a naming lookup would hide the numbers to protect a
      // label.
      if (!camps.error) setCampaigns(asRows<Campaign>(camps.data));
      setToday(t);
      // Default to the newest month that has data, not to the calendar month —
      // on the 1st of a month those differ, and an empty sheet reads as a fault.
      setMonth(all.length > 0 ? monthKey(all[0].date) : null);
      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [clientId]);

  const months = useMemo(() => monthsWithCounts(rows), [rows]);
  /** The whole month, every campaign — what the filter and the breakdown read. */
  const monthAll = useMemo(() => (month ? monthRows(rows, month) : []), [rows, month]);

  // Accruing fields only. Each slice here spans the whole month, so folding the
  // projection columns into it would add one standing forecast to itself once
  // per day — a campaign entered on five days would report five times its own
  // target, as a number indistinguishable from a real one. The projections stay
  // where they mean something: per day, in the sheet above.
  //
  // This is also the filter's option list, from the same call, so the dropdown
  // can only ever offer campaigns the month actually has rows for.
  const breakdown = useMemo(
    () => (isSplit(monthAll) ? sliceByCampaign(monthAll, SPEND_ACCRUING_FIELDS, campaigns) : []),
    [monthAll, campaigns],
  );

  /**
   * The month's rows, narrowed to the chosen campaign — and the choice itself,
   * corrected to something this month can actually show. See `pickCampaign`.
   */
  const pick = useMemo(
    () => pickCampaign(monthAll, breakdown, campaign),
    [monthAll, breakdown, campaign],
  );
  const { key: picked, slice: pickedSlice, rows: raw } = pick;
  // `SPEND_FIELDS`, not the accruing subset, and safely so: `foldToDays` groups
  // by date, so each fold is within one day and the projections are summed
  // across that day's campaigns — which is the direction they are meant to be
  // summed in.
  const lines: DayTotals<SpendField>[] = useMemo(() => foldToDays(raw, SPEND_FIELDS), [raw]);
  // Totalled from the stored rows, not from the folded days. Both give the same
  // answer — summing campaigns then days is summing days then campaigns — and
  // going via the raw rows keeps this the identical call the admin side makes.
  const totals: Totals = useMemo(() => spendTotals(raw), [raw]);

  const spendDays = lines.filter((l) => typeof l.totals.ad_spend === 'number').length;
  /** What the sheet on screen covers, in words — heading, total row, CSV, filename. */
  const monthName = month ? monthLabel(month) : 'this month';
  const label = pickedSlice ? `${pickedSlice.name} — ${monthName}` : monthName;

  if (loading) {
    return (
      <Shell>
        <div className="skeleton-page" />
      </Shell>
    );
  }

  return (
    <Shell>
      <PageHead
        title="Spend report"
        sub={
          rows.length === 0
            ? undefined
            : `${spendDays} day${spendDays === 1 ? '' : 's'} of spend recorded${
                month ? ` in ${monthLabel(month)}` : ''
              }${pickedSlice ? ` for ${pickedSlice.name}` : ''}.`
        }
        actions={
          months.length > 0 && (
            <>
              <div className="field inline">
                <label htmlFor="spend-month">Month</label>
                <select
                  id="spend-month"
                  value={month ?? ''}
                  onChange={(e) => setMonth(e.target.value)}
                >
                  {months.map(([k, n]) => (
                    <option key={k} value={k}>
                      {monthLabel(k)} ({n})
                    </option>
                  ))}
                </select>
              </div>
              {/*
                Only offered when the month has more than one campaign in it. A
                single-campaign month would get a two-option dropdown whose
                choices produce the identical sheet, which reads as a control
                that does nothing.
              */}
              {breakdown.length > 0 && (
                <div className="field inline">
                  <label htmlFor="spend-campaign">Campaign</label>
                  <select
                    id="spend-campaign"
                    value={picked}
                    onChange={(e) => setCampaign(e.target.value)}
                  >
                    <option value={CAMPAIGN_ALL}>All campaigns</option>
                    {breakdown.map((c) => (
                      <option key={campaignKey(c.id)} value={campaignKey(c.id)}>
                        {c.name} ({c.rows})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {/*
                Exports exactly what is on screen — this month, and this
                campaign when one is picked. The file and the table should never
                disagree about what they cover, so the same `label` goes into
                the total row and the same selection into the filename.
              */}
              <button
                type="button"
                className="btn ghost sm"
                disabled={lines.length === 0}
                onClick={() =>
                  month &&
                  download(
                    spendCsv(lines, totals, label),
                    `adovia-spend-${month}${
                      pickedSlice ? `-${fileSlug(pickedSlice.name)}` : ''
                    }.csv`,
                  )
                }
              >
                Download CSV
              </button>
            </>
          )
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      {/*
        Titled only when filtered. The card is the page when it shows the whole
        month, and a heading repeating the page title is noise; once it holds
        one campaign the heading is the only thing on the card that says so, and
        it has to be there before a screenshot of this table can be sent to
        anybody.
      */}
      <Card title={pickedSlice ? `${pickedSlice.name} — ${monthName}` : undefined}>
        {rows.length === 0 ? (
          <Empty
            title="Nothing entered yet"
            body="This sheet fills in as your Adovia team records each working day."
          />
        ) : lines.length === 0 ? (
          <Empty title={`No days recorded in ${monthName}`} />
        ) : (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="num">Spend (₹)</th>
                  <th className="num">Cumulative impressions</th>
                  <th className="num">Projected leads</th>
                  <th className="num">Projected admissions</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.date}>
                    <td>{formatDate(l.date)}</td>
                    <td className="num">{moneyExact(l.totals.ad_spend) ?? <Blank />}</td>
                    <td className="num">{count(l.totals.impressions) ?? <Blank />}</td>
                    <td className="num">{count(l.totals.projected_leads) ?? <Blank />}</td>
                    <td className="num">{count(l.totals.projected_admissions) ?? <Blank />}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  {/* Names the campaign when one is picked, so the total line can
                      never be read as the client's whole month. */}
                  <th>{label} total</th>
                  <th className="num">{moneyExact(totals.spend) ?? <Blank />}</th>
                  <th className="num">{count(totals.impressions) ?? <Blank />}</th>
                  <th className="num" />
                  <th className="num" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {/*
        Where the month went. Deliberately its own card under the calendar
        rather than extra columns on it: the sheet answers "what happened on the
        14th" and this answers "what is PR costing us", and a table that tried
        to do both would be one a client has to read twice to do either.

        Only rendered when there is something to split. A single-campaign client
        would get a one-line table restating the total directly above it, which
        implies a breakdown exists where none does.

        Hidden while a campaign is picked, for the same reason: the sheet above
        is then already one campaign, and a "by campaign" table beneath it with
        one line saying the same numbers is a breakdown of nothing. The filter
        is set back to All campaigns to get it back.
      */}
      {picked === CAMPAIGN_ALL && breakdown.length > 0 && (
        <Card
          title={`By campaign — ${monthName}`}
          aside={
            <button
              type="button"
              className="btn ghost sm"
              onClick={() =>
                month &&
                download(
                  campaignCsv(breakdown, totals, spendDays, monthName),
                  `adovia-spend-${month}-by-campaign.csv`,
                )
              }
            >
              Download CSV
            </button>
          }
        >
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th className="num">Spend (₹)</th>
                  <th className="num">Cumulative impressions</th>
                  <th className="num">Days</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((c) => (
                  <tr key={c.id ?? 'unattributed'}>
                    <td>{c.name}</td>
                    <td className="num">{moneyExact(c.totals.ad_spend) ?? <Blank />}</td>
                    <td className="num">{count(c.totals.impressions) ?? <Blank />}</td>
                    <td className="num">{c.rows}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>{month && monthLabel(month)} total</th>
                  <th className="num">{moneyExact(totals.spend) ?? <Blank />}</th>
                  <th className="num">{count(totals.impressions) ?? <Blank />}</th>
                  <th className="num">{spendDays}</th>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="muted mt sm">
            Spend and impressions add up to the month total above. Projected leads and
            admissions are left out of this card on purpose: they are a standing forecast
            restated each day rather than a running count, so a month of one campaign&rsquo;s
            projections is the same target counted many times over. They are shown per day
            in the sheet above, which is where they mean something. Days counts the days
            each campaign was recorded on, so it reads down the column to more than the
            month&rsquo;s day count whenever two campaigns ran on the same day. Pick a
            campaign from the filter at the top to see its own day-by-day sheet, or
            download this table as it stands.{' '}
            {breakdown.some((c) => c.id === null) && (
              <>
                &ldquo;{breakdown.find((c) => c.id === null)?.name}&rdquo; covers days
                recorded before this account was split into campaigns. Those figures are
                real and count toward every total; only the attribution is missing.
              </>
            )}
          </p>
        </Card>
      )}

      {lines.length > 0 && (
        <p className="asof">
          {label}: {money(totals.spend)} across {spendDays} day
          {spendDays === 1 ? '' : 's'}.{' '}
          {today && monthKey(today) === month
            ? 'This month is still filling in.'
            : 'This month is complete as recorded.'}{' '}
          Every figure is for that day alone. A dash means Adovia hasn&rsquo;t entered it — it
          is not a zero, and the CSV leaves those cells empty for the same reason, so a
          spreadsheet won&rsquo;t average them as zeroes.
        </p>
      )}
    </Shell>
  );
}
