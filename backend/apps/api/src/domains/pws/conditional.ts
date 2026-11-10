/**
 * Conditional requests (PWS "Conditional Requests", RFC 9110 section 13).
 *
 * Only entity tags are evaluated. The validators this server mints are strong (see `models.ts`),
 * so strong and weak comparison agree, and `If-Modified-Since` / `If-Unmodified-Since` are not
 * honoured: the specification asks for `If-Match` and `If-None-Match` and says `Last-Modified` is
 * optional.
 *
 * Callers evaluate a precondition only after the caller has been authorized, so a `412` is never
 * observable by someone who could not have written the target (spec: "a server MUST verify the
 * caller's authorization before evaluating a precondition").
 */

export interface EtagList {
  star: boolean;
  /** Entity-tags with their quotes and any `W/` prefix removed (`"x"` becomes `x`). */
  tags: Array<{ weak: boolean; value: string }>;
}

const ETAG = /^(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"$/;

/** Parses an `If-Match` / `If-None-Match` field value. A malformed one yields no tags and no star. */
export function parseEtagList(header: string | undefined): EtagList | undefined {
  if (header === undefined) {
    return undefined;
  }

  const trimmed = header.trim();
  if (trimmed === '*') {
    return { star: true, tags: [] };
  }

  const tags: EtagList['tags'] = [];
  for (const part of trimmed.split(',')) {
    const match = ETAG.exec(part.trim());
    if (match) {
      tags.push({ weak: match[1] !== undefined, value: match[2] ?? '' });
    }
  }

  return { star: false, tags };
}

function unquote(etag: string): string {
  return etag.slice(1, -1);
}

export type Precondition = 'proceed' | 'not-modified' | 'precondition-failed';

export interface PreconditionInput {
  method: string;
  ifMatch: string | undefined;
  ifNoneMatch: string | undefined;
  /** The target's current entity-tag, or undefined when it does not exist. */
  currentEtag: string | undefined;
}

/**
 * RFC 9110 section 13.2.2, entity-tag preconditions only:
 *
 *   1. `If-Match` present: it must match (strong comparison) the current tag, or be `*` with a
 *      current representation. Otherwise `412`.
 *   2. `If-None-Match` present: when it matches (weak comparison, or `*` with a current
 *      representation) a `GET`/`HEAD` is `304` and anything else is `412`.
 */
export function evaluatePreconditions({
  method,
  ifMatch,
  ifNoneMatch,
  currentEtag,
}: PreconditionInput): Precondition {
  const current = currentEtag === undefined ? undefined : unquote(currentEtag);

  const match = parseEtagList(ifMatch);
  if (match) {
    const satisfied = match.star
      ? current !== undefined
      : current !== undefined && match.tags.some((tag) => !tag.weak && tag.value === current);
    if (!satisfied) {
      return 'precondition-failed';
    }
  }

  const noneMatch = parseEtagList(ifNoneMatch);
  if (noneMatch) {
    const matches = noneMatch.star
      ? current !== undefined
      : current !== undefined && noneMatch.tags.some((tag) => tag.value === current);
    if (matches) {
      return method === 'GET' || method === 'HEAD' ? 'not-modified' : 'precondition-failed';
    }
  }

  return 'proceed';
}
