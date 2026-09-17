/* Hulu "Personal Information Report" — structure recovery from pdftotext's
   `-layout` rendering of the PDF.

   The report is a PDF and nothing else: no CSV, no JSON. Poppler's `-layout`
   mode keeps the page geometry as whitespace, and that geometry is regular
   enough to read back as tables:

     Episode Name                  Series Name         Season   Last Played At
                                                                                 <- blank line
     Irrational Treasure [800th    The Simpsons        37       24 Feb 2026 07:14:37
     episode]                                                                    <- wrapped cell
                                                                                 <- blank line
     Krapocracy Now!               Krapopolis          3        24 Feb 2026 07:14:37

   - A row is a run of non-blank lines; rows are separated by a blank line
     (the table's row padding is taller than a line, so poppler emits one).
     A cell that wrapped inside the PDF continues on the row's next line at
     the same column offset.
   - The header row is the first row after the section title, and it repeats
     at the top of every continuation page (form feed), usually with DIFFERENT
     column offsets — the PDF sizes columns per page — so offsets are re-read
     from every header, never carried across a page.
   - Columns are located by the header cells' start offsets. A value starts
     where its header starts (cells are left-aligned), so a cell belongs to the
     rightmost column whose header starts at or before it.

   The other section shapes are a key/value grid (`First Name:   Kyle`), two
   values per line, and a bare one-column list with no header (advertising).

   Everything here is a pure function of the text so the parser is testable
   without poppler; `hulu.ts` owns the pdftotext call and the pipeline items. */

export interface HuluTable {
  /** Header names as printed, wrapped header cells re-joined with a space. */
  columns: string[];
  rows: Record<string, string>[];
}

export interface HuluReport {
  /** "Personal Details": First Name, Last Name, Account Name, Email, Birthdate, Gender, Home Zip. */
  personal: Record<string, string>;
  /** "Subscription Details": Created, Canceled, Status, Add Ons, Plan, Last Charged Date / Amount, … */
  subscription: Record<string, string>;
  /** "Watch History": Episode Name, Series Name, Season, Last Played At. */
  watchHistory: HuluTable;
  /** "Advertising Device IDs": bare list. */
  advertisingDeviceIds: string[];
  /** "Advertising Brands History": bare list of advertiser names. */
  advertisingBrands: string[];
  /** Section titles the walker met that it has no shape for — surfaced to the import log. */
  unknownSections: string[];
}

type TableKey = 'watchHistory';
type KvKey = 'personal' | 'subscription';
type ListKey = 'advertisingDeviceIds' | 'advertisingBrands';

type Section =
  | { shape: 'ignore' }
  | { shape: 'kv'; key: KvKey }
  | { shape: 'table'; key: TableKey }
  | { shape: 'list'; key: ListKey };

/**
 * Section titles as printed, lower-cased. 'ignore' marks what the importer
 * does not read: page-level titles whose following text is prose (the cover
 * blurb) or another title, and the sections that were dropped on purpose —
 * Plan Details, Subscription History, Profiles, Tastes and Onboarding, Cloud
 * DVR and Devices And Logins. Tastes are Hulu's onboarding picks, not
 * anything the household chose (a real report listed 78 titles nobody on the
 * account watches); the plan, billing-change and device tables are internal
 * bookkeeping with timestamps in unstated, mixed timezones. Naming them here
 * keeps their text from being read as rows of whatever table came before.
 */
const SECTIONS: Record<string, Section> = {
  'personal information report': { shape: 'ignore' },
  'personal details': { shape: 'kv', key: 'personal' },
  'payment details': { shape: 'ignore' },
  'subscription details': { shape: 'kv', key: 'subscription' },
  'plan details': { shape: 'ignore' },
  'subscription history': { shape: 'ignore' },
  'settings and preferences': { shape: 'ignore' },
  profiles: { shape: 'ignore' },
  mystuff: { shape: 'ignore' },
  'tastes and onboarding': { shape: 'ignore' },
  'cloud dvr': { shape: 'ignore' },
  'watch history': { shape: 'table', key: 'watchHistory' },
  'devices and logins': { shape: 'ignore' },
  advertising: { shape: 'ignore' },
  'advertising device ids': { shape: 'list', key: 'advertisingDeviceIds' },
  'advertising brands history': { shape: 'list', key: 'advertisingBrands' },
};

/** The sentence an empty section prints instead of a table. */
const NO_INFORMATION_RE = /^we have no information about you/i;

/** A cell: text plus the column offset it starts at. */
interface Cell {
  start: number;
  text: string;
}

/**
 * Split a layout line into cells. Words inside one cell are one space apart;
 * poppler separates neighbouring cells by at least two, so a run of two or
 * more spaces is a cell boundary.
 */
export function splitCells(line: string): Cell[] {
  const cells: Cell[] = [];
  const re = /\S+(?: \S+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    cells.push({ start: m.index, text: m[0] });
  }

  return cells;
}

/**
 * How a wrapped cell's continuation line glues onto the text above it. The PDF
 * consumed the break character, so the parser has to guess what it was:
 *
 * - `none`: identifiers wrap mid-word with nothing to show for it. Concatenate.
 * - `punct`: timestamps and `City,ST,CC` values wrap after a `:`, `,` or `-`
 *   and there was no space. Concatenate after punctuation, else space.
 * - `prose`: titles wrap at a space. Rejoin with one, except a hyphen glued to
 *   its word (`SM-|P613`) and a `:` inside a number (`13:|28`).
 *
 * Watch History only has prose columns and a timestamp; the other two
 * policies are kept for the ids, addresses and locations in the sections the
 * importer no longer reads, should one be brought back.
 */
type JoinPolicy = 'none' | 'punct' | 'prose';

function joinPolicyFor(column: string): JoinPolicy {
  if (/\bid\b|^type$|program|ip address/i.test(column)) {
    return 'none';
  }

  if (/date|time|location/i.test(column)) {
    return 'punct';
  }

  return 'prose';
}

export function joinWrapped(prev: string, next: string, policy: JoinPolicy): string {
  if (policy === 'none' || next.startsWith('_')) {
    return prev + next;
  }

  const last = prev.slice(-1);
  const beforeLast = prev.slice(-2, -1);

  if (policy === 'punct' && /[-,:/_]/.test(last)) {
    return prev + next;
  }

  if (last === '-' && beforeLast !== '' && beforeLast !== ' ') {
    return prev + next;
  }

  if (last === ':' && /\d/.test(prev.split(' ').pop() ?? '')) {
    return prev + next;
  }

  return `${prev} ${next}`;
}

/**
 * A value cell starts where its header starts, give or take a character of
 * glyph rounding; the rightmost header at or left of the cell claims it.
 */
function columnAt(starts: number[], cellStart: number): number {
  let col = 0;
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i] <= cellStart + 2) {
      col = i;
    }
  }

  return col;
}

/** A row block (header or data) folded onto the header's column offsets. */
function foldBlock(lines: string[], columns: string[], starts: number[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    for (const cell of splitCells(line)) {
      const column = columns[columnAt(starts, cell.start)];
      const prev = out[column];
      out[column] = prev ? joinWrapped(prev, cell.text, joinPolicyFor(column)) : cell.text;
    }
  }

  return out;
}

/** Header block → column names (wrapped header cells re-joined) and offsets. */
function readHeader(lines: string[]): { columns: string[]; starts: number[] } {
  const first = splitCells(lines[0]);
  const starts = first.map((c) => c.start);
  // Name the columns by position so wrapped fragments fold onto them, then
  // read the names back in order.
  const positional = first.map((_, i) => String(i));
  const folded = foldBlock(lines, positional, starts);

  return { columns: positional.map((p) => folded[p] ?? ''), starts };
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, i) => name.toLowerCase() === b[i].toLowerCase());
}

/**
 * Key/value grid: `Key:   value   Other Key:   value`. A key that wrapped in
 * the PDF ends its first line with `/` and puts the rest (`Amount:`) alone on
 * the next line; the value sits on the first line, so the fragment just
 * extends the previous key's name. A VALUE that wrapped continues on the next
 * line at the value's own offset, with no key beside it.
 */
function readKv(lines: string[], into: Record<string, string>): void {
  let lastKey: string | undefined;
  // Where each value on the previous line started, so a keyless continuation
  // line can be folded onto the value above it.
  let valueStarts: { key: string; start: number }[] = [];

  for (const line of lines) {
    const cells = splitCells(line);
    const nextValueStarts: { key: string; start: number }[] = [];

    for (let i = 0; i < cells.length; i += 1) {
      const text = cells[i].text;
      const isKey = /[:/]$/.test(text);
      if (!isKey) {
        const above = valueStarts.find((v) => Math.abs(v.start - cells[i].start) <= 2);
        if (above) {
          into[above.key] = `${into[above.key]} ${text}`;
          nextValueStarts.push(above);
        }

        continue;
      }

      const next = cells[i + 1];
      const hasValue = next != null && !/[:/]$/.test(next.text);
      const name = text.replace(/:$/, '').trim();

      if (!hasValue && lastKey != null && lastKey.endsWith('/')) {
        const merged = `${lastKey} ${name}`;
        into[merged] = into[lastKey];
        delete into[lastKey];
        const carried =
          nextValueStarts.find((v) => v.key === lastKey) ?? valueStarts.find((v) => v.key === lastKey);
        if (carried) {
          carried.key = merged;
        }

        lastKey = merged;
        continue;
      }

      if (hasValue) {
        into[name] = next.text;
        nextValueStarts.push({ key: name, start: next.start });
        i += 1;
      } else {
        into[name] = '';
      }

      lastKey = name;
    }

    valueStarts = nextValueStarts;
  }
}

function emptyTable(): HuluTable {
  return { columns: [], rows: [] };
}

/**
 * Parse the whole report. Pages are form-feed separated; within a page, blank
 * lines separate blocks; a block is a title, a header, a row, a key/value
 * line group, or prose, depending on the section the walker is in.
 */
export function parseHuluReport(text: string): HuluReport {
  const report: HuluReport = {
    personal: {},
    subscription: {},
    watchHistory: emptyTable(),
    advertisingDeviceIds: [],
    advertisingBrands: [],
    unknownSections: [],
  };
  const tables: Record<TableKey, HuluTable> = { watchHistory: report.watchHistory };
  const kvs: Record<KvKey, Record<string, string>> = {
    personal: report.personal,
    subscription: report.subscription,
  };
  const lists: Record<ListKey, string[]> = {
    advertisingDeviceIds: report.advertisingDeviceIds,
    advertisingBrands: report.advertisingBrands,
  };

  let section: Section = { shape: 'ignore' };
  // Column offsets of the header currently in force; reset on every header.
  let starts: number[] = [];
  let expectHeader = false;

  const handleBlock = (block: string[], firstBlockOnPage: boolean): void => {
    // A title is a line of its own, but poppler does not always put a blank
    // line between it and what follows ("Watch History" runs straight into the
    // header line; "Personal Details" into "First Name:"), so a block may
    // START with a title and carry the next block after it.
    const title = SECTIONS[block[0].trim().toLowerCase()];
    if (title) {
      section = title;
      starts = [];
      expectHeader = section.shape === 'table';
      if (block.length > 1) {
        handleBlock(block.slice(1), false);
      }

      return;
    }

    if (block.length === 1 && NO_INFORMATION_RE.test(block[0].trim())) {
      return;
    }

    switch (section.shape) {
      case 'ignore':
        break;
      case 'kv':
        readKv(block, kvs[section.key]);
        break;
      case 'list':
        lists[section.key].push(...block.map((l) => l.trim()).filter(Boolean));
        break;
      case 'table': {
        const table = tables[section.key];
        if (expectHeader) {
          const header = readHeader(block);
          table.columns = header.columns;
          starts = header.starts;
          expectHeader = false;
          break;
        }

        // A continuation page repeats the header, with its own offsets.
        if (firstBlockOnPage) {
          const header = readHeader(block);
          if (sameColumns(header.columns, table.columns)) {
            starts = header.starts;
            break;
          }
        }

        // A lone unnumbered cell where a multi-column row should be is a
        // title this parser has no shape for. Every table row here fills at
        // least its first two columns, so this never eats a real row, and
        // stopping the table is what keeps prose under a new heading from
        // being read as a row of it.
        if (block.length === 1 && table.columns.length > 1) {
          const cells = splitCells(block[0]);
          if (cells.length === 1 && !/\d/.test(cells[0].text)) {
            report.unknownSections.push(cells[0].text);
            section = { shape: 'ignore' };
            break;
          }
        }

        table.rows.push(foldBlock(block, table.columns, starts));
        break;
      }
    }
  };

  for (const page of text.split('\f')) {
    let firstBlockOnPage = true;
    for (const block of blocksOf(page)) {
      handleBlock(block, firstBlockOnPage);
      firstBlockOnPage = false;
    }
  }

  return report;
}

/** Non-blank line runs of a page, in order. */
function blocksOf(page: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const raw of page.split(/\r?\n/)) {
    if (raw.trim() === '') {
      if (current.length) {
        blocks.push(current);
        current = [];
      }

      continue;
    }

    current.push(raw);
  }

  if (current.length) {
    blocks.push(current);
  }

  return blocks;
}

/** Hulu's timestamp format, `03 Sep 2026 04:42:48`, read as UTC. */
export function parseHuluTimestamp(s: string | undefined): Date | undefined {
  if (!s) {
    return undefined;
  }

  const m = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim());
  if (!m) {
    return undefined;
  }

  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month === -1) {
    return undefined;
  }

  const d = new Date(
    Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)),
  );

  return isNaN(d.getTime()) ? undefined : d;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** `N/A` and blanks are no value. */
export function cellValue(v: string | undefined): string {
  const t = (v ?? '').trim();

  return /^n\/a$/i.test(t) ? '' : t;
}
