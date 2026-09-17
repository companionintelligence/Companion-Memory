/* Disney "Data Subject Access Request" report — recovery of the TITLES
   WATCHED table from pdftotext's `-tsv` rendering of the PDF.

   The report is an Excel workbook printed to PDF (one sheet per business
   unit: a profile sheet, "DISNEY+/ESPN+ DATA OUTPUT", parks, cruises, the
   store, …) and Disney ships nothing machine-readable beside it. The only
   table worth having is the streaming one:

     Date            Service   Profile   Program                 Season
     30 May, 2026    disney    Liam      This Little Wiggy       The Simpsons
                                         The Rescuers Down
     16 May, 2026    disney    Liam      Under
                                                                 Star Wars: Tales of the
     10 Jul, 2025    disney    Liam      Episode 2               Underworld

   - "Season" is Disney's name for the column; it holds the series
     ("Wonder Man"), the series and season ("Andor Season 2"), or nothing for
     a film. Films and specials have no series at all.
   - Cells are bottom-aligned, as Excel's are: a Program or Season that
     wrapped puts its earlier lines ABOVE the line that carries the date, so
     a row is "every dateless line since the previous row, then the dated
     line". Rows are not separated by blank space.
   - The header is printed once. Later pages repeat neither it nor the
     column widths in any way `-layout` text preserves: the character grid
     pdftotext lays the page on drifts by up to five cells within one page,
     and a Program that fills its column is separated from its Season by ONE
     space, which no whitespace rule can tell from a space inside a title.
     Word positions in points (`-tsv`) have neither problem — the Season
     column starts at the same x on every page, to a hundredth of a point —
     so the table is read from those, and the header's word positions are
     the column boundaries.

   Everything here is a pure function of the text so the parser is testable
   without poppler; `disney_plus.ts` owns the pdftotext call and the pipeline
   items. */

import { joinWrapped } from './_hulu_report';

export interface DisneyTable {
  /** Header names as printed: Date, Service, Profile, Program, Season. */
  columns: string[];
  rows: Record<string, string>[];
}

export interface DisneyReport {
  /** The "TITLES WATCHED" table; empty with no columns when the heading was not found. */
  titlesWatched: DisneyTable;
}

/** One word of `pdftotext -tsv` output, positioned in points from the page's top-left. */
export interface TsvWord {
  page: number;
  left: number;
  top: number;
  width: number;
  text: string;
}

/** A visual line: the words that share a baseline on one page, left to right. */
export interface TsvLine {
  page: number;
  top: number;
  words: TsvWord[];
}

/** Words on one visual line sit within this many points of each other's top. */
const LINE_TOLERANCE_PT = 2;

/** A cell starts at its column's left edge; allow this much glyph rounding. */
const COLUMN_TOLERANCE_PT = 2;

const TITLE_RE = /^titles watched$/i;

/** `30 May, 2026`, also `30 May 2026` and a full month name — the Date cell of a row. */
const DATE_RE = /^\d{1,2} [A-Za-z]{3,9}\.?,? \d{4}$/;

/**
 * Read the word rows out of the TSV. Level 5 rows are words; levels 1–4 are
 * page/flow/block/line markers whose text is `###PAGE###` and friends.
 */
export function parseTsvWords(tsv: string): TsvWord[] {
  const lines = tsv.split(/\r?\n/);
  const header = (lines[0] ?? '').split('\t');
  const col = (name: string): number => header.indexOf(name);
  const iLevel = col('level');
  const iPage = col('page_num');
  const iLeft = col('left');
  const iTop = col('top');
  const iWidth = col('width');
  const iText = col('text');
  if ([iLevel, iPage, iLeft, iTop, iWidth, iText].some((i) => i < 0)) {
    return [];
  }

  const words: TsvWord[] = [];
  for (const line of lines.slice(1)) {
    if (!line) {
      continue;
    }

    const f = line.split('\t');
    if (f[iLevel] !== '5') {
      continue;
    }

    const text = (f[iText] ?? '').trim();
    if (!text) {
      continue;
    }

    words.push({
      page: Number(f[iPage]),
      left: Number(f[iLeft]),
      top: Number(f[iTop]),
      width: Number(f[iWidth]),
      text,
    });
  }

  return words;
}

/** Group words into visual lines: same page, tops within tolerance; reading order. */
export function linesOf(words: TsvWord[]): TsvLine[] {
  const sorted = [...words].sort((a, b) => a.page - b.page || a.top - b.top || a.left - b.left);
  const lines: TsvLine[] = [];
  let current: TsvLine | undefined;
  for (const w of sorted) {
    if (current && current.page === w.page && Math.abs(current.top - w.top) <= LINE_TOLERANCE_PT) {
      current.words.push(w);
      continue;
    }

    current = { page: w.page, top: w.top, words: [w] };
    lines.push(current);
  }

  for (const line of lines) {
    line.words.sort((a, b) => a.left - b.left);
  }

  return lines;
}

function lineText(line: TsvLine): string {
  return line.words.map((w) => w.text).join(' ');
}

/** The rightmost column whose left edge is at or left of the word. */
function columnAt(starts: number[], left: number): number {
  let col = 0;
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i] <= left + COLUMN_TOLERANCE_PT) {
      col = i;
    }
  }

  return col;
}

/** Words of one line folded into per-column cell text. */
function cellsOf(line: TsvLine, columns: string[], starts: number[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of line.words) {
    const column = columns[columnAt(starts, w.left)];
    out[column] = out[column] ? `${out[column]} ${w.text}` : w.text;
  }

  return out;
}

/**
 * A row's lines (wrapped fragments first, the dated line last) folded onto
 * one record. Every column here is a title, so fragments re-join at a space
 * unless a hyphen or a number's colon shows the break was mid-token.
 */
function foldRow(lines: Record<string, string>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cells of lines) {
    for (const [column, text] of Object.entries(cells)) {
      out[column] = out[column] ? joinWrapped(out[column], text, 'prose') : text;
    }
  }

  return out;
}

function isHeader(line: TsvLine, columns: string[]): boolean {
  return (
    columns.length > 0 &&
    line.words.length === columns.length &&
    line.words.every((w, i) => w.text.toLowerCase() === columns[i].toLowerCase())
  );
}

/**
 * Parse the whole report. Only the titles table is read: the walker skips to
 * the "TITLES WATCHED" line, takes the next line as the header, and reads
 * rows until a line that starts in the Date column with something other
 * than a date — the next sheet's heading ("DISNEY PARKS & RESORTS DATA
 * OUTPUT"). Page breaks carry no meaning; a page may start mid-row.
 */
export function parseDisneyReport(tsv: string): DisneyReport {
  const table: DisneyTable = { columns: [], rows: [] };
  let starts: number[] = [];
  let state: 'before' | 'header' | 'table' = 'before';
  let pending: Record<string, string>[] = [];

  for (const line of linesOf(parseTsvWords(tsv))) {
    if (state === 'before') {
      if (TITLE_RE.test(lineText(line))) {
        state = 'header';
      }

      continue;
    }

    if (state === 'header') {
      table.columns = line.words.map((w) => w.text);
      starts = line.words.map((w) => w.left);
      state = 'table';
      continue;
    }

    // A later page that does repeat the header: take its offsets, drop the words.
    if (isHeader(line, table.columns)) {
      starts = line.words.map((w) => w.left);
      continue;
    }

    const cells = cellsOf(line, table.columns, starts);
    const first = cells[table.columns[0]];
    if (first == null) {
      // No Date: the wrapped part of a cell, above the dated line it belongs to.
      pending.push(cells);
      continue;
    }

    if (!DATE_RE.test(first)) {
      // Something else in the Date column: the next sheet's heading.
      break;
    }

    table.rows.push(foldRow([...pending, cells]));
    pending = [];
  }

  return { titlesWatched: table };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The Date cell, `30 May, 2026`, as midnight UTC. The sheet's note says "All
 * times are in UTC", and the day is all it prints.
 */
export function parseDisneyDate(s: string | undefined): Date | undefined {
  if (!s) {
    return undefined;
  }

  const m = /^(\d{1,2}) ([A-Za-z]{3})[A-Za-z]*\.?,? (\d{4})$/.exec(s.trim());
  if (!m) {
    return undefined;
  }

  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month === -1) {
    return undefined;
  }

  const d = new Date(Date.UTC(Number(m[3]), month, Number(m[1])));

  return isNaN(d.getTime()) ? undefined : d;
}

/**
 * Disney's "Season" cell: the series, optionally followed by its season —
 * `Andor Season 2` → Andor, 2; `Wonder Man` → Wonder Man; blank for a film.
 * The number is taken as printed: one real report says `Star Wars: Andor
 * Season 13`.
 */
export function splitSeasonCell(cell: string | undefined): { series: string; season: string } {
  const t = (cell ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(.*\S)\s+Season\s+(\d+)$/i.exec(t);
  if (m) {
    return { series: m[1], season: m[2] };
  }

  return { series: t, season: '' };
}
