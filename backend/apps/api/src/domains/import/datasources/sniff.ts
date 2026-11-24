import { open } from 'node:fs/promises';

/**
 * Cheap content peeks for recognizers.
 *
 * The lesson, learned three times in one Takeout session: a recognizer that
 * claims a file by NAME alone will eventually claim someone else's file.
 * Google exports a YouTube comment history named `comments.csv` (matched the
 * Reddit signature), a readme.md (matched Notion), and an address-book CSV
 * (matched the generic contact list). Every claim should look at the first
 * bytes: for CSVs the header row IS a schema, and requiring the columns the
 * parser actually reads costs one 4 KB read and removes the whole failure
 * class — a file that passes would have parsed anyway.
 *
 * All helpers fail CLOSED (unreadable → no match): recognition runs over
 * user-supplied trees where anything can be a broken symlink or a directory
 * wearing a `.csv` name.
 *
 * All helpers are ASYNC: recognition runs on the API request path, and a
 * synchronous read of a file on a saturated disk blocks the event loop for
 * every request on the process, not just the scan that asked.
 */

/** `text` without a leading UTF-8 byte order mark, which a CSV header test must not see. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** First `bytes` of the file as utf8, or null when unreadable. */
export async function readHead(fpath: string, bytes = 4096): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(fpath, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);

    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Does the CSV's header row carry every required column?
 *
 * Case-insensitive; tolerates a UTF-8 BOM, quoted headers, and \r\n. Column
 * matching is exact per cell (not substring), so `id` does not match
 * `Comment ID`. Callers pass the columns their PARSER reads — the check then
 * has no vocabulary of its own to drift.
 */
export async function csvHeaderHas(fpath: string, required: readonly string[]): Promise<boolean> {
  const head = await readHead(fpath);

  if (head == null) {
    return false;
  }

  const firstLine = head.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const cells = new Set(
    firstLine.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '').trim().toLowerCase()),
  );

  return required.every((column) => cells.has(column.toLowerCase()));
}

/** Does the file's head match the pattern? For XML/JSON roots and the like. */
export async function headMatches(fpath: string, pattern: RegExp): Promise<boolean> {
  const head = await readHead(fpath);

  return head != null && pattern.test(head);
}
