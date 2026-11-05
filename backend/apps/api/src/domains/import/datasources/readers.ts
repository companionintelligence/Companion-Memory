import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV, type ParseCSVOptions } from './csv';
import type { ImportParams } from './timeline';

/**
 * The one way an importer reads a text, JSON or CSV file off disk.
 *
 * Every importer used to carry its own copy of the same sixteen lines — read
 * the file, log "Failed to read", parse it, log "Failed to parse" — and six of
 * them carried a private `readJson` as well. The copies had drifted: four of
 * the six stripped the UTF-8 byte order mark and two did not, so a BOM'd
 * `conversations.json` parsed in one importer and failed in its neighbour
 * (`JSON.parse` rejects U+FEFF). These helpers strip it once, for everyone.
 *
 * `undefined` means "could not read or parse"; the caller returns, as its
 * inline block did. With `log` set, the two failures are reported under the
 * same `Failed to read <file>` / `Failed to parse <file>` lines the inline
 * blocks wrote, so a run's log reads as before.
 */
export interface ReadOptions {
  log?: ImportParams['log'];
  /** What the log calls the file. Defaults to its basename. */
  label?: string;
}

/** `text` without a leading UTF-8 byte order mark. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The file as UTF-8 text, BOM stripped; `undefined` when it cannot be read. */
export async function readText(fpath: string, { log, label }: ReadOptions = {}): Promise<string | undefined> {
  try {
    return stripBom(await readFile(fpath, 'utf8'));
  } catch (e) {
    log?.('error', `Failed to read ${label ?? path.basename(fpath)}`, { error: (e as Error).message });

    return undefined;
  }
}

/** The file parsed as JSON; `undefined` when it cannot be read or is not JSON. */
export async function readJsonFile<T = unknown>(
  fpath: string,
  options: ReadOptions = {},
): Promise<T | undefined> {
  const raw = await readText(fpath, options);

  if (raw === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    options.log?.('error', `Failed to parse ${options.label ?? path.basename(fpath)}`, {
      error: (e as Error).message,
    });

    return undefined;
  }
}

/** The file parsed as CSV rows keyed by header; `undefined` when it cannot be read or parsed. */
export async function readCsvFile(
  fpath: string,
  options: ReadOptions & { csv?: ParseCSVOptions } = {},
): Promise<Record<string, string>[] | undefined> {
  const raw = await readText(fpath, options);

  if (raw === undefined) {
    return undefined;
  }

  try {
    return parseCSV(raw, options.csv);
  } catch (e) {
    options.log?.('error', `Failed to parse ${options.label ?? path.basename(fpath)}`, {
      error: (e as Error).message,
    });

    return undefined;
  }
}
