import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../../auth/SessionProvider';
import { supabase, errorText } from '../../lib/supabase';
import { Card, Empty, ErrorNote, PageHead, Shell, Stat } from '../../components/Shell';
import { TrendChart, type TrendSeries } from '../../components/TrendChart';
import { DonutChart, type DonutSlice } from '../../components/DonutChart';
import { money, moneyExact, count, compact, delta } from '../../lib/format';
import { addDays, businessToday, formatDate, type ISODate } from '../../lib/dates';
import { SPEND_COLS, SPEND_FIELDS, SPEND_ACCRUING_FIELDS, type SpendRow } from '../../lib/spendReport';
import {
  campaignKey,
  campaignToner,
  foldToDays,
  isSplit,
  sliceByCampaign,
  sumStated,
} from '../../lib/campaigns';
import { rows as asRows, type Campaign } from '../../lib/types';

// Deliberately the Spend report's five columns and nothing else — the same
// constant it selects, so the three screens cannot drift apart. A client who
// compares Overview, Trend and the Spend report should be reading one set of
// figures in three shapes, not three sets that need reconciling.
type Row = SpendRow;

const WINDOWS = [
  { days: 30, label: '30 days' },
  { days: 60, label: '60 days' },
  { days: 90, label: '90 days' },
] as const;

/**
 * Shape, not figures — and now shape by campaign.
 *
 * Three pictures, each answering one question, in the order a client asks
 * them. Where did the money go (the ring). How did it move (the spend lines).
 * What is it meant to produce (the admissions line). They are separate
 * drawings on purpose: the previous version put spend and projected admissions
 * on one chart against two independently-scaled axes, which meant the point
 * where the lines crossed — the thing a reader's eye goes to first — was an
 * artefact of the two maximums and not a fact about anything. Two charts under
 * a shared date axis compare exactly as well and claim nothing extra.
 *
 * COMPARED AGAINST THE PRECEDING WINDOW, not against last month. The old card
 * set this month so far beside all of last month and then carried a sentence
 * apologising for it — "the gap narrows as the month fills in" — which is a
 * caveat that turns a headline number into a puzzle, and which most readers
 * will not reach before they have already read the percentage. Thirty days
 * against the thirty before them needs no apology and moves with the window
 * selector the client is already using.
 *
 * Nothing on this page totals a projection over more than one day. Projected
 * leads and admissions are a standing forecast ops restates daily, so a window
 * total would be the target multiplied by the number of days — which is why
 * there is no admissions ring and no admissions headline, only a line whose
 * every point is one day's own figure.
 */
export default function Trend() {
  const { client } = useSession();
  const clientId = client?.id;

  const [days, setDays] = useState<number>(30);
  const [today, setToday] = useState<ISODate | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [prior, setPrior] = useState<Row[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    let alive = true;

    (async () => {
      setLoading(true);
      setError(null);

      const t = await businessToday();
      if (!alive) return;
      setToday(t);

      const from = addDays(t, -(days - 1));
      // Two equal windows back to back, in one query, split in JS. Two round
      // trips to compute a single percentage is not worth it.
      const priorFrom = addDays(t, -(days * 2 - 1));

      const [win, camps] = await Promise.all([
        supabase
          .from('daily_report')
          .select(SPEND_COLS)
          .eq('client_id', clientId)
          .gte('date', priorFrom)
          .lte('date', t)
          .order('date', { ascending: true }),
        // Every status: an archived campaign's figures are still the client's
        // and still appear in the windows it ran, so fetching only the active
        // ones would draw real history under "Campaign no longer listed".
        supabase
          .from('campaigns')
          .select('*')
          .eq('client_id', clientId)
          .order('name', { ascending: true }),
      ]);

      if (!alive) return;
      if (win.error) {
        setError(errorText(win.error));
        setLoading(false);
        return;
      }

      const all = (win.data ?? []) as Row[];
      setRows(all.filter((r) => r.date >= from));
      setPrior(all.filter((r) => r.date < from));
      // A failed campaign fetch costs names and colours, not figures. Failing
      // the whole page over a naming lookup would hide the numbers to protect
      // a label.
      if (!camps.error) setCampaigns(asRows<Campaign>(camps.data));
      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [clientId, days]);

  const toneOf = useMemo(() => campaignToner(campaigns), [campaigns]);
  const split = useMemo(() => isSplit(rows), [rows]);

  /**
   * Every day in the window, present or not.
   *
   * Built from the calendar rather than from the returned rows, so a week with
   * no entries has width on the axis. Deriving the axis from the data would
   * close the gap up and draw an unbroken line across days nobody entered.
   */
  const dates = useMemo<ISODate[]>(() => {
    if (!today) return [];
    const out: ISODate[] = [];
    for (let i = days - 1; i >= 0; i--) out.push(addDays(today, -i));
    return out;
  }, [today, days]);

  /**
   * One line per campaign, or one line for the client when there is nothing to
   * split.
   *
   * Folded by date within each campaign before plotting. Keying the rows
   * themselves by date would build a map whose values are whichever campaign
   * happened to arrive last for each day, and the chart would plot one
   * campaign's spend as the client's — wrong by an unpredictable fraction,
   * with no visible symptom, on the screen a client reads for shape.
   */
  const spendSeries = useMemo<TrendSeries[]>(() => {
    if (dates.length === 0) return [];

    const line = (rs: Row[]): (number | null)[] => {
      const byDate = new Map(foldToDays(rs, SPEND_FIELDS).map((d) => [d.date, d]));
      return dates.map((d) => byDate.get(d)?.totals.ad_spend ?? null);
    };

    if (!split) return [{ key: 'spend', name: 'Ad spend', tone: 'accent', values: line(rows) }];

    // `sliceByCampaign` decides which campaigns appear and in what order, so
    // the ring above, the lines here and the breakdown on the Spend report
    // list the same campaigns in the same order in the same colours.
    return sliceByCampaign(rows, SPEND_ACCRUING_FIELDS, campaigns).map((s) => ({
      key: campaignKey(s.id),
      name: s.name,
      tone: toneOf(s.id),
      values: line(rows.filter((r) => r.campaign_id === s.id)),
    }));
  }, [dates, rows, split, campaigns, toneOf]);

  /**
   * Projected admissions, as one line for the client.
   *
   * Summed across a day's campaigns, which is the direction projections may be
   * summed in — each campaign carries its own forecast and the day's forecast
   * is their sum. Never across days, which is why this is a line and not a
   * total anywhere on the page.
   */
  const admissionSeries = useMemo<TrendSeries[]>(() => {
    if (dates.length === 0) return [];
    const byDate = new Map(foldToDays(rows, SPEND_FIELDS).map((d) => [d.date, d]));
    return [
      {
        key: 'adm',
        name: 'Projected admissions',
        tone: null,
        values: dates.map((d) => byDate.get(d)?.totals.projected_admissions ?? null),
      },
    ];
  }, [dates, rows]);

  /** The window's spend split by campaign — the ring, and only when it splits. */
  const donut = useMemo<DonutSlice[]>(() => {
    if (!split) return [];
    return sliceByCampaign(rows, SPEND_ACCRUING_FIELDS, campaigns)
      // A campaign with nothing stated is left out rather than drawn at zero.
      // A zero-width slice is invisible but its legend row is not, and a row
      // reading "PR — ₹0 — 0.0%" claims Adovia stated PR spent nothing, which
      // is a different thing from PR not having been entered.
      .filter((s) => typeof s.totals.ad_spend === 'number')
      .map((s) => ({
        key: campaignKey(s.id),
        name: s.name,
        value: s.totals.ad_spend as number,
        tone: toneOf(s.id),
      }));
  }, [split, rows, campaigns, toneOf]);

  // No fold needed for these: summing every campaign row in the window is the
  // same arithmetic as summing the folded days. Only per-DAY figures — the
  // charts' points above — have to be folded before they mean anything.
  const spend = sumStated(rows, (r) => r.ad_spend);
  const impressions = sumStated(rows, (r) => r.impressions);
  const priorSpend = sumStated(prior, (r) => r.ad_spend);
  const spendDelta = delta(spend, priorSpend);
  const spendDays = useMemo(
    () => foldToDays(rows, SPEND_FIELDS).filter((d) => typeof d.totals.ad_spend === 'number').length,
    [rows],
  );

  if (loading) {
    return (
      <Shell>
        <div className="skeleton-page" />
      </Shell>
    );
  }

  const windowLabel = `last ${days} days`;

  return (
    <Shell>
      <PageHead
        title="Trend"
        sub={today ? `Through ${formatDate(today)}.` : undefined}
        actions={
          <div className="segmented" role="group" aria-label="Window">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                type="button"
                className={days === w.days ? 'on' : ''}
                onClick={() => setDays(w.days)}
              >
                {w.label}
              </button>
            ))}
          </div>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      {rows.length === 0 ? (
        <Card>
          <Empty
            title={`Nothing entered in the ${windowLabel}`}
            body="This page fills in as your Adovia team records each working day."
          />
        </Card>
      ) : (
        <>
          <Card title={`The ${windowLabel}`}>
            <div className="figures small">
              {/*
                Only the two columns that genuinely accrue. Spend and
                impressions are quantities a day produced, so a window of them
                adds up; the projections are not here for the reason given at
                the top of this file.
              */}
              <Stat label="Ad spend" value={money(spend)} />
              <Stat label="Cumulative impressions" value={count(impressions)} />
              {/*
                The preceding window as a figure in its own right, not just as
                the denominator of the percentage. A client asking "what did we
                spend before this" should not have to reverse it out of a delta.
              */}
              <Stat label={`Previous ${days} days`} value={money(priorSpend)} />
              <Stat label="Days recorded" value={`${spendDays} of ${days}`} />
            </div>

            <p className="muted mt">
              {spendDelta ? (
                <>
                  Spend is{' '}
                  <strong className={`dl ${spendDelta.direction}`}>
                    {spendDelta.direction === 'flat'
                      ? 'level with'
                      : `${spendDelta.pct.toFixed(0)}% ${spendDelta.direction} on`}
                  </strong>{' '}
                  the {days} days before this window — like for like, same number of days.
                </>
              ) : (
                `No comparable spend in the ${days} days before this window.`
              )}{' '}
              Totals skip days with no entry rather than counting them as zero, so
              &ldquo;days recorded&rdquo; is the honest denominator for everything above.
            </p>
          </Card>

          {/*
            The ring only exists when there is more than one campaign to divide
            between. A single-campaign client would get a complete circle
            labelled 100%, which is a picture of the number directly above it.
          */}
          {donut.length > 1 && typeof spend === 'number' && (
            <Card title={`Where the spend went — ${windowLabel}`}>
              <DonutChart
                slices={donut}
                total={spend}
                centreLabel="Ad spend"
                format={(n) => money(n) ?? ''}
                caption={
                  <>
                    Share of ad spend across the {windowLabel}. Shares are rounded to one
                    decimal and need not add to exactly 100. Impressions and the two
                    projection columns are not divided up here: impressions belong to the
                    day rather than to a budget, and projections are a standing forecast
                    restated daily, so a window of them is one target counted many times
                    over.
                  </>
                }
              />
            </Card>
          )}

          {/*
            Two charts, one date axis, stacked — the small-multiples answer to
            what used to be a dual-axis chart. Reading one shape against the
            other is exactly as easy and neither drawing asserts that the two
            quantities are on a common scale, because they visibly are not.
          */}
          <Card title={`Ad spend per day — ${windowLabel}`}>
            <TrendChart
              dates={dates}
              series={spendSeries}
              label="Ad spend"
              format={(n) => moneyExact(n) ?? ''}
              emptyText="No spend recorded in this window."
            />
            <p className="muted mt sm">
              {split
                ? 'One line per campaign, in the colours used by the ring above and by the breakdown on your Spend report. '
                : ''}
              A break in a line is a day with no entry. It is not a day of zero spend, and
              the line is not drawn across it.
            </p>
          </Card>

          <Card title={`Projected admissions per day — ${windowLabel}`}>
            <TrendChart
              dates={dates}
              series={admissionSeries}
              label="Projected admissions"
              format={(n) => compact(n)}
              emptyText="No projected admissions recorded in this window."
            />
            <p className="muted mt sm">
              Each point is that day&rsquo;s forecast across every campaign — a target
              your Adovia team restates daily, not a running count. That is why it has its
              own chart rather than a second axis on the one above, and why it is never
              totalled: adding a month of it would report the same target thirty times.
            </p>
          </Card>
        </>
      )}
    </Shell>
  );
}
