/**
 * Cursor codec for the things list's SQL keyset.
 *
 * `ItemService.findPage` seeks on BOTH halves of `(created_at, object_id)` —
 * created_at alone drops every row sharing a timestamp with the cursor, which
 * after a bulk import is most of the page — so the opaque cursor has to carry
 * both. Base64 of `<iso>|<uuid>` keeps it opaque to clients while staying
 * trivially debuggable server-side.
 *
 * `<iso>` is the row's `created_at` TO THE MICROSECOND, in UTC, exactly as
 * Postgres formatted it (`2026-05-01T00:00:00.123456Z`). It travels as text and
 * never becomes a `Date` here: a `Date` holds milliseconds, so a cursor built
 * from one named the millisecond that contains its row, not the row's instant,
 * and the seek past it skipped every row of that instant that sorted after the
 * page boundary. `ci.objects.created_at` is `timestamptz(6)`, `DEFAULT now()`,
 * and a bulk import stamps a whole batch with one.
 *
 * A cursor minted before that is `toISOString()` of such a `Date`
 * (`2026-05-01T00:00:00.123Z`). It decodes the same way and seeks as it always
 * did, to the millisecond: the microseconds it never held cannot be recovered.
 * The new form reads as an ISO date on a server that predates it too (V8 drops
 * the digits past the third), so a deploy that is half rolled out serves both.
 *
 * A cursor that does not decode is treated as ABSENT rather than as an error:
 * a stale bookmark should show the first page, not a 500. That now includes a
 * time Postgres would refuse. It is bound into the query as text, where it used
 * to be a `Date` that `new Date()` had already vetted, so a malformed one would
 * be a 500 from the database instead.
 */
export interface ItemCursor {
  createdAt: string;
  id: string;
}

/**
 * UTC, to the second, with up to six fractional digits: what `toISOString()`
 * (three) and Postgres' `US` (six) write. Year 0000 is out because Postgres has
 * none, and a cursor naming it would be refused there.
 */
const INSTANT = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function isInstant(text: string): boolean {
  if (!INSTANT.test(text)) {
    return false;
  }

  const at = new Date(text);

  // `new Date` rolls an impossible date over instead of refusing it (2026-02-30 is March 2), and
  // Postgres refuses it. Only a time that survives the round trip to the second is one.
  return !Number.isNaN(at.getTime()) && at.toISOString().startsWith(text.slice(0, 19));
}

export function encodeItemCursor(cursor: ItemCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`).toString('base64');
}

export function decodeItemCursor(raw: string | null | undefined): ItemCursor | null {
  if (raw == null || raw === '') {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf-8');
  } catch {
    return null;
  }

  const separator = decoded.indexOf('|');
  if (separator < 0) {
    return null;
  }

  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);

  if (!isInstant(createdAt) || id === '') {
    return null;
  }

  return { createdAt, id };
}
