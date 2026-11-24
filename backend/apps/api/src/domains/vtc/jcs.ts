/**
 * RFC 8785 JSON Canonicalization Scheme (JCS), for JSON that came out of `JSON.parse`.
 *
 * The `eddsa-jcs-2022` Data Integrity suite signs the SHA-256 of a document's JCS form, so a
 * signature made elsewhere verifies here only when this function emits the same bytes for the
 * same document. `jcs.spec.ts` pins it to the RFC's own samples (§3.2.2, §3.2.3, Appendix B).
 *
 * ECMAScript's `JSON.stringify` already serializes primitives the way JCS requires (RFC 8785
 * §3.2.2.2 adopts its string escaping and §3.2.2.3 its Number-to-string), so this file adds only
 * what `JSON.stringify` does not do:
 *
 *   - recursive property sorting by UTF-16 code units;
 *   - a refusal of everything that has no JSON form (NaN, Infinity, undefined, bigint, functions,
 *     symbols, class instances), where `JSON.stringify` silently drops the member or writes
 *     `null`. A signature over a document that quietly lost a field is worse than an error;
 *   - a refusal of unpaired surrogates, which `JSON.stringify` escapes but I-JSON forbids;
 *   - a nesting limit, because the input is attacker-supplied.
 */

const MAX_DEPTH = 64;

/** A UTF-16 string is I-JSON only when it holds no unpaired surrogate (RFC 7493 §2.1). */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export class JcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JcsError';
  }
}

/** The JCS form of `value`. Throws `JcsError` when `value` has no JSON form. */
export function canonicalize(value: unknown): string {
  return write(value, 0);
}

function write(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new JcsError(`nesting is deeper than ${MAX_DEPTH}`);
  }

  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new JcsError('NaN and Infinity have no JSON form');
      }

      return JSON.stringify(value);
    case 'string':
      return quote(value);
    case 'object':
      return Array.isArray(value) ? writeArray(value, depth) : writeObject(value, depth);
    default:
      throw new JcsError(`a value of type ${typeof value} has no JSON form`);
  }
}

function quote(text: string): string {
  if (UNPAIRED_SURROGATE.test(text)) {
    throw new JcsError('a string holds an unpaired surrogate');
  }

  return JSON.stringify(text);
}

function writeArray(items: readonly unknown[], depth: number): string {
  // `Array.from` visits holes as `undefined`, which `write` then refuses; `map` would skip them
  // and `join` would emit `[,1]`.
  return `[${Array.from(items, (item) => write(item, depth + 1)).join(',')}]`;
}

function writeObject(value: object, depth: number): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new JcsError('only plain objects have a JSON form');
  }

  const record = value as Record<string, unknown>;
  // The default sort compares UTF-16 code units, which is the order RFC 8785 §3.2.3 requires.
  const members = Object.keys(record)
    .sort()
    .map((key) => `${quote(key)}:${write(record[key], depth + 1)}`);

  return `{${members.join(',')}}`;
}
