/**
 * The one opaque keyset-cursor codec.
 *
 * Eight services and resolvers each carried their own
 * `Buffer.from(\`${a}<sep>${b}\`).toString('base64')` and its inverse, and
 * the inverses disagreed on the one thing that matters: three of them split
 * the decoded text with `split(sep)`, which lets a separator inside the LAST
 * part (an id is only "whatever the primary key is", a uuid by convention,
 * not by contract) eat into the part before it and turn a valid cursor into
 * a miss or a 400. This splits on the first `arity - 1` separators, so the
 * last part keeps whatever it carries.
 *
 * The wire format is a parameter, not a decision made here: every call site
 * keeps the separator and alphabet it has always minted, so a cursor a client
 * is holding right now still decodes. What each part MEANS — an instant, a
 * score, an id that may not be empty — is the caller's to check.
 */
export interface KeysetCursorFormat {
  /** What sits between the parts. Defaults to `|`. */
  separator?: string;
  /** `base64` (the default) or the URL-safe `base64url`. */
  alphabet?: 'base64' | 'base64url';
}

/** The parts joined and encoded. Parts are written as given; an empty part is allowed. */
export function encodeKeysetCursor(parts: readonly string[], format: KeysetCursorFormat = {}): string {
  const { separator = '|', alphabet = 'base64' } = format;

  return Buffer.from(parts.join(separator), 'utf8').toString(alphabet);
}

/**
 * The `arity` parts of a cursor, or `null` when `raw` is absent, is not
 * decodable, or does not hold `arity - 1` separators. Parts may be empty —
 * a receipt without a purchase date encodes one — so a caller that forbids
 * that checks it itself.
 */
export function decodeKeysetCursor(
  raw: string | null | undefined,
  arity: number,
  format: KeysetCursorFormat = {},
): string[] | null {
  const { separator = '|', alphabet = 'base64' } = format;

  if (raw == null || raw === '') {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(raw, alphabet).toString('utf8');
  } catch {
    return null;
  }

  const parts: string[] = [];
  let rest = decoded;

  for (let i = 1; i < arity; i += 1) {
    const at = rest.indexOf(separator);

    if (at < 0) {
      return null;
    }

    parts.push(rest.slice(0, at));
    rest = rest.slice(at + separator.length);
  }

  parts.push(rest);

  return parts;
}
