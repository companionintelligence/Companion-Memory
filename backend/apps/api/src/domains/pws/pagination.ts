/**
 * Cursor pagination (PWS "Pagination" appendix).
 *
 * Lists are ordered ascending by id, which is unique within the parent, so the order is stable
 * and total and a cursor can simply carry the last id returned (a keyset, not an offset). A
 * cursor is opaque to clients; here it is `base64url(JSON)` of `{ v, s, a }` where `s` is the
 * path of the list it was issued for. A cursor carried to another list, or one this server cannot
 * read, is `invalid-cursor`: the specification forbids clients to move a cursor between
 * collections and permits the server to refuse it.
 *
 * The pagination parameters select a page inside an already-authorized target. They never change
 * the target a capability has to match, and a server must not need a capability per page.
 */
import { PwsError } from './problems';

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 1000;

interface CursorPayload {
  v: 1;
  /** Path of the list the cursor belongs to. */
  s: string;
  /** Id of the last item of the previous page. */
  a: string;
}

export function encodeCursor(scope: string, after: string): string {
  const payload: CursorPayload = { v: 1, s: scope, a: after };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, scope: string): string {
  let payload: unknown;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error('not base64url');
    }
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new PwsError('invalid-cursor', 'The pagination cursor is malformed.');
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    (payload as CursorPayload).v !== 1 ||
    typeof (payload as CursorPayload).s !== 'string' ||
    typeof (payload as CursorPayload).a !== 'string'
  ) {
    throw new PwsError('invalid-cursor', 'The pagination cursor is malformed.');
  }
  if ((payload as CursorPayload).s !== scope) {
    throw new PwsError('invalid-cursor', 'The pagination cursor was issued for a different list.');
  }
  return (payload as CursorPayload).a;
}

export interface PageRequest {
  limit: number;
  after?: string;
}

export interface PageLimits {
  defaultLimit: number;
  maxLimit: number;
}

/**
 * Reads `limit` and `cursor`. Call it only after authorization: a malformed cursor is an
 * `invalid-cursor` for an authorized caller and the merged `not-found` for anyone else.
 */
export function readPageRequest(search: URLSearchParams, scope: string, limits: PageLimits): PageRequest {
  const rawLimit = search.get('limit');
  const rawCursor = search.get('cursor');

  let limit = limits.defaultLimit;
  if (rawLimit !== null) {
    if (!/^[0-9]+$/.test(rawLimit) || /^0+$/.test(rawLimit)) {
      throw new PwsError('invalid-request-body', 'The "limit" parameter must be a positive integer.', {
        errors: [{ detail: 'The "limit" parameter must be a positive integer.', pointer: 'limit' }],
      });
    }
    // An oversized limit is clamped rather than rejected.
    // More than nine significant digits is past any maximum: clamp it, whatever its length.
    const significant = rawLimit.replace(/^0+/, '');
    limit = Math.min(significant.length > 9 ? Number.MAX_SAFE_INTEGER : Number(significant), limits.maxLimit);
  }

  return {
    limit,
    ...(rawCursor !== null ? { after: decodeCursor(rawCursor, scope) } : {}),
  };
}

/** The `next` link: the list's path with the limit and the cursor baked in. */
export function nextLink(scope: string, limit: number, lastId: string): string {
  return `${scope}?limit=${limit}&cursor=${encodeCursor(scope, lastId)}`;
}
