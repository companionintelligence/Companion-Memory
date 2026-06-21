/**
 * log — status lines styled to match the Makefile's output, so running the
 * dev-stack scripts reads the same as running make: ➤ for a step in progress,
 * ✓ for a completed one, • for a non-fatal note, ⓘ for supplementary detail,
 * and ✗ for a failure. Colors mirror the Makefile's RED/GREEN/YELLOW/BLUE.
 */
const RESET = '\x1b[0m';
const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[0;33m';
const BLUE = '\x1b[0;34m';

/** A step in progress, e.g. "➤ Bringing up Docker services..." */
export const step = (message: string): void => console.log(`➤ ${message}`);

/** A completed step, e.g. "✓ Migrations applied" */
export const ok = (message: string): void => console.log(`${GREEN}✓${RESET} ${message}`);

/** A non-fatal note, e.g. "• No route registered" */
export const note = (message: string): void => console.log(`${YELLOW}•${RESET} ${message}`);

/** Supplementary detail, e.g. "ⓘ  api :3030  web :5173" */
export const info = (message: string): void => console.log(`${BLUE}ⓘ${RESET}  ${message}`);

/** A failure, e.g. "✗ Caddy admin not reachable" */
export const fail = (message: string): void => console.error(`${RED}✗${RESET} ${message}`);

/** Wrap a URL as an OSC 8 terminal hyperlink. Modern terminals (iTerm2, VS Code,
 * recent Terminal.app) render `text` clickable; older ones just show the text,
 * so it degrades cleanly. Defaults the visible text to the URL itself. */
export const link = (url: string, text: string = url): string => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

type Align = 'left' | 'right';

/** Render a box-drawing table, indented two spaces to sit under a status line.
 * Columns are left-aligned unless `align[i]` says otherwise (e.g. 'right' for a
 * numeric column). */
export function table(headers: string[], rows: string[][], align: Align[] = []): void {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );

  const pad = (text: string, i: number): string =>
    align[i] === 'right' ? text.padStart(widths[i]) : text.padEnd(widths[i]);

  const rule = (left: string, mid: string, right: string): string =>
    `  ${left}${widths.map((w) => '─'.repeat(w + 2)).join(mid)}${right}`;

  const line = (cells: string[]): string => `  │ ${cells.map((cell, i) => pad(cell ?? '', i)).join(' │ ')} │`;

  console.log(rule('┌', '┬', '┐'));
  console.log(line(headers));
  console.log(rule('├', '┼', '┤'));

  for (const row of rows) {
    console.log(line(row));
  }

  console.log(rule('└', '┴', '┘'));
}
