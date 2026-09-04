import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../../auth/SessionProvider';
import { supabase, errorText } from '../../lib/supabase';
import { Card, Empty, ErrorNote, PageHead, Shell } from '../../components/Shell';
import { moneyExact } from '../../lib/format';
import { formatDate, monthKey, monthLabel } from '../../lib/dates';
import type { Invoice } from '../../lib/types';
import { InvoiceTable } from '../../components/InvoiceTable';

const ALL = 'all';

export default function Invoices() {
  const { client } = useSession();
  const clientId = client?.id;

  const [rows, setRows] = useState<Invoice[]>([]);
  const [month, setMonth] = useState<string>(ALL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    let alive = true;

    (async () => {
      setLoading(true);
      // The whole list in one query, filtered client-side. A client has tens of
      // invoices, not thousands, and fetching once means changing the month
      // dropdown is instant and cannot produce a loading flicker over a table
      // the user is reading.
      const { data, error: err } = await supabase
        .from('invoices')
        .select('*')
        .eq('client_id', clientId)
        .order('issue_date', { ascending: false })
        .order('created_at', { ascending: false });

      if (!alive) return;
      if (err) setError(errorText(err));
      else setRows((data ?? []) as Invoice[]);
      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [clientId]);

  /*
   * Options come from the invoices that exist, never from a generated range of
   * months. A dropdown offering "July 2026" that yields an empty table reads as
   * a missing invoice, and that is a support email.
   *
   * Grouped by issue_date, not created_at: "my August invoice" means the one
   * dated August, whatever day it was uploaded. Note that is the month the
   * invoice was RAISED — an invoice dated 2 July usually bills June's work — so
   * this groups by the date on the document, which is the one the client can
   * see for themselves.
   */
  const months = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of rows) {
      const k = monthKey(r.issue_date);
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [rows]);

  const shown = useMemo(
    () => (month === ALL ? rows : rows.filter((r) => monthKey(r.issue_date) === month)),
    [rows, month],
  );

  /**
   * What the client still owes in full, and how many invoices are settled in part.
   *
   * These are two numbers because they cannot honestly be one. An `issued`
   * invoice is owed in full, so its `amount` is exactly the sum to add. A
   * `partially_paid` one is owed in part, and the part is not recorded anywhere
   * in this schema — so folding its `amount` into the total would tell the client
   * they owe money they have already sent, and dropping it would tell them they
   * owe nothing. Neither is true. The count is reported alongside instead, and
   * `Nothing outstanding` is withheld while any part-paid invoice exists.
   */
  const billed = rows.filter((r) => typeof r.amount === 'number');
  const outstanding = billed
    .filter((r) => r.status === 'issued')
    .reduce((a, r) => a + (r.amount ?? 0), 0);
  const partCount = rows.filter((r) => r.status === 'partially_paid').length;

  const partPhrase =
    partCount === 0
      ? ''
      : `${partCount} part-paid invoice${partCount === 1 ? '' : 's'} not included`;

  const outstandingLine =
    outstanding > 0
      ? `${moneyExact(outstanding)} issued and unpaid${partPhrase ? `, ${partPhrase}` : ''}.`
      : partCount > 0
        ? `Nothing issued and unpaid, ${partPhrase}.`
        : 'Nothing outstanding.';

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
        title="Invoices"
        sub={
          rows.length === 0 ? undefined : outstandingLine
        }
        actions={
          months.length > 0 && (
            <div className="field inline">
              <label htmlFor="month">Period</label>
              <select
                id="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
              >
                <option value={ALL}>All months ({rows.length})</option>
                {months.map(([k, n]) => (
                  <option key={k} value={k}>
                    {monthLabel(k)} ({n})
                  </option>
                ))}
              </select>
            </div>
          )
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card>
        {rows.length === 0 ? (
          <Empty
            title="No invoices yet"
            body="Invoices appear here as your Adovia team issues them."
          />
        ) : shown.length === 0 ? (
          // Only reachable if the data changes under a stale selection, since
          // options are derived from the rows. Still says what happened.
          <Empty
            title={`No invoices for ${monthLabel(month)}`}
            body={
              <button type="button" className="linkish" onClick={() => setMonth(ALL)}>
                Show all months
              </button>
            }
          />
        ) : (
          <InvoiceTable rows={shown} />
        )}
      </Card>

      {rows.length > 0 && (
        <p className="asof">
          Showing {shown.length} of {rows.length} invoice{rows.length === 1 ? '' : 's'},
          {month === ALL
            ? ' all periods'
            : ` for ${monthLabel(month)}`}
          . Oldest is {formatDate(rows[rows.length - 1].issue_date)}. Download links are
          generated fresh each time and expire after a minute.
        </p>
      )}
    </Shell>
  );
}
