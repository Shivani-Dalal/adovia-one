-- ===========================================================================
-- Adovia Open — schema
--
-- Deliberately NOT idempotent. A second run fails loudly on `create table`
-- rather than quietly dropping tables that hold real data. Same house style as
-- the marketing repo's supabase/schema.sql.
--
-- Run order matters: functions before the policies that call them, tables
-- before the triggers on them, and campaigns before the two figure tables that
-- reference it.
--
-- Reconciled against the live database on 2026-09-04. Two divergences from what
-- is actually deployed are called out inline and marked DRIFT; everything else
-- in this file matches production as introspected.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. The business day
--
-- Adovia operates in IST; this database runs UTC. A bare current_date is the
-- previous calendar day between 00:00 and 05:30 IST — precisely the window in
-- which the client-facing "today" figures would silently show yesterday.
--
-- STABLE rather than IMMUTABLE: now() is fixed within a transaction but not
-- across them. That also means this cannot be used in a CHECK constraint,
-- which is fine — nothing here needs to.
-- ---------------------------------------------------------------------------

-- search_path is pinned empty like every other function here. This one is not
-- SECURITY DEFINER so the exposure is small, but a function that resolves names
-- differently depending on who calls it is a bad habit to keep even once.
-- now() and ::date live in pg_catalog, which stays implicitly resolvable.
create or replace function public.business_today() returns date
  language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Kolkata')::date;
$$;


-- ---------------------------------------------------------------------------
-- 1. Clients
-- ---------------------------------------------------------------------------

create table public.clients (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  name  text not null check (char_length(btrim(name)) between 1 and 160),
  slug  text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),

  -- Shown in the client-facing header. Points at the public marketing site's
  -- asset folder for pilot clients; a Storage path later if we let admins upload.
  logo_url text check (char_length(logo_url) <= 500),
  vertical text check (char_length(vertical) <= 80),

  status text not null default 'active'
    check (status in ('active', 'paused', 'archived'))
);

create index clients_status_name_idx on public.clients (status, name);


-- ---------------------------------------------------------------------------
-- 2. Profiles — the join between auth.users and a client
--
-- role='admin' rows have client_id null and see everything.
-- role='client' rows must name exactly one client. Enforced, not assumed:
-- this constraint is what stops a misconfigured client account seeing all data.
--
-- KNOWN LIMIT: one user, one client. A contact at a group with several
-- institutions under it (Manipal, for one) cannot hold two. Changing this later
-- means a profile_clients join table and touching every policy below.
--
-- client_id is ON DELETE RESTRICT, and that is the constraint an admin meets
-- when deleting a client: everything else a client owns cascades away, but a
-- login pointing at them does not, so the delete is refused until the login is
-- removed. See lib/deletion.ts, which translates that refusal into English
-- rather than pre-checking it — the only policy on this table is "read own
-- profile", so an admin cannot count a client's logins to check in advance.
-- ---------------------------------------------------------------------------

create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  role      text not null check (role in ('admin', 'client')),
  client_id uuid references public.clients (id) on delete restrict,
  full_name text check (char_length(full_name) <= 160),

  constraint profiles_role_client_match check (
    (role = 'admin'  and client_id is null) or
    (role = 'client' and client_id is not null)
  )
);

create index profiles_client_idx on public.profiles (client_id);


-- ---------------------------------------------------------------------------
-- 3. Campaigns
--
-- A client's figures used to be one row per day. They are now one row per
-- campaign per day, and this table is the list of lines ops is asked to fill
-- in. A client with no campaigns still works: their rows carry a null
-- campaign_id and read as "Not split by campaign".
--
-- Campaign names ARE client-facing copy. They print beside the client's own
-- figures in the by-campaign breakdown and land in the CSV they download, so
-- this is not an internal labelling table.
--
-- ON DELETE CASCADE from clients, but see the two figure tables below: they
-- point back here with RESTRICT, so a campaign that has ever carried a figure
-- cannot be removed while those rows exist. Deleting the CLIENT still works —
-- the cascade takes the figures out first, and the campaigns with them.
-- ---------------------------------------------------------------------------

create table public.campaigns (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients (id) on delete cascade,

  name text not null check (char_length(btrim(name)) between 1 and 120),

  -- active   — on the daily entry grid.
  -- paused   — off the grid, existing days stay editable.
  -- archived — off the grid, history kept and still shown to the client.
  status text not null default 'active'
    check (status in ('active', 'paused', 'archived')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  -- Redundant against the primary key, and required. It is the target of the
  -- composite foreign keys on daily_report and daily_actuals, which is what
  -- stops a row naming client A while pointing at a campaign owned by client B.
  -- Postgres will only reference a set of columns carrying a unique constraint.
  unique (id, client_id)
);

-- One campaign per name per client, case- and space-insensitive. Two campaigns
-- called "PR" would put two rows with one label in the client's breakdown, both
-- carrying real figures, with nothing to tell them apart.
--
-- Covers every status deliberately: an archived "PR" is invisible on the entry
-- grid but its figures are still in the client's history, so the name is still
-- spoken for. lib/campaigns.ts shadows this rule client-side so the refusal
-- arrives while the name is still in the box.
create unique index campaigns_client_name_key
  on public.campaigns (client_id, lower(btrim(name)));

create index campaigns_client_status_idx on public.campaigns (client_id, status);


-- ---------------------------------------------------------------------------
-- 4. Daily report — the heart of the product
--
-- Every number on this row is typed by a person. There is no derived column and
-- no view over this table: what ops enters is exactly what the client reads.
-- That is the whole design, and it is why updated_at, updated_by and the
-- history table below are load-bearing rather than decorative — with no model
-- to point at, provenance is the only answer to "where did this number come
-- from".
--
-- All five actuals and all three projections are nullable on purpose. Partial
-- entry is the normal case: ops often knows spend hours before it knows leads,
-- and a null renders as "not yet entered" rather than as a zero. Null means
-- "Adovia has not stated this"; 0 means "Adovia states it was zero". Nothing in
-- the app may collapse the two.
--
-- GRAIN: one row per client, per campaign, per date. campaign_id is nullable
-- and null is a real value here — it means "this client is not split by
-- campaign", which is how every row recorded before campaigns existed reads.
-- ---------------------------------------------------------------------------

create table public.daily_report (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients (id) on delete cascade,
  campaign_id uuid references public.campaigns (id) on delete restrict,
  date       date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Actuals.
  ad_spend    numeric(14,2) check (ad_spend    >= 0),
  impressions bigint        check (impressions >= 0),
  clicks      bigint        check (clicks      >= 0),
  leads       integer       check (leads       >= 0),
  admissions  integer       check (admissions  >= 0),

  -- Projections. Stated by Adovia, not computed from anything.
  --
  -- These sum ACROSS CAMPAIGNS within a day and never ACROSS DAYS. Ops prefills
  -- each day's projection from the day before, so a month of them is one
  -- standing forecast restated thirty times; adding it up reports thirty times
  -- the target. See SPEND_ACCRUING_FIELDS in lib/spendReport.ts, which is the
  -- field list that makes the distinction.
  projected_impressions bigint  check (projected_impressions >= 0),
  projected_leads       integer check (projected_leads       >= 0),
  projected_admissions  integer check (projected_admissions  >= 0),

  -- THE CLIENT READS THIS. There is no view standing between this table and
  -- the client app, so anything written here is visible to them. Ops commentary
  -- that is not for the client goes in daily_report_notes below.
  client_note text check (char_length(client_note) <= 2000),

  -- Who last touched this row, set by trigger rather than by the client. With
  -- hand-entered figures and clients who are banks, "who changed this and when"
  -- is a question that will be asked.
  updated_by uuid references auth.users (id),

  -- NULLS NOT DISTINCT is the whole point. Postgres treats nulls as distinct in
  -- a unique constraint by default, which would let a client accumulate any
  -- number of unattributed rows for the same date — every one of them a
  -- separate assertion about that day, silently summed into the total the
  -- client reads. This makes the unattributed row per date exactly one.
  constraint daily_report_client_campaign_date_key
    unique nulls not distinct (client_id, campaign_id, date),

  -- Belt and braces against a row whose campaign belongs to another client.
  -- The single-column FK above already points at campaigns; this one pins the
  -- pair, so campaign_id can only name a campaign of THIS client_id.
  constraint daily_report_campaign_same_client
    foreign key (campaign_id, client_id)
    references public.campaigns (id, client_id) on delete restrict
);

-- Serves the client date picker (client_id + exact date), the latest-row read
-- (client_id, order by date desc limit 1) and the 30-day trend window.
create index daily_report_client_date_idx on public.daily_report (client_id, date desc);
create index daily_report_date_idx        on public.daily_report (date desc);

-- Serves the campaign breakdown and, more importantly, the usage check in
-- lib/deletion.ts that decides whether a campaign is safe to delete.
create index daily_report_campaign_idx on public.daily_report (campaign_id, date);


-- ---------------------------------------------------------------------------
-- 5. Internal notes — a separate table, and only because of RLS
--
-- Admins and clients are both the `authenticated` Postgres role, so column
-- grants cannot hide a column from one and show it to the other; that is the
-- whole reason this is not simply a second text column on daily_report. Being
-- a separate table lets an admin-only RLS policy do the work.
--
-- If ops has nowhere private to write "spend spiked, client asked why", they
-- will write it in client_note. This table is cheaper than that mistake.
-- ---------------------------------------------------------------------------

create table public.daily_report_notes (
  metric_id  uuid primary key references public.daily_report (id) on delete cascade,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),
  note       text check (char_length(note) <= 2000)
);


-- ---------------------------------------------------------------------------
-- 6. Adovia's actuals — internal only
--
-- What actually happened, as against what the client was told. Same grain as
-- daily_report and the same null rule, but no client ever reads a row of it:
-- there is one policy on this table and it is admin-only in both directions.
--
-- Carries NO ad_spend column. It was dropped once it was clear the number ops
-- entered here was always the same number they had already entered on the
-- client-facing row — a second place to state one fact, which is a drift
-- waiting to happen rather than a cross-check. The dropped values were kept in
-- daily_actuals_ad_spend_dropped; see section 15.
-- ---------------------------------------------------------------------------

create table public.daily_actuals (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  campaign_id uuid references public.campaigns (id) on delete restrict,
  date        date not null,

  impressions bigint  check (impressions >= 0),
  leads       integer check (leads       >= 0),
  admissions  integer check (admissions  >= 0),

  note       text check (char_length(note) <= 2000),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  constraint daily_actuals_client_campaign_date_key
    unique nulls not distinct (client_id, campaign_id, date),

  constraint daily_actuals_campaign_same_client
    foreign key (campaign_id, client_id)
    references public.campaigns (id, client_id) on delete restrict
);

create index daily_actuals_campaign_idx on public.daily_actuals (campaign_id, date);


-- ---------------------------------------------------------------------------
-- 7. Creatives
--
-- Ad artwork, in a private bucket. Unlike invoices, CLIENTS may upload and
-- delete their own — they are the ones with the brand assets — so the policies
-- below are `is_admin() or client_id = my_client_id()` rather than admin-only.
--
-- There is no update policy, by omission and on purpose: a creative is
-- replaced by uploading a new one, not by mutating the row under a path
-- somebody may already hold a signed URL for.
-- ---------------------------------------------------------------------------

create table public.creatives (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients (id) on delete cascade,
  created_at timestamptz not null default now(),

  title text not null check (char_length(title) between 1 and 200),
  note  text check (char_length(note) <= 2000),

  -- Path inside the 'creatives' bucket. Convention: {client_id}/{creative_id}.
  -- The leading segment IS the authorisation check — see the Storage policies.
  storage_path text not null unique check (char_length(storage_path) <= 500),

  mime_type  text   not null,
  size_bytes bigint not null check (size_bytes > 0),

  uploaded_by uuid references auth.users (id)
);

create index creatives_client_created_idx on public.creatives (client_id, created_at desc);


-- ---------------------------------------------------------------------------
-- 8. Invoices
--
-- The file itself lives in a PRIVATE Storage bucket. This table holds only the
-- path and the metadata the client list needs, so rendering the invoice list
-- never touches Storage.
-- ---------------------------------------------------------------------------

create table public.invoices (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  created_at  timestamptz not null default now(),

  number       text not null check (char_length(number) between 1 and 60),

  -- The date printed on the invoice, and the one thing every invoice format
  -- agrees to show. NOT NULL because the client-facing month dropdown groups by
  -- it, and a nullable column there buys an "Undated" bucket nobody wants to
  -- explain.
  --
  -- This replaced a period_start/period_end range. The range was a guess at what
  -- "my August invoice" means, and the documents disagree with it: SGB/26-27/0007
  -- is dated 2 July 2026 and bills a June campaign, so filing by period put the
  -- invoice in a month its own face does not mention. The range was also typed
  -- by hand from a "Campaign Duration" line and usually left on its default,
  -- whereas issue_date can be read straight off the PDF — see `invoicePdf.ts`.
  issue_date   date not null,

  amount       numeric(14,2) check (amount >= 0),
  currency     text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),

  -- partially_paid exists because the alternative was ops leaving a half-paid
  -- invoice on 'issued' and tracking the rest in their head. A status the real
  -- process has and the schema does not is a status that gets recorded in a
  -- note field.
  status text not null default 'issued'
    check (status in ('draft', 'issued', 'partially_paid', 'paid', 'void')),

  -- Path inside the 'invoices' bucket. Convention: {client_id}/{invoice_id}.pdf
  -- The leading path segment IS the authorisation check — see the Storage
  -- policies below. Do not change the convention without changing those.
  --
  -- The id is minted in the browser so the path can be built before the row
  -- exists; the default above is for rows created any other way.
  storage_path text not null check (char_length(storage_path) <= 500),

  uploaded_by uuid references auth.users (id),

  unique (client_id, number)
);

create index invoices_client_created_idx on public.invoices (client_id, created_at desc);

-- The month dropdown reads distinct issue_date months for one client, then
-- filters to a range. Both go through this.
create index invoices_client_issue_idx on public.invoices (client_id, issue_date desc);


-- ---------------------------------------------------------------------------
-- 9. Change history — append-only
--
-- updated_by answers "who touched this last". It does not answer "what did this
-- number say before someone corrected it", which is the question that actually
-- arrives, by email, from a client who has already screenshotted the old value.
-- Every figure in this product is a human assertion, so the prior assertion is
-- the record.
--
-- Rows are written only by the trigger below. There is no update or delete
-- policy anywhere, which is what "append-only" means here.
--
-- Carries NO foreign keys, deliberately. metric_id and client_id are plain
-- uuids, so deleting a client cascades their figures away and leaves the
-- history of what they were once told standing. That is the point of an audit
-- trail: it must outlive the thing it audits.
-- ---------------------------------------------------------------------------

create table public.daily_report_history (
  id         bigint generated always as identity primary key,
  metric_id  uuid not null,
  client_id  uuid not null,
  campaign_id uuid,
  date       date not null,
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users (id),

  -- The values as they stood BEFORE the change that produced this row.
  ad_spend    numeric(14,2),
  impressions bigint,
  clicks      bigint,
  leads       integer,
  admissions  integer,
  projected_impressions bigint,
  projected_leads       integer,
  projected_admissions  integer,
  client_note text
);

create index daily_report_history_metric_idx on public.daily_report_history (metric_id, changed_at desc);


-- ---------------------------------------------------------------------------
-- 10. Triggers
-- ---------------------------------------------------------------------------

-- Sets updated_at AND updated_by together, on insert and on update.
--
-- Without this, updated_at only ever holds its default — the row's creation
-- time — and the "Updated 2 hours ago" stamp on every client-facing figure
-- becomes the one number in the product that lies. That stamp is the trust
-- argument, so this trigger is not housekeeping.
--
-- Deliberately NOT security definer: it touches no table and needs no elevated
-- privilege, so it does not get any.
create or replace function public.set_row_actor()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end;
$$;

create trigger daily_report_set_actor
  before insert or update on public.daily_report
  for each row execute function public.set_row_actor();

create trigger daily_report_notes_set_actor
  before insert or update on public.daily_report_notes
  for each row execute function public.set_row_actor();

create trigger daily_actuals_set_actor
  before insert or update on public.daily_actuals
  for each row execute function public.set_row_actor();

create trigger campaigns_set_actor
  before insert or update on public.campaigns
  for each row execute function public.set_row_actor();

-- Definer, unlike the one above, and for a specific reason: authenticated has
-- no insert grant on the history table and must not have one, or the audit
-- trail becomes writeable by the people it audits.
create or replace function public.record_metric_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.daily_report_history (
    metric_id, client_id, campaign_id, date, changed_by,
    ad_spend, impressions, clicks, leads, admissions,
    projected_impressions, projected_leads, projected_admissions, client_note
  ) values (
    old.id, old.client_id, old.campaign_id, old.date, auth.uid(),
    old.ad_spend, old.impressions, old.clicks, old.leads, old.admissions,
    old.projected_impressions, old.projected_leads, old.projected_admissions, old.client_note
  );
  return new;
end;
$$;

create trigger daily_report_record_history
  after update on public.daily_report
  for each row execute function public.record_metric_history();

-- There is no history trigger on daily_actuals, and that is a decision rather
-- than an omission: nothing in that table was ever shown to a client, so there
-- is no prior assertion to defend.

-- PostgREST publishes anything executable as an RPC endpoint. Trigger functions
-- are not callable that way, but we revoke on them anyway on the principle that
-- "it errors out" is not a permission model.
revoke all on function public.set_row_actor()         from public, anon, authenticated;
revoke all on function public.record_metric_history() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 11. New user → profile
--
-- The invite Edge Function passes role and client_id in user metadata; this
-- copies them across. An invite that omits client_id produces a role='client'
-- row with a null client_id, which violates profiles_role_client_match and
-- aborts the auth.users insert along with it. That is the correct direction to
-- fail — the Edge Function validates first so it never gets here.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, role, client_id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'role', 'client'),
    nullif(new.raw_user_meta_data ->> 'client_id', '')::uuid,
    new.raw_user_meta_data ->> 'full_name'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

revoke all on function public.handle_new_user() from public, anon, authenticated;


-- ===========================================================================
-- 12. Row level security
-- ===========================================================================

alter table public.clients               enable row level security;
alter table public.profiles              enable row level security;
alter table public.campaigns             enable row level security;
alter table public.daily_report          enable row level security;
alter table public.daily_report_notes    enable row level security;
alter table public.daily_report_history  enable row level security;
alter table public.daily_actuals         enable row level security;
alter table public.creatives             enable row level security;
alter table public.invoices              enable row level security;

-- Revoke first, grant back narrowly. RLS is the gate, but the grant is the
-- outer door, and TRUNCATE in particular is NOT subject to RLS at all — it is
-- controlled by the grant alone. Supabase's default privileges hand anon and
-- authenticated full DML on every new table in `public`, so a table that is
-- only ever protected by a policy is one ALTER TABLE ... DISABLE away from
-- being world-writable.
--
-- DRIFT: the live database has these revokes on the six original tables but NOT
-- on campaigns, daily_actuals or creatives — those three were added later and
-- kept Supabase's defaults, so anon currently holds DELETE/INSERT/UPDATE/
-- TRUNCATE on them. RLS is denying anon every row-level operation today, so
-- nothing leaks, but the defence in depth this section describes is not
-- actually in place. Run the revoke below against production to fix it.
revoke all on public.clients, public.profiles, public.campaigns,
              public.daily_report, public.daily_report_notes,
              public.daily_report_history, public.daily_actuals,
              public.creatives, public.invoices
  from anon, authenticated;

-- Clients read these directly. There is no view in between, so every column
-- listed in the table definitions above is a column the client can see.
grant select on public.clients, public.campaigns, public.daily_report,
                public.creatives, public.invoices
  to authenticated;

grant insert, update, delete on public.clients, public.campaigns,
                                public.daily_report, public.daily_report_notes,
                                public.daily_actuals, public.invoices
  to authenticated;   -- narrowed to admins by the policies below

-- Creatives get insert and delete but no update: there is no update policy, and
-- a grant without a policy is a door with no handle. Kept explicit so the
-- omission reads as deliberate.
grant insert, delete on public.creatives to authenticated;

grant select on public.profiles, public.daily_report_notes,
                public.daily_actuals, public.daily_report_history
  to authenticated;   -- narrowed by policy; history is admin-read, never written

grant execute on function public.business_today() to authenticated;

-- The two predicates every policy is built from. STABLE + SECURITY DEFINER so
-- they can read profiles without recursing into profiles' own RLS.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

create or replace function public.my_client_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.client_id from public.profiles p where p.id = auth.uid();
$$;

-- Revoked from anon and public, but deliberately left executable by
-- authenticated: the policies below call them as the caller, and the frontend
-- legitimately asks "am I an admin" to pick a shell. Both only ever report on
-- the caller's own row, so exposing them as RPC leaks nothing.
revoke all on function public.is_admin()      from public, anon;
revoke all on function public.my_client_id()  from public, anon;
grant execute on function public.is_admin(), public.my_client_id() to authenticated;

-- A user reads their own profile row and nothing else. Writes are service_role
-- only (the invite Edge Function), so nobody can promote themselves to admin.
--
-- Note what this costs: an admin cannot read anybody else's profile either, so
-- no screen can count how many logins a client has. lib/deletion.ts is built
-- around that — it lets the RESTRICT on profiles.client_id refuse the delete
-- and translates the error, rather than pre-checking a number it would always
-- read as zero.
create policy "read own profile" on public.profiles
  for select to authenticated using (id = auth.uid());

-- Clients: read your own; admins read and write all.
create policy "client reads own client" on public.clients
  for select to authenticated
  using (public.is_admin() or id = public.my_client_id());

create policy "admin writes clients" on public.clients
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Campaigns: clients read their own because the names are printed beside their
-- figures; only admins change them.
--
-- DRIFT: live has these two policies as `to public` rather than `to
-- authenticated`, unlike every other policy in this file. Harmless in practice
-- — is_admin() and my_client_id() both come back false/null for anon, so the
-- predicates deny it anyway — but it is an inconsistency, and the version below
-- is the one worth converging on.
create policy "read own campaigns" on public.campaigns
  for select to authenticated
  using (public.is_admin() or client_id = public.my_client_id());

create policy "admin writes campaigns" on public.campaigns
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Daily report: the core tenant boundary.
create policy "read own metrics" on public.daily_report
  for select to authenticated
  using (public.is_admin() or client_id = public.my_client_id());

create policy "admin writes metrics" on public.daily_report
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Internal notes: admin only, in both directions. This is the policy that makes
-- the separate table worth having.
create policy "admin only internal notes" on public.daily_report_notes
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Actuals: admin only, same reasoning, and the reason there is exactly one
-- policy here rather than a read policy and a write policy.
create policy "admin only actuals" on public.daily_actuals
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- History: admins read it, nobody writes it. The absence of an insert policy is
-- intentional, and record_metric_history() is security definer precisely so it
-- can write past this.
create policy "admin reads history" on public.daily_report_history
  for select to authenticated
  using (public.is_admin());

-- Creatives: clients participate here, unlike everywhere else.
create policy "read own creatives" on public.creatives
  for select to authenticated
  using (public.is_admin() or client_id = public.my_client_id());

create policy "client uploads creatives" on public.creatives
  for insert to authenticated
  with check (public.is_admin() or client_id = public.my_client_id());

create policy "delete own creatives" on public.creatives
  for delete to authenticated
  using (public.is_admin() or client_id = public.my_client_id());

-- Invoices: same shape as the report.
create policy "read own invoices" on public.invoices
  for select to authenticated
  using (public.is_admin() or client_id = public.my_client_id());

create policy "admin writes invoices" on public.invoices
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());


-- ===========================================================================
-- 13. Storage
--
-- Create the buckets first, in the dashboard or with the statements below, and
-- make sure public = false on both. Files are never served directly; the app
-- requests a signed URL valid for 60 seconds at click time.
--
-- NOTE: no cascade reaches Storage. Deleting a client removes their invoice and
-- creative ROWS through the foreign keys above and leaves the FILES behind, so
-- lib/deletion.ts collects the storage paths before the delete and removes them
-- afterwards. Row first, files second — a half-failed delete that leaves
-- orphaned files is invisible, where a live client whose invoice links 404 is
-- not.
-- ===========================================================================

insert into storage.buckets (id, name, public)
values ('invoices', 'invoices', false);

-- Creatives are uploaded by clients, so the bucket carries limits the invoice
-- one does not need: 50 MB and an explicit type list. A bucket that accepts
-- anything from a browser is one that eventually holds someone's .exe.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'creatives', 'creatives', false, 52428800,
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
        'video/mp4', 'video/quicktime', 'application/pdf']
);

-- The first path segment is the client id, and that is the whole check.
create policy "read own invoice files" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'invoices'
    and (
      public.is_admin()
      or (storage.foldername(name))[1] = public.my_client_id()::text
    )
  );

create policy "admin uploads invoice files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'invoices' and public.is_admin());

-- UPDATE needs both clauses: `using` tests the object being replaced, `with
-- check` the replacement. Note that supabase-js .upload({ upsert: true }) is an
-- UPDATE, not an INSERT, and fails without this policy.
create policy "admin updates invoice files" on storage.objects
  for update to authenticated
  using      (bucket_id = 'invoices' and public.is_admin())
  with check (bucket_id = 'invoices' and public.is_admin());

-- Exists mainly for the compensating delete in the upload flow, and as an
-- escape hatch for a genuinely stuck upload. It is NOT the route for replacing
-- an issued invoice: void the old row and issue a new number.
create policy "admin deletes invoice files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'invoices' and public.is_admin());

-- Creative files mirror the creatives table: clients may read, write and delete
-- within their own folder. Same first-segment convention, same check.
create policy "read own creative files" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'creatives'
    and (
      public.is_admin()
      or (storage.foldername(name))[1] = public.my_client_id()::text
    )
  );

create policy "client writes creative files" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'creatives'
    and (
      public.is_admin()
      or (storage.foldername(name))[1] = public.my_client_id()::text
    )
  );

create policy "delete own creative files" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'creatives'
    and (
      public.is_admin()
      or (storage.foldername(name))[1] = public.my_client_id()::text
    )
  );


-- ===========================================================================
-- 14. Bootstrapping the first admin
--
-- Chicken-and-egg, and it bites harder than it looks. The invite Edge Function
-- requires an admin caller and there is no admin yet, so the first one is made
-- by hand. But you cannot simply add the user in the dashboard and promote the
-- profile afterwards: the dashboard's Add User form sets no user metadata, so
-- handle_new_user() defaults to role='client' with a null client_id, which
-- violates profiles_role_client_match. The trigger is AFTER INSERT in the same
-- transaction, so that constraint failure aborts the auth.users insert too —
-- you get "Database error creating new user" and no row to promote.
--
-- So stand the trigger down for the one insert that cannot satisfy it:
--
--   -- 1. in the SQL editor
--   drop trigger if exists on_auth_user_created on auth.users;
--
--   -- 2. Authentication → Users → Add user, with Auto Confirm User ticked.
--   --    This creates the account; it does not send a magic link. Sign in
--   --    through the app's login form afterwards.
--
--   -- 3. back in the SQL editor
--   insert into public.profiles (id, role, client_id, full_name)
--   select id, 'admin', null, 'Your Name'
--     from auth.users where email = 'you@adovia.in';
--
--   create trigger on_auth_user_created
--     after insert on auth.users
--     for each row execute function public.handle_new_user();
--
-- Drop/recreate rather than ALTER TABLE ... DISABLE TRIGGER: auth.users is
-- owned by supabase_auth_admin, and DISABLE needs ownership where CREATE
-- TRIGGER only needs the TRIGGER privilege you already have.
--
-- Everything after this goes through the app.
--
-- Turn off public signups before doing any of this — see section 16.
-- ===========================================================================


-- ===========================================================================
-- 15. Tables in the live database that this file does NOT create
--
-- Three leftovers from the 2026-09-04 migrations. None is referenced by any
-- code, none is part of the schema, and all three should be dropped once the
-- data they hold is confirmed unnecessary:
--
--   _backup_daily_report_20260904   52 rows
--   _backup_daily_actuals_20260904  32 rows
--   daily_actuals_ad_spend_dropped  32 rows — the ad_spend values removed from
--                                   daily_actuals, kept in case the column was
--                                   wanted back.
--
-- The two _backup tables were made with `create table as`, which copies rows
-- and nothing else — no RLS, no policies — while Supabase's default grants gave
-- anon and authenticated full DML. For a period they were readable and
-- writable with the publishable key that ships in the front-end bundle. RLS is
-- now enabled on both with no policy attached, which denies everyone except
-- service_role.
--
-- To drop them:
--   drop table public._backup_daily_report_20260904;
--   drop table public._backup_daily_actuals_20260904;
--   drop table public.daily_actuals_ad_spend_dropped;
-- ===========================================================================


-- ===========================================================================
-- 16. Dashboard settings this file cannot set
--
-- Two things live in Auth config rather than SQL, and both are load-bearing.
--
-- a) Disable public signups.
--    Authentication → Sign In / Providers → Email → "Allow new users to sign
--    up" = off.
--
--    This product has no self-signup at all: the login form calls
--    signInWithOtp with shouldCreateUser:false, and every real account arrives
--    from admin-invite-client-user under the service role. But that only
--    governs *our* callers. With signups enabled, anyone who knows the project
--    URL can POST /auth/v1/signup directly and get an account.
--
--    Right now they'd fail — handle_new_user() would default them to
--    role='client' with a null client_id and profiles_role_client_match would
--    abort the insert. That is real protection, but it is accidental: it is a
--    constraint written for data integrity happening to also serve as an
--    access control, and the day someone relaxes that constraint to make some
--    unrelated thing work, the front door opens with no test failing. Turn the
--    setting off and let the constraint go back to meaning one thing.
--
-- b) Redirect URLs.
--    Authentication → URL Configuration → Redirect URLs must list every origin
--    the app is served from. Login.tsx sends emailRedirectTo:
--    window.location.origin, and an origin missing from that allowlist is
--    silently rewritten to Site URL — the mail arrives, the link works, and it
--    lands the user on the wrong host.
--
--      https://open.adovia.in
--      http://localhost:5273
-- ===========================================================================
