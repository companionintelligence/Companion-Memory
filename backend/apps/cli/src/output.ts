/**
 * Where a command's words go.
 *
 * An indirection rather than bare `console.log` so the tests assert on what a
 * command SAID — which is the whole of a CLI's behaviour — instead of spying on
 * a global. `isTTY` is carried alongside because progress rendering is the one
 * thing that must differ between a terminal and a pipe.
 */
export interface Term {
  out(line: string): void;
  err(line: string): void;
  isTTY: boolean;
}

export function processTerm(): Term {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    isTTY: process.stdout.isTTY === true,
  };
}

/** A column: its heading, and how to read it off a row. */
export interface Column<T> {
  header: string;
  value: (row: T) => string;
  /** Right-align, for counts and percentages. */
  align?: 'right';
}

/**
 * Fixed-width table, the same shape the retired CI-Import-Tools `ci-import` printed.
 *
 * Two spaces between columns and a rule under the headings: wide enough to read,
 * narrow enough that a Takeout's data-source list still fits an 80-column
 * terminal. An empty result says so in words rather than printing a bare
 * heading row, because "(none)" and "the query failed" must not look alike.
 */
export function table<T>(rows: readonly T[], columns: ReadonlyArray<Column<T>>, empty = '(none)'): string {
  if (rows.length === 0) {
    return empty;
  }

  const cells = rows.map((row) => columns.map((column) => column.value(row)));
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...cells.map((row) => row[index].length)),
  );

  const pad = (text: string, width: number, align?: 'right') =>
    align === 'right' ? text.padStart(width) : text.padEnd(width);

  const line = (values: string[]) =>
    values
      .map((value, index) => pad(value, widths[index], columns[index].align))
      .join('  ')
      .trimEnd();

  return [
    line(columns.map((column) => column.header)),
    widths.map((width) => '─'.repeat(width)).join('  '),
    ...cells.map(line),
  ].join('\n');
}

/** Human bytes. Exports are measured in GB; three significant figures is plenty. */
export function bytes(count: number | null | undefined): string {
  if (count == null) {
    return '';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = count;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)}${units[unit]}`;
}

/** Milliseconds as something a person reads at a glance. */
export function duration(ms: number | null | undefined): string {
  if (ms == null) {
    return '';
  }

  const seconds = Math.round(ms / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  return minutes < 60 ? `${minutes}m${seconds % 60}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** An ISO timestamp trimmed to the minute — the resolution a run list needs. */
export function stamp(value: string | Date | null | undefined): string {
  if (value == null) {
    return '';
  }

  return new Date(value).toISOString().slice(0, 16).replace('T', ' ');
}

/** Print a value as the `--json` contract: pretty, one trailing newline. */
export function json(term: Term, value: unknown): void {
  term.out(JSON.stringify(value, null, 2));
}

/** Split a comma-separated flag into trimmed, non-empty tokens. */
export function csv(value: string | undefined): string[] | undefined {
  if (value == null) {
    return undefined;
  }

  const tokens = value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  return tokens.length > 0 ? tokens : undefined;
}
