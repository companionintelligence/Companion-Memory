/**
 * Opaque cursor over a LIMIT/OFFSET read.
 *
 * Used only where the underlying service pages by offset and there is no
 * `(sort key, id)` index to seek on — the product catalog, today. Offsets skip
 * and duplicate rows under concurrent writes, which is exactly why the
 * high-churn lists (things, events, receipts) use a keyset instead; encoding it
 * opaquely keeps that an implementation detail so a table can be given a real
 * keyset later without breaking a client that stored a cursor.
 */
const PREFIX = 'offset:';

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(`${PREFIX}${offset}`).toString('base64');
}

/** Returns 0 for an absent or unreadable cursor: a stale bookmark shows page one. */
export function decodeOffsetCursor(raw: string | null | undefined): number {
  if (raw == null || raw === '') {
    return 0;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf-8');
  } catch {
    return 0;
  }

  if (!decoded.startsWith(PREFIX)) {
    return 0;
  }

  const offset = Number.parseInt(decoded.slice(PREFIX.length), 10);

  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}
