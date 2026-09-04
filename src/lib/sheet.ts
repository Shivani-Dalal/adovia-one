/**
 * The one door a spreadsheet comes in through.
 *
 * Two formats arrive here — .xlsx and CSV — and both leave as the same thing: a
 * named grid of text. Everything downstream, from column mapping to the preview
 * table, is written against that one shape and never learns which format it
 * came from. The alternative is two import paths that agree today, and the day
 * they stop agreeing a client's figures depend on which button ops pressed.
 *
 * Text, not values. Numbers stay as the characters that were in the cell and go
 * through `parseFigure` at the same place typed cells do, so a figure imported
 * from a sheet and a figure typed into the grid are parsed by the same code.
 * Dates are the exception — `xlsx.ts` resolves those, because an Excel date is a
 * serial number that means nothing without the format applied to it.
 */

import { readXlsx, SheetFormatError, type Grid } from './xlsx';

export type { Grid };

/**
 * Above this we stop and say so rather than locking the tab up parsing.
 *
 * A daily-figures sheet for one client-year is a few hundred rows. Something
 * arriving here with fifty thousand is a platform export nobody has trimmed,
 * and the honest response is to say what it looks like rather than to spend
 * ninety seconds finding out.
 */
export const MAX_ROWS = 20000;
const MAX_BYTES = 15 * 1024 * 1024;

/**
 * What ops should do about a file we cannot read, in ops' words.
 *
 * Every branch names the file it thinks it has and the next action. "Failed to
 * parse" tells somebody holding a .xls that the app is broken; "this is the
 * older .xls format, open it and Save As .xlsx" tells them it is a ten-second
 * fix. The distinction matters most for the two cases that look identical from
 * the outside — a real .xls and an encrypted .xlsx are both OLE files.
 */
export function sheetErrorText(e: unknown): string {
  const code = e instanceof SheetFormatError ? e.message : '';
  switch (code) {
    case 'xls':
      return (
        'This is the older .xls format, or a password-protected workbook. Open it in ' +
        'Excel and use File → Save As → Excel Workbook (.xlsx), then try again.'
      );
    case 'not-a-zip':
    case 'not-a-workbook':
      return 'That file is not a spreadsheet this can read. Save it as .xlsx or .csv and try again.';
    case 'zip64':
      return 'That workbook is too large to read here. Export the sheet you need as CSV instead.';
    case 'compression':
      return 'That workbook uses a compression method this cannot read. Re-save it from Excel as .xlsx.';
    case 'empty':
      return 'That file has no sheets in it.';
    case 'too-big':
      return `That file is over ${MAX_BYTES / 1024 / 1024} MB. Export a narrower date range.`;
    case 'too-many-rows':
      return `That sheet has more than ${MAX_ROWS.toLocaleString('en-IN')} rows. Export a narrower date range.`;
    default:
      return e instanceof Error && e.message ? e.message : 'That file could not be read.';
  }
}

/* ------------------------------------------------------------------ csv --- */

/**
 * Which character separates the columns, decided by looking rather than
 * assuming.
 *
 * Excel writes CSV using the list separator of whoever saved it, so the same
 * File → Save As on a machine set to a European locale produces semicolons.
 * That file opened as comma-separated is one column wide, which reads as
 * "your sheet has no columns" — a confusing thing to be told about a file that
 * plainly does. Counting outside quotes is what makes an address field
 * containing a comma not vote for itself.
 */
function sniffDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  let best = ',';
  let bestCount = -1;
  for (const d of [',', ';', '\t', '|']) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < sample.length; i++) {
      const c = sample[i];
      if (c === '"') quoted = !quoted;
      else if (c === d && !quoted) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/**
 * RFC 4180, plus the things real files do.
 *
 * Quoted fields may contain the delimiter, newlines, and doubled quotes.
 * Line endings may be CRLF, LF or bare CR. A trailing newline does not make a
 * final empty row. None of this is clever; all of it is the difference between
 * reading a note that happens to contain a comma and silently splitting a row
 * in half.
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const d = delimiter ?? sniffDelimiter(src);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const c = src[i];

    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"' && field === '') {
      quoted = true;
      i++;
      continue;
    }
    if (c === d) {
      endField();
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      endRow();
      // CRLF is one ending, not two. Missing this puts a blank row between
      // every real one, and the header guess then lands on emptiness.
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c;
    i++;
  }

  // A file ending in a newline has already closed its last row; only flush when
  // there is something genuinely unterminated.
  if (field !== '' || row.length > 0) endRow();

  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of rows) while (r.length < width) r.push('');
  return rows;
}

/* ----------------------------------------------------------------- door --- */

export async function readSheets(file: File): Promise<Grid[]> {
  if (file.size > MAX_BYTES) throw new SheetFormatError('too-big');

  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 8));

  // Sniffed, not trusted to the extension. A file renamed .csv that is really a
  // workbook is common — somebody changed the extension to make it upload
  // somewhere — and parsing zip bytes as text produces a single row of mojibake
  // rather than an error, which is the worst of both.
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const isOle =
    head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;

  if (isOle) throw new SheetFormatError('xls');

  if (isZip) {
    const grids = await readXlsx(buf);
    if (grids.length === 0) throw new SheetFormatError('empty');
    for (const g of grids) if (g.cells.length > MAX_ROWS) throw new SheetFormatError('too-many-rows');
    return grids;
  }

  const text = new TextDecoder('utf-8').decode(buf);
  const cells = parseCsv(text);
  if (cells.length > MAX_ROWS) throw new SheetFormatError('too-many-rows');
  if (cells.length === 0) throw new SheetFormatError('empty');

  // Named for the file, so the sheet picker reads the same way for a CSV as for
  // a workbook rather than showing an unexplained "Sheet 1".
  return [{ name: file.name.replace(/\.[^.]+$/, ''), cells }];
}
