/**
 * Cursor codec for the things list's SQL keyset.
 *
 * `ItemService.findPage` seeks on BOTH halves of `(created_at, object_id)` —
 * created_at alone drops every row sharing a timestamp with the cursor, which
 * after a bulk import is most of the page — so the opaque cursor has to carry
 * both. Base64 of `<iso>|<uuid>` keeps it opaque to clients while staying
 * trivially debuggable server-side.
 *
 * A cursor that does not decode is treated as ABSENT rather than as an error:
 * a stale bookmark should show the first page, not a 500.
 */
export interface ItemCursor {
  createdAt: Date;
  id: string;
}

export function encodeItemCursor(cursor: ItemCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`).toString('base64');
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

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (Number.isNaN(createdAt.getTime()) || id === '') {
    return null;
  }

  return { createdAt, id };
}
