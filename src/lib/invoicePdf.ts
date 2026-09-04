/**
 * Reading the invoice number, date and amount off the PDF being uploaded.
 *
 * WHY THIS IS ADVISORY, ALWAYS
 * ----------------------------
 * Everything here is a guess about somebody else's layout. It fills the form in
 * and says where each value came from; it never saves anything on its own, and
 * every field stays editable. A parser that silently wins is worse than no
 * parser, because the one case that matters — it read the wrong number — looks
 * exactly like the case where it worked.
 *
 * WHAT IT WAS BUILT AGAINST
 * -------------------------
 * The SG Business Solutions tax invoice, which is the only format Adovia
 * issues. Its shape, and the two things about it that break naive parsing:
 *
 *   1. The header is THREE COLUMNS on the same baseline. "Invoice No", "RO No"
 *      and "Payment Terms" all sit at y=715. Joining that line by x order and
 *      regexing for the value after "Invoice No :" runs straight on into
 *      "RO No : Mail Confirmation" and captures rubbish. `layoutLines` splits
 *      on the horizontal gap between columns, which is ~80pt against ~5pt
 *      inside a column, so the separator is unambiguous.
 *
 *   2. pdf.js hands the number back one glyph at a time — "SGB/", "2", "6",
 *      "-", "2", "7", "/", "0"… — because the font is subsetted. So nothing can
 *      match against a single text item; the line has to be rebuilt first.
 *
 * A PDF with no text layer at all — a scan, or a design exported as outlines —
 * yields nothing here and the form simply stays empty. That is a real case:
 * the placeholder that was uploaded as ADV-001 is a flattened letterhead with
 * seven lines of contact details and no invoice in it.
 */

/** One field we tried to read, and where we got it. */
export interface Read<T> {
  value: T;
  /** The literal text this came from, so the form can show its working. */
  source: string;
  /** The label that matched — "Billing Amount" reads differently to "Total". */
  label: string;
}

export interface ExtractedInvoice {
  number: Read<string> | null;
  issueDate: Read<string> | null;
  amount: Read<number> | null;
  /**
   * True when the PDF carried no usable text at all, as opposed to carrying
   * text we could not find these fields in. The distinction is the difference
   * between "this is a scan" and "this is a layout I do not know", and the two
   * need different sentences on screen.
   */
  empty: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Layout                                                                     */
/* -------------------------------------------------------------------------- */

/** The bit of a pdf.js text item this file cares about. */
interface Item {
  str: string;
  x: number;
  y: number;
  width: number;
}

/**
 * Horizontal gap, in PDF points, that separates two columns rather than two
 * words. Word spaces in this document run under 5pt and the column gutters run
 * over 80pt, so anything in the middle is safe; 18 is deliberately nearer the
 * words than the gutters, because splitting one line too eagerly costs a missed
 * field while splitting too late costs a wrong one.
 */
const COLUMN_GAP = 18;

/** Vertical tolerance for "same line" — superscripts sit a few points off. */
const LINE_TOLERANCE = 2;

export const COLUMN_SEPARATOR = ' │ ';

/**
 * Rebuilds visual lines from positioned text items, marking column breaks.
 *
 * Exported for the test harness, which runs it over the real invoice.
 */
export function layoutLines(items: Item[]): string[] {
  // Empty strings only. pdf.js emits a zero-width `''` item as an end-of-line
  // marker, which is noise, but it also emits real single-space items — and
  // those are load-bearing. The space between "July" and "2" arrives as its own
  // item, so filtering on `.trim()` here silently welds the date into "July2"
  // and every date on every invoice stops parsing.
  const kept = items.filter((it) => it.str !== '');
  if (kept.length === 0) return [];

  // Bucket by baseline. Items arrive grouped by column, not top-to-bottom, so
  // this cannot assume input order.
  const rows: { y: number; items: Item[] }[] = [];
  for (const it of [...kept].sort((a, b) => b.y - a.y)) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= LINE_TOLERANCE);
    if (row) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }

  return rows.map(({ items: line }) => {
    const sorted = [...line].sort((a, b) => a.x - b.x);
    let out = '';
    let cursor = -Infinity;
    for (const it of sorted) {
      if (cursor !== -Infinity) out += it.x - cursor > COLUMN_GAP ? COLUMN_SEPARATOR : '';
      out += it.str;
      cursor = it.x + it.width;
    }
    // Collapse the runs of single spaces pdf.js emits between glyph fragments.
    return out.replace(/[ \t]+/g, ' ').trim();
  });
}

/* -------------------------------------------------------------------------- */
/*  Field parsing                                                              */
/* -------------------------------------------------------------------------- */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * A date as printed on an invoice, to `yyyy-mm-dd`.
 *
 * Numeric dates are read DAY FIRST. This is an Indian invoice and 02/07/2026
 * means the second of July; reading it American-style would file the invoice
 * seven months out and look entirely plausible while doing it. Anything with
 * a first number over 12 is unambiguous anyway, and a four-digit first number
 * is treated as ISO.
 */
export function parseInvoiceDate(raw: string): string | null {
  const s = raw.trim();

  // ISO: 2026-07-02
  const iso = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return ymd(+iso[1], +iso[2], +iso[3]);

  // "July 2, 2026" / "Jul 2 2026"
  const monthFirst = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (monthFirst) {
    const m = MONTHS[monthFirst[1].slice(0, 3).toLowerCase()];
    if (m) return ymd(+monthFirst[3], m, +monthFirst[2]);
  }

  // "2 July 2026" / "02-Jul-2026"
  const dayFirst = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(\d{4})\b/);
  if (dayFirst) {
    const m = MONTHS[dayFirst[2].slice(0, 3).toLowerCase()];
    if (m) return ymd(+dayFirst[3], m, +dayFirst[1]);
  }

  // 02/07/2026 or 02-07-2026, day first.
  const numeric = s.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (numeric) {
    const year = +numeric[3];
    return ymd(year < 100 ? 2000 + year : year, +numeric[2], +numeric[1]);
  }

  return null;
}

function ymd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejects the 31st of a 30-day month rather than rolling it into the next.
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y.toString().padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * "1,18,000" or "1,18,000.00" to 118000. Indian digit grouping, so the comma
 * positions are not every three and cannot be validated as if they were.
 */
export function parseAmount(raw: string): number | null {
  const m = raw.match(/(\d[\d,]*(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Amount labels, best first.
 *
 * `Billing Amount` wins over `Total Amount` deliberately, and the difference is
 * not cosmetic: on the invoice this was built against, Total Amount is 1,00,000
 * and Billing Amount is 1,18,000 — the same invoice before and after 18% IGST.
 * The portal shows the client what they owe, which is the figure with the tax
 * in it. Taking the first "total" off the page would understate every invoice
 * in the system by the GST.
 */
const AMOUNT_LABELS = [
  'Billing Amount',
  'Amount Payable',
  'Grand Total',
  'Invoice Total',
  'Total Amount',
  'Total',
];

const NUMBER_LABELS = ['Invoice No', 'Invoice Number', 'Invoice #', 'Bill No'];
const DATE_LABELS = ['Invoice Date', 'Bill Date', 'Date of Invoice', 'Dated'];

/**
 * Everything on `line` that follows `label`, stopping at a column break.
 *
 * The column stop is what keeps "Invoice No : SGB/26-27/0007" from swallowing
 * the "RO No" sitting beside it on the same baseline.
 */
function after(line: string, label: string): string | null {
  const i = line.toLowerCase().indexOf(label.toLowerCase());
  if (i === -1) return null;
  const rest = line.slice(i + label.length).split(COLUMN_SEPARATOR)[0];
  return rest.replace(/^[\s:.–—-]+/, '').trim() || null;
}

export function parseInvoiceText(lines: string[]): ExtractedInvoice {
  const empty = lines.length === 0;
  const result: ExtractedInvoice = { number: null, issueDate: null, amount: null, empty };

  for (const label of NUMBER_LABELS) {
    if (result.number) break;
    for (const line of lines) {
      const rest = after(line, label);
      // First whitespace-delimited token. Invoice numbers do not contain
      // spaces, and stopping at one keeps a trailing "RO No" out even in a
      // layout where the column gap was too small to detect.
      const token = rest?.split(/\s+/)[0];
      if (token && /[A-Za-z0-9]/.test(token)) {
        result.number = { value: token, source: rest!, label };
        break;
      }
    }
  }

  for (const label of DATE_LABELS) {
    if (result.issueDate) break;
    for (const line of lines) {
      const rest = after(line, label);
      if (!rest) continue;
      const parsed = parseInvoiceDate(rest);
      if (parsed) {
        result.issueDate = { value: parsed, source: rest, label };
        break;
      }
    }
  }

  for (const label of AMOUNT_LABELS) {
    if (result.amount) break;
    for (const line of lines) {
      const rest = after(line, label);
      if (!rest) continue;
      const parsed = parseAmount(rest);
      if (parsed !== null) {
        result.amount = { value: parsed, source: rest, label };
        break;
      }
    }
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/*  Loading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Reads the fields off a PDF in the browser.
 *
 * pdf.js is imported dynamically and only when a file is picked. It is roughly
 * a megabyte of parser and worker, and putting it in the entry bundle would
 * make every client's dashboard pay for a screen only admins open.
 *
 * Never throws. An unreadable PDF is an empty result, not an error: the upload
 * form works perfectly well with nothing filled in, and a red alert over a
 * convenience that failed would suggest the upload itself is in trouble.
 */
export async function readInvoicePdf(file: File): Promise<ExtractedInvoice> {
  try {
    const pdfjs = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

    const doc = await pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      // No network fetches for fonts or CMaps while parsing an upload.
      isEvalSupported: false,
    }).promise;

    const lines: string[] = [];
    // Only the first two pages. The fields are always in the header, and the
    // annexes on a long invoice are line items we do not want to match against.
    const pages = Math.min(doc.numPages, 2);
    for (let i = 1; i <= pages; i++) {
      const content = await doc.getPage(i).then((p) => p.getTextContent());

      // Structural narrowing rather than pdf.js's `TextItem` type, which lives
      // behind a `pdfjs-dist/types/src/display/...` path that is not part of
      // the package's public surface and has moved between minor versions.
      // `items` also carries TextMarkedContent entries, which have no geometry.
      const positioned: Item[] = [];
      for (const raw of content.items) {
        const it = raw as { str?: string; transform?: number[]; width?: number };
        if (typeof it.str !== 'string' || !it.transform) continue;
        positioned.push({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          width: it.width ?? 0,
        });
      }
      lines.push(...layoutLines(positioned));
    }
    void doc.destroy();

    return parseInvoiceText(lines);
  } catch {
    return { number: null, issueDate: null, amount: null, empty: true };
  }
}
