# Adovia One

Client reporting for `open.adovia.in`. Two audiences, three nouns: **clients**,
**daily reports**, **invoices**.

Built from `adovia-one-spec.md`. Read that first — it carries the reasoning;
this file only says how to run the thing.

## The one thing to understand before changing anything

**Every figure in this product is typed by a person.** Nothing is computed,
derived, or pulled from an API. That has three consequences the code enforces:

1. **Null is not zero.** A null means "Adovia has not stated this yet" and must
   render as a visibly different, dashed *Not yet entered* state. `format.ts`
   returns `string | null` rather than `''` or `'0'` specifically so that no
   caller can collapse the two by accident, and `<Figure>` is the only component
   that decides how a null looks.
2. **Provenance is the only answer to "where did this number come from".** With
   no model to point at, `updated_at`, `updated_by`, and
   `daily_report_history` are load-bearing. They are maintained by triggers,
   not by the client, so they cannot be forgotten or spoofed.
3. **Today's row does not exist until ops enters it.** Client screens read the
   *most recent* row and label it with its date. Asking for today would render
   blanks every morning, all weekend, and every public holiday.

## Running it

```sh
cp .env.example .env.local     # fill in from Supabase → Settings → API
npm install
npm run dev                    # http://localhost:5273
```

`npm run typecheck` · `npm run build`

Only the Supabase **publishable** key belongs in `.env.local`. The service-role
key lives in the Edge Function's environment and nowhere else.

## Setting up the backend

1. Run `supabase/schema.sql` once, in the SQL editor. It is deliberately **not
   idempotent** — a second run fails loudly rather than dropping tables holding
   real data.
2. Confirm the `invoices` bucket exists and is **private**. The schema creates
   it; if it was already there, check the flag.
3. Deploy the invite function and set its one non-injected secret:

   ```sh
   supabase functions deploy admin-invite-client-user
   supabase secrets set SITE_URL=https://open.adovia.in
   ```

4. Bootstrap the first admin by hand. The invite function requires an admin
   caller and there isn't one yet — see the comment at the foot of `schema.sql`.

## Layout

```
src/lib/        supabase client, types, IST dates, INR formatting,
                CSV writing, the shared spend report, outlier baselines
src/auth/       session context, magic-link login, route gate
src/components/ Figure, Shell, DatePager, TrendChart, InvoiceTable,
                CreativeList, Modal
src/pages/client/  Overview, SpendReport, Trend, Invoices, Creatives
src/pages/admin/   DailyEntry, ClientList, NewClient, ClientDetail,
                   InvoiceUpload, InviteUser
supabase/       schema.sql, functions/
```

### Dates

IST is the business day. Dates are plain `'YYYY-MM-DD'` strings, never `Date`
objects, and every boundary goes through `dates.ts`.

Two things that look right and are not: `new Date()` follows whoever is
travelling, and `.toISOString().slice(0, 10)` is UTC — between 00:00 and 05:30
IST it names *yesterday*. That is the exact bug `public.business_today()` exists
to prevent, so don't reintroduce it on the client.

### Authorisation

RLS does authorisation, in the database. `<Protected>` picks a shell; it is
routing, not security, and deleting it would not expose a single row. Admins and
clients are both the `authenticated` Postgres role — which is why internal notes
are a separate *table* rather than a hidden column, since column grants cannot
tell the two apart.

## Things that will bite

- **The entry grid prefills projections only, never actuals.** Copying yesterday's
  spend forward puts a plausible figure in front of ops on a day nobody checked,
  and one distracted Save publishes it as fact. Prefilled cells render dashed
  and are not counted as changes until edited, so a blind Save writes nothing.
- **Invoice upload goes file-first, row-second.** A file with no row is
  unreachable — the only route to a download is a signed URL minted from
  `invoices.storage_path` — so a failed insert costs orphaned bytes, not an
  exposure. The reverse order gives the client an invoice they can see and click
  and cannot download.
- **Never overwrite an issued invoice.** Void the row and issue a new number. A
  client who filed the original last week should not find a different document
  at the same number today.
- **The trend chart is hand-rolled SVG on purpose.** Every charting library
  interpolates across missing points, which draws a smooth line through days
  Adovia never entered. Here a null breaks the path and the gap stays visible.

## Deploy

Its own Vercel project, not the marketing site's. `vercel.json` sets
`X-Frame-Options: DENY` and keeps `Cache-Control: public` off authenticated
responses — `public` caching is how one client's figures end up in front of
another behind a shared proxy.
