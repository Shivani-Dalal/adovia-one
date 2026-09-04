// Hand-written rather than generated, because the generated file would also
// carry Insert/Update/Relationships variants for six tables and this app touches
// a small, stable subset. Regenerate from Supabase if the schema grows.

/**
 * The supabase-js client is untyped here (no generated Database type), so when
 * a `.select()` is given a string variable rather than a literal it infers
 * `GenericStringError[]` and refuses a direct cast. This says "trust the shape"
 * in one place instead of scattering `as unknown as T` through every page.
 */
export function rows<T>(data: unknown): T[] {
  return (data ?? []) as T[];
}

export type ClientStatus = 'active' | 'paused' | 'archived';
/**
 * `partially_paid` means money has arrived against the invoice but not all of
 * it. How much is deliberately unknown — there is no `amount_paid` column — so
 * the status says "not settled" and refuses to say by how much. Anything adding
 * up what a client still owes has to handle that rather than assume `amount`.
 */
export type InvoiceStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'void';

/**
 * Display text for a status, because one of them is no longer a word.
 *
 * The invoice pill used to render the raw column, which was fine while every
 * value was a single lowercase word. `partially_paid` would come out of that as
 * "PARTIALLY_PAID" on a document a client reads, so the mapping is explicit and
 * every status goes through it rather than only the awkward one.
 */
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  issued: 'Issued',
  partially_paid: 'Part paid',
  paid: 'Paid',
  void: 'Void',
};
export type Role = 'admin' | 'client';

export interface Client {
  id: string;
  created_at: string;
  updated_at: string;
  name: string;
  slug: string;
  logo_url: string | null;
  vertical: string | null;
  status: ClientStatus;
}

export type CampaignStatus = 'active' | 'paused' | 'archived';

/**
 * A named line of work inside a client — "Google Ads", "PR", "Meta".
 *
 * Client-readable, which makes `name` client-facing copy rather than an internal
 * label: it is printed beside the client's own figures and lands in the CSV they
 * download. Name a campaign the way you would say it to them on a call.
 *
 * A campaign that has carried a figure cannot be deleted. `daily_report` and
 * `daily_actuals` point here with `on delete restrict`, so the database refuses
 * — removing one would be removing figures the client has already been shown.
 * `archived` is the operation for those: it takes the campaign out of the entry
 * grid and leaves every figure exactly where it is.
 *
 * One that has carried nothing is only configuration, and Manage on the daily
 * grid will delete it. See `lib/deletion.ts`, which asks what a campaign holds
 * before offering the button rather than letting the foreign key answer.
 */
export interface Campaign {
  id: string;
  client_id: string;
  name: string;
  status: CampaignStatus;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

/**
 * The label for a row that has no campaign.
 *
 * `campaign_id` is null on every row recorded before a client was split into
 * campaigns, and that is a fact rather than a gap: nobody wrote down which
 * campaign those figures belonged to, so the UI must not imply one. It still
 * counts toward every total — the figures were real, only the attribution is
 * missing.
 */
export const UNATTRIBUTED = 'Not split by campaign';

export interface Profile {
  id: string;
  role: Role;
  client_id: string | null;
  full_name: string | null;
}

/**
 * What Adovia *states* to the client for one day — the published figures. Its
 * counterpart is `DailyActuals`, which is what Adovia *measured*; keeping the
 * two apart is the reason this product exists.
 *
 * Every numeric field is nullable and that is load-bearing, not defensive.
 * Null means "Adovia has not stated this yet"; 0 means "Adovia states it was
 * zero". The UI must never collapse the two — see `Figure`.
 *
 * One row is one client-campaign-day, not one client-day. A client's figure for
 * a date is the SUM of its rows and is computed on read, never stored — storing
 * it would be a second record of a number the parts already state, and the two
 * would drift the first time one part was corrected.
 */
export interface DailyReport {
  id: string;
  client_id: string;

  /**
   * Null means "recorded before this client was split into campaigns", which is
   * a fact and not a gap to backfill. Such rows still count toward the client's
   * totals; only the attribution is missing. See `UNATTRIBUTED`.
   */
  campaign_id: string | null;
  date: string; // 'YYYY-MM-DD', an IST calendar date
  created_at: string;
  updated_at: string;

  ad_spend: number | null;
  impressions: number | null;
  clicks: number | null;
  leads: number | null;
  admissions: number | null;

  projected_impressions: number | null;
  projected_leads: number | null;
  projected_admissions: number | null;

  client_note: string | null;
  updated_by: string | null;
}

/**
 * Every column of a `daily_report` row, as a PostgREST select list.
 *
 * Shared by the two admin screens that need the whole row. Both must ask for
 * all eight figures even though the grid only offers four: `cellsFrom` and the
 * history diff round-trip every field, and a select list that quietly dropped
 * the retired columns would make a save write nulls over data it never loaded.
 */
export const REPORT_COLS =
  'id, client_id, campaign_id, date, created_at, updated_at, ad_spend, impressions, ' +
  'clicks, leads, admissions, projected_impressions, projected_leads, ' +
  'projected_admissions, client_note, updated_by';

/**
 * Every figure a `daily_report` row can carry, in entry-grid order.
 *
 * Only the first two and the last two are still typed by ops — `clicks`,
 * `leads`, `admissions` and `projected_impressions` were retired from the grid
 * but remain here so saves round-trip them instead of writing nulls over
 * history. Anything iterating this list should expect the retired four to be
 * present and unchanging.
 */
export const REPORT_FIELDS = [
  'ad_spend',
  'impressions',
  'clicks',
  'leads',
  'admissions',
  'projected_impressions',
  'projected_leads',
  'projected_admissions',
] as const;

export type ReportField = (typeof REPORT_FIELDS)[number];

export const REPORT_LABELS: Record<ReportField, string> = {
  ad_spend: 'Ad spend',
  impressions: 'Impressions',
  clicks: 'Clicks',
  leads: 'Leads',
  admissions: 'Admissions',
  projected_impressions: 'Projected impressions',
  projected_leads: 'Projected leads',
  projected_admissions: 'Projected admissions',
};

export interface DailyReportNote {
  metric_id: string;
  updated_at: string;
  updated_by: string | null;
  note: string | null;
}

/**
 * Adovia's own measured figures for a day, in a table no client can read.
 *
 * `daily_report` is what Adovia states; this is what Adovia measured. Keeping
 * both means a difference between them is a recorded fact someone can look at,
 * rather than an argument nobody can settle after the event.
 *
 * Spend used to be here too and is not any more. The number ops types is the
 * one that goes to the client, so a private second copy of it recorded nothing
 * but agreement with itself; `daily_report.ad_spend` is now the only spend
 * figure in the product. Note also that no screen currently compares this table
 * against `daily_report` — the Variance view that did was removed — so these
 * are a private record rather than a check on anything.
 */
export interface DailyActuals {
  id: string;
  client_id: string;
  /** Same grain and same null meaning as `DailyReport.campaign_id`. */
  campaign_id: string | null;
  date: string;
  impressions: number | null;
  leads: number | null;
  admissions: number | null;

  /**
   * Why the measurement reads the way it does — "platform under-reported until
   * 14:00", "spend spiked, client asked why".
   *
   * The counterpart to `daily_report.client_note`, and the opposite audience.
   * That one is a column on a client-readable table and so is a publication;
   * this one is a column on a table whose only RLS policy is `is_admin()`, and
   * so is private by the same rule that hides the figures beside it. It is
   * deliberately not modelled on `daily_report_notes` — that table exists solely
   * because a private column on a client-readable table is impossible, which is
   * not the situation here.
   */
  note: string | null;

  updated_at: string;
  updated_by: string | null;
}

/**
 * The three internal figures, ordered as they appear in the actuals grid.
 *
 * Figures only — `note` is deliberately absent. Every consumer of this list puts
 * the field through `parseFigure`/`toInput`, so a text field joining it would be
 * parsed as a number and saved as null.
 */
export const ACTUAL_FIELDS = ['impressions', 'leads', 'admissions'] as const;

export type ActualField = (typeof ACTUAL_FIELDS)[number];

/** Short forms for the entry grid and the recent-days table. */
export const ACTUAL_SHORT: Record<ActualField, string> = {
  impressions: 'Impr.',
  leads: 'Leads',
  admissions: 'Adm.',
};

export interface DailyReportHistoryRow {
  id: number;
  metric_id: string;
  client_id: string;
  /** Which campaign the changed figure belonged to; null for unattributed rows. */
  campaign_id: string | null;
  date: string;
  changed_at: string;
  changed_by: string | null;
  ad_spend: number | null;
  impressions: number | null;
  clicks: number | null;
  leads: number | null;
  admissions: number | null;
  projected_impressions: number | null;
  projected_leads: number | null;
  projected_admissions: number | null;
  client_note: string | null;
}

export interface Invoice {
  id: string;
  client_id: string;
  created_at: string;
  number: string;
  period_start: string;
  period_end: string;
  amount: number | null;
  currency: string;
  status: InvoiceStatus;
  storage_path: string;
  uploaded_by: string | null;
}

/**
 * The one table a client writes to. Creatives are supplied *by* the client —
 * artwork Adovia is meant to run — so `uploaded_by` is usually a client user,
 * not an admin, and the admin side reads these grouped by client.
 */
export interface Creative {
  id: string;
  client_id: string;
  created_at: string;
  title: string;
  note: string | null;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string | null;
}
