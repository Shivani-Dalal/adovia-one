/**
 * CSV export, shared by the client's spend report and the admin's actuals
 * report.
 *
 * Small enough to have been copied a second time, which is exactly why it is
 * here instead. The rule that a null becomes an empty cell rather than a `0` is
 * the same promise the screens make with their dashes, and it has to hold in
 * every file this product emits — a second copy is a second place for it to
 * drift, and the drift would be silent.
 */

/** Quote only when we must, so the common case stays readable in a text editor. */
function cell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * A null becomes an empty cell, never a 0. A spreadsheet that turns "not
 * entered" into zero would average and chart it, and the reader would be
 * reasoning about spend nobody ever claimed.
 */
export function num(v: number | null | undefined): string {
  return typeof v === 'number' ? String(v) : '';
}

/** Rows of already-stringified cells into a CRLF-delimited sheet. */
export function toCsvText(rows: string[][]): string {
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

/**
 * A name, made safe to put in a filename.
 *
 * Downloads land in one folder beside each other, so two exports of the same
 * month for different campaigns would both be "adovia-spend-2026-08.csv" and
 * the second would silently become "(1)". Naming the campaign in the file is
 * the difference between an attachment that can be forwarded as it is and one
 * that has to be explained in the covering mail.
 */
export function fileSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'campaign'
  );
}

export function download(csv: string, filename: string) {
  // The BOM is what makes Excel read the file as UTF-8 on open. Without it
  // Excel guesses the local codepage and mangles any non-ASCII text.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
