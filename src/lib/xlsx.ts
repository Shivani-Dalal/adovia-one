/**
 * Reading a .xlsx workbook in the browser, without a dependency.
 *
 * WHY THIS IS HAND-WRITTEN, given that SheetJS exists and does it better.
 * The npm package `xlsx` is pinned at 0.18.5 and carries two published
 * advisories — prototype pollution (fixed in 0.19.3) and a ReDoS (fixed in
 * 0.20.2) — neither of which is on npm, because SheetJS moved distribution to
 * their own CDN and never published the fixes there. Taking it means shipping
 * known-vulnerable parsing code, in the one part of this app that reads a file
 * somebody hands it. `exceljs` is the maintained alternative and unpacks to
 * 21 MB, which would be five times the rest of this application put together.
 *
 * So the third option: read the subset we actually need. A .xlsx is a zip of
 * XML, the shapes involved are machine-generated and stable, and what this
 * product wants from a spreadsheet is cell text. That is a few hundred lines we
 * own and can test, rather than a megabyte we can't patch.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No formula evaluation — a formula cell is
 * read from the value Excel cached beside it, which is what the file was
 * showing its author when they saved. No .xls (the pre-2007 binary format; a
 * different problem entirely), no .xlsb, no encrypted workbooks. Each of those
 * fails with a sentence naming itself, because "Save As .xlsx" is a ten-second
 * fix and a generic parse error would not suggest it.
 *
 * Everything comes back as text, including numbers. The caller puts every cell
 * through `parseFigure` anyway, and handing it a pre-parsed float would mean
 * two different number parsers deciding what a cell means. Dates are the one
 * exception and have to be: see `serialToISO`.
 */

/** One worksheet: its tab name, and its cells as a rectangle of text. */
export interface Grid {
  name: string;
  /** Row-major, sparse cells filled with ''. Ragged rows are padded by `readXlsx`. */
  cells: string[][];
}

/** Thrown for a file we can read the shape of but not the contents. */
export class SheetFormatError extends Error {}

/* ------------------------------------------------------------------ zip --- */

/**
 * The zip container, read from its central directory rather than by walking
 * local headers front to back.
 *
 * The local header is allowed to carry zeroes for the compressed and
 * uncompressed sizes and defer the real values to a data descriptor after the
 * payload — which is what a writer that streams its output does, and Excel
 * itself does it for large sheets. The central directory is always correct, so
 * reading from there is the difference between working on small files and
 * working on the ones that matter.
 */
function readZip(buf: ArrayBuffer): Map<string, { method: number; start: number; size: number }> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // The end-of-central-directory record is last, but a zip comment may follow
  // it, so scan backwards for the signature. The comment is length-prefixed to
  // 16 bits, so it cannot be further than 64 KB from the end.
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 0x10000 - 22);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SheetFormatError('not-a-zip');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);

  // 0xFFFFFFFF in the size or offset fields is zip64's escape hatch, and the
  // real values then live in an extra field we do not read. A spreadsheet has
  // to be enormous to reach it, so this reports rather than guesses.
  if (p === 0xffffffff || count === 0xffff) throw new SheetFormatError('zip64');

  const out = new Map<string, { method: number; start: number; size: number }>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new SheetFormatError('not-a-zip');
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localAt = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    if (size === 0xffffffff || localAt === 0xffffffff) throw new SheetFormatError('zip64');

    // The local header's own name and extra lengths, not the central
    // directory's — they are allowed to differ, and the payload starts after
    // whatever the LOCAL header says.
    const lNameLen = view.getUint16(localAt + 26, true);
    const lExtraLen = view.getUint16(localAt + 28, true);
    out.set(name, { method, start: localAt + 30 + lNameLen + lExtraLen, size });

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflate(bytes: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return bytes;
  if (method !== 8) throw new SheetFormatError('compression');
  // Copied out of the zip rather than passed as a view over it. `subarray`
  // returns a window onto the whole file's buffer, which Blob is within its
  // rights to treat as shared memory and refuse; a copy of one entry is a few
  // kilobytes and removes the question.
  const copy = new Uint8Array(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ------------------------------------------------------------------ xml --- */

/**
 * A scanner rather than DOMParser, for one reason: the tests run in Node, which
 * has no DOMParser, and a parser that is only exercised through a shim is a
 * parser whose real code path is untested. The documents here are generated by
 * spreadsheet software to a fixed schema — no CDATA, no doctype, no element
 * nested inside another of its own name — which is the narrow case a scanner
 * handles safely.
 */
function elements(xml: string, name: string): { attrs: string; inner: string }[] {
  const out: { attrs: string; inner: string }[] = [];
  const open = `<${name}`;
  const close = `</${name}>`;
  let i = 0;
  for (;;) {
    const at = xml.indexOf(open, i);
    if (at < 0) return out;
    const after = xml[at + open.length];
    // `<c` must not also match `<cols`. A real tag is followed by whitespace,
    // the end of the tag, or the slash of a self-closing one.
    if (after !== ' ' && after !== '>' && after !== '/' && after !== '\t' && after !== '\n') {
      i = at + open.length;
      continue;
    }
    const gt = xml.indexOf('>', at);
    if (gt < 0) return out;
    const attrs = xml.slice(at + open.length, xml[gt - 1] === '/' ? gt - 1 : gt);
    if (xml[gt - 1] === '/') {
      out.push({ attrs, inner: '' });
      i = gt + 1;
      continue;
    }
    const end = xml.indexOf(close, gt);
    if (end < 0) {
      out.push({ attrs, inner: '' });
      return out;
    }
    out.push({ attrs, inner: xml.slice(gt + 1, end) });
    i = end + close.length;
  }
}

function attr(attrs: string, name: string): string | undefined {
  // Both quote styles, because the spec permits either and writers use both.
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? decode(m[2] ?? m[3] ?? '') : undefined;
}

function decode(s: string): string {
  if (!s.includes('&') && !s.includes('_x')) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    // Excel writes control characters — most often the newline from Alt+Enter
    // inside a cell — as _x000D_. Left alone they show up literally in a
    // campaign name, which then fails to match the campaign it names.
    .replace(/_x([0-9A-Fa-f]{4})_/g, (whole, h) =>
      h.toUpperCase() === '005F' ? whole : String.fromCodePoint(parseInt(h, 16)),
    );
}

/** The text of an `<si>` or `<is>`, with rich-text runs joined back together. */
function stringOf(inner: string): string {
  // Phonetic guides (`<rPh>`) are a parallel reading of the same text, not part
  // of it, so they are cut before the `<t>` elements are collected.
  const body = inner.replace(/<rPh[\s\S]*?<\/rPh>/g, '');
  return elements(body, 't')
    .map((t) => decode(t.inner))
    .join('');
}

/* ---------------------------------------------------------------- dates --- */

/**
 * An Excel date is a number with a costume on. The cell holds a serial day
 * count; whether it means a date lives in the format applied to it, in a
 * different part of the file. So the styles table has to be read, or every date
 * column arrives as five-digit integers.
 *
 * Getting this wrong is not a display problem. A date column read as numbers is
 * a column of rows that match no calendar day, and the import would either
 * refuse the file wholesale or — worse — silently attach figures to nothing.
 */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function isDateFormat(code: string): boolean {
  // Strip the parts of a format string that can contain letters without
  // meaning them as date tokens: quoted literals, escaped characters, and the
  // bracketed colour/locale/condition blocks like [Red] or [$₹-4009].
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '');
  return /[ymdhs]/i.test(bare);
}

/**
 * Serial day to 'YYYY-MM-DD'.
 *
 * The 1900 workbook counts from 1900-01-01 = 1 and then deliberately reproduces
 * a fifty-year-old Lotus bug: it believes 1900 was a leap year, so serial 60 is
 * a 29th of February that never happened and everything after it is shifted by
 * a day. The two branches below are that shift. Every date this product deals
 * with is far past it — 2026 is serial 46000-odd — but a file can carry an
 * older row, and a silent one-day error in a date is the kind of thing nobody
 * finds until a client asks why Tuesday's spend is on Monday.
 */
export function serialToISO(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  const days = Math.floor(serial);

  if (date1904) return fromEpoch(Date.UTC(1904, 0, 1) + days * 86400000);
  if (days === 60) return null; // 1900-02-29. Never existed; refuse to invent it.
  const base = days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  return fromEpoch(base + days * 86400000);
}

function fromEpoch(ms: number): string | null {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ ref --- */

/**
 * 'AB12' to a zero-based column index.
 *
 * Cells are addressed, not ordered: a row that skips column C simply has no
 * `<c>` for it, and a reader that pushed cells onto the end of an array would
 * shift every figure one column left from the first blank onwards. That is a
 * silent corruption — the numbers are all real, they are just under the wrong
 * headings — so placement is by address throughout.
 */
export function columnIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/* ------------------------------------------------------------- workbook --- */

export async function readXlsx(buf: ArrayBuffer): Promise<Grid[]> {
  const zip = readZip(buf);
  const bytes = new Uint8Array(buf);

  async function text(path: string): Promise<string | null> {
    const e = zip.get(path);
    if (!e) return null;
    const raw = bytes.subarray(e.start, e.start + e.size);
    return new TextDecoder().decode(await inflate(raw, e.method));
  }

  const workbook = await text('xl/workbook.xml');
  if (workbook === null) {
    // A zip that is not a workbook. The likely culprits are the two other
    // things people call an Excel file, so name them rather than saying the
    // archive lacked an entry.
    throw new SheetFormatError(zip.has('[Content_Types].xml') ? 'not-a-workbook' : 'not-a-zip');
  }

  const date1904 = /date1904\s*=\s*["'](1|true)["']/.test(workbook);

  // Shared strings: the string table nearly every text cell points into rather
  // than carrying its own copy.
  const sst = await text('xl/sharedStrings.xml');
  const shared = sst === null ? [] : elements(sst, 'si').map((si) => stringOf(si.inner));

  // Styles, read only for the question "is this cell a date?".
  const styles = await text('xl/styles.xml');
  const dateStyles = new Set<number>();
  if (styles) {
    const custom = new Map<number, string>();
    for (const f of elements(styles, 'numFmt')) {
      const id = Number(attr(f.attrs, 'numFmtId'));
      const code = attr(f.attrs, 'formatCode');
      if (Number.isFinite(id) && code !== undefined) custom.set(id, code);
    }
    // Only the cellXfs block — cellStyleXfs is the named-style table beneath it
    // and is indexed separately, so pooling the two would misalign every index.
    const xfs = elements(styles, 'cellXfs')[0];
    if (xfs) {
      elements(xfs.inner, 'xf').forEach((xf, i) => {
        const id = Number(attr(xf.attrs, 'numFmtId') ?? '0');
        const code = custom.get(id);
        if (BUILTIN_DATE_FORMATS.has(id) || (code !== undefined && isDateFormat(code))) {
          dateStyles.add(i);
        }
      });
    }
  }

  // Sheet tab names live in workbook.xml and point at files by relationship id,
  // which only the .rels file can resolve. Falling back to sheet order would
  // work until somebody reordered their tabs.
  const rels = (await text('xl/_rels/workbook.xml.rels')) ?? '';
  const targets = new Map<string, string>();
  for (const r of elements(rels, 'Relationship')) {
    const id = attr(r.attrs, 'Id');
    const target = attr(r.attrs, 'Target');
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\.\//, ''));
  }

  const grids: Grid[] = [];
  const sheets = elements(workbook, 'sheet');
  for (let i = 0; i < sheets.length; i++) {
    const name = attr(sheets[i].attrs, 'name') ?? `Sheet ${i + 1}`;
    const rid = attr(sheets[i].attrs, 'r:id') ?? attr(sheets[i].attrs, 'id');
    const target = (rid && targets.get(rid)) || `worksheets/sheet${i + 1}.xml`;
    const xml = await text(`xl/${target}`);
    if (xml === null) continue;
    grids.push({ name, cells: readSheet(xml, shared, dateStyles, date1904) });
  }
  return grids;
}

function readSheet(
  xml: string,
  shared: string[],
  dateStyles: Set<number>,
  date1904: boolean,
): string[][] {
  const rows: string[][] = [];
  let width = 0;

  for (const row of elements(xml, 'row')) {
    // `r` is the row's own 1-based number. Trusting document order instead
    // would collapse the gap left by a deleted or never-used row, and every
    // date below it would shift up a line.
    const at = Number(attr(row.attrs, 'r') ?? '0');
    const cells: string[] = [];

    for (const c of elements(row.inner, 'c')) {
      const ref = attr(c.attrs, 'r');
      const col = ref ? columnIndex(ref) : cells.length;
      if (col < 0) continue;

      const type = attr(c.attrs, 't') ?? 'n';
      let value = '';

      if (type === 'inlineStr') {
        value = stringOf(c.inner);
      } else {
        const v = elements(c.inner, 'v')[0];
        const raw = v ? decode(v.inner) : '';
        if (raw === '') {
          value = '';
        } else if (type === 's') {
          value = shared[Number(raw)] ?? '';
        } else if (type === 'e') {
          // #DIV/0! and friends. Kept as the text Excel shows rather than
          // blanked, so the preview can point at the cell and say what is in
          // it — a blank would look like a cell nobody filled in.
          value = raw;
        } else if (type === 'b') {
          value = raw === '1' ? 'TRUE' : 'FALSE';
        } else if (type === 'str') {
          value = raw;
        } else {
          const style = Number(attr(c.attrs, 's') ?? '-1');
          const n = Number(raw);
          value =
            dateStyles.has(style) && Number.isFinite(n)
              ? (serialToISO(n, date1904) ?? raw)
              : raw;
        }
      }

      while (cells.length < col) cells.push('');
      cells[col] = value;
    }

    const index = at > 0 ? at - 1 : rows.length;
    while (rows.length < index) rows.push([]);
    rows[index] = cells;
    width = Math.max(width, cells.length);
  }

  // Padded to a rectangle. Everything downstream indexes by column number, and
  // a ragged row would make a missing trailing cell an `undefined` rather than
  // the empty cell it is.
  for (const r of rows) while (r.length < width) r.push('');
  return rows;
}
