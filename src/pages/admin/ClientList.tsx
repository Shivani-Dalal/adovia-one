import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, errorText } from '../../lib/supabase';
import { Card, Empty, ErrorNote, PageHead, Shell } from '../../components/Shell';
import { money } from '../../lib/format';
import { businessToday, formatDate, relativeTime, type ISODate } from '../../lib/dates';
import { sumStated } from '../../lib/campaigns';
import type { Client, ClientStatus } from '../../lib/types';
import { NewClient } from './NewClient';

interface Aug extends Client {
  /** Today's spend, summed across whatever campaigns have been entered. */
  todaySpend: number | null;
  /**
   * Lines expected on today's grid — the client's active campaigns, or 1 for a
   * client who isn't split.
   */
  expected: number;
  /** Lines actually entered today. */
  entered: number;
  /** The newest stamp among today's rows, not any one campaign's. */
  lastUpdate: string | null;
  invoiceCount: number;
}

/** Today's row for one client, as this screen needs it. */
interface TodayRow {
  client_id: string;
  campaign_id: string | null;
  ad_spend: number | null;
  updated_at: string;
}

export default function ClientList() {
  const [clients, setClients] = useState<Aug[]>([]);
  const [today, setToday] = useState<ISODate | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<ClientStatus | 'all'>('active');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function load() {
    setLoading(true);
    const t = await businessToday();
    setToday(t);

    const [cRes, mRes, iRes, pRes] = await Promise.all([
      supabase.from('clients').select('*').order('name'),
      supabase
        .from('daily_report')
        .select('client_id, campaign_id, ad_spend, updated_at')
        .eq('date', t),
      supabase.from('invoices').select('client_id'),
      // Active only. This count is "what ops is expected to fill in today", and
      // a paused or archived campaign is off the grid by definition — counting
      // it would report every split client as permanently half-entered.
      supabase.from('campaigns').select('client_id').eq('status', 'active'),
    ]);

    if (cRes.error || mRes.error || iRes.error) {
      setError(errorText(cRes.error ?? mRes.error ?? iRes.error));
      setLoading(false);
      return;
    }

    // Grouped, not keyed. Keying by client_id kept whichever campaign row came
    // back last and printed its spend as the client's whole day — for a client
    // running three campaigns that is a number roughly a third of the truth,
    // shown without any sign that it is partial.
    const byClient = new Map<string, TodayRow[]>();
    for (const m of (mRes.data ?? []) as TodayRow[]) {
      const bucket = byClient.get(m.client_id);
      if (bucket) bucket.push(m);
      else byClient.set(m.client_id, [m]);
    }

    const counts = new Map<string, number>();
    for (const r of (iRes.data ?? []) as { client_id: string }[]) {
      counts.set(r.client_id, (counts.get(r.client_id) ?? 0) + 1);
    }

    const active = new Map<string, number>();
    if (!pRes.error) {
      for (const r of (pRes.data ?? []) as { client_id: string }[]) {
        active.set(r.client_id, (active.get(r.client_id) ?? 0) + 1);
      }
    }

    setClients(
      ((cRes.data ?? []) as Client[]).map((c) => {
        const mine = byClient.get(c.id) ?? [];
        return {
          ...c,
          todaySpend: sumStated(mine, (m) => m.ad_spend),
          // A client with no campaigns still has exactly one line to fill in:
          // the unattributed one. Zero expected would read as "nothing to do".
          expected: Math.max(active.get(c.id) ?? 0, 1),
          entered: mine.length,
          lastUpdate: mine.reduce<string | null>(
            (newest, m) => (newest === null || m.updated_at > newest ? m.updated_at : newest),
            null,
          ),
          invoiceCount: counts.get(c.id) ?? 0,
        };
      }),
    );
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return clients.filter(
      (c) =>
        (status === 'all' || c.status === status) &&
        (needle === '' ||
          c.name.toLowerCase().includes(needle) ||
          (c.vertical ?? '').toLowerCase().includes(needle)),
    );
  }, [clients, q, status]);

  /*
    Two counts now, because a split client has a third state. Before campaigns
    a client was entered or not; now ops can enter Google and not PR, and
    reporting that as "entered" would mark the day done with a campaign
    missing — the exact gap this banner exists to catch.
  */
  const active = clients.filter((c) => c.status === 'active');
  const missing = active.filter((c) => c.entered === 0).length;
  const partial = active.filter((c) => c.entered > 0 && c.entered < c.expected).length;

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
        title="Clients"
        sub={
          today && (
            <>
              {formatDate(today)} ·{' '}
              {missing === 0 && partial === 0 ? (
                'All active clients and campaigns entered today.'
              ) : (
                <strong className="warn">
                  {missing > 0 && (
                    <>
                      {missing} active client{missing === 1 ? '' : 's'} with no entry
                      today
                    </>
                  )}
                  {missing > 0 && partial > 0 && ', '}
                  {partial > 0 && (
                    <>
                      {partial} part-entered{missing === 0 ? ' today' : ''}
                    </>
                  )}
                  .
                </strong>
              )}
            </>
          )
        }
        actions={
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            Add client
          </button>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      {adding && (
        <NewClient
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void load();
          }}
        />
      )}

      <Card
        aside={
          <div className="filters">
            <input
              type="search"
              placeholder="Search name or vertical"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search clients"
            />
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as ClientStatus | 'all')}
              aria-label="Filter by status"
            >
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </select>
          </div>
        }
      >
        {shown.length === 0 ? (
          <Empty title="No clients match" />
        ) : (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Vertical</th>
                  <th className="num">Today&rsquo;s spend</th>
                  <th>Last updated</th>
                  <th className="num">Invoices</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/admin/clients/${c.id}`}>{c.name}</Link>
                    </td>
                    <td className="muted">{c.vertical ?? '—'}</td>
                    {/*
                      The day's spend across every campaign entered so far, with
                      the count beside it when that is fewer than expected. A
                      bare figure on a half-entered client is the worst of the
                      three states: it looks complete and is low, which reads as
                      an underspending campaign rather than an unfinished grid.
                    */}
                    <td className="num">
                      {c.entered === 0 ? (
                        <span className="muted">not entered</span>
                      ) : (
                        <>
                          {money(c.todaySpend) ?? <span className="muted">blank</span>}
                          {c.entered < c.expected && (
                            <span className="muted sm">
                              {' '}
                              · {c.entered} of {c.expected}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="muted">
                      {c.lastUpdate ? relativeTime(c.lastUpdate) : '—'}
                    </td>
                    <td className="num">{c.invoiceCount}</td>
                    <td>
                      <span className={`pill ${c.status}`}>{c.status}</span>
                    </td>
                    <td className="right">
                      <Link className="btn ghost sm" to={`/admin/clients/${c.id}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Shell>
  );
}
