/**
 * RFC 8785 JSON Canonicalization Scheme (JCS), for JSON that came out of `JSON.parse`.
 *
 * Portable Web Spaces signs and hashes JSON in two places that must agree byte for byte with other
 * implementations: the `eddsa-jcs-2022` proof on every delegated capability (`dataIntegrity.ts`) and the
 * request digest. `jcs.spec.ts` pins this file to RFC 8785's own samples (§3.2.2, §3.2.3, Appendix B).
 *
 * ECMAScript's `JSON.stringify` already serializes primitives the way JCS requires (RFC 8785 §3.2.2.2
 * adopts its string escaping and §3.2.2.3 its Number-to-string), so this file adds only what
 * `JSON.stringify` does not do:
 *
 *   - recursive property sorting by UTF-16 code unit;
 *   - a refusal of everything that has no JSON form (NaN, Infinity, undefined, bigint, functions, symbols,
 *     class instances, sparse arrays), where `JSON.stringify` silently drops a member or writes `null`.
 *     A signature over a document that quietly lost a field is worse than an error;
 *   - a refusal of unpaired surrogates, which `JSON.stringify` escapes but I-JSON (RFC 7493 §2.1) forbids;
 *   - a nesting limit, because the input is attacker-supplied.
 */

const MAX_DEPTH = 64;

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

/** A UTF-16 string is I-JSON only when every surrogate has its partner. */
function assertWellFormed(text: string, what: string): void {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1); // NaN past the end, which fails both comparisons
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new JcsError(`${what} holds an unpaired surrogate`);
      }

      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new JcsError(`${what} holds an unpaired surrogate`);
    }
  }
}

function quote(text: string, what: string): string {
  assertWellFormed(text, what);

  return JSON.stringify(text);
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

      // JSON.stringify(-0) is "0", which is what RFC 8785 §3.2.2.3 asks for.
      return JSON.stringify(value);
    case 'string':
      return quote(value, 'a string');
    case 'object':
      return Array.isArray(value) ? writeArray(value, depth) : writeObject(value, depth);
    default:
      throw new JcsError(`a value of type ${typeof value} has no JSON form`);
  }
}

function writeArray(items: readonly unknown[], depth: number): string {
  const parts: string[] = [];
  for (let i = 0; i < items.length; i++) {
    if (!(i in items)) {
      throw new JcsError(`array element ${i} is a hole`);
    }

    parts.push(write(items[i], depth + 1));
  }

  return `[${parts.join(',')}]`;
}

function writeObject(object: object, depth: number): string {
  const prototype: unknown = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new JcsError('only plain objects have a JSON form');
  }

  // Array#sort without a comparator orders strings by UTF-16 code unit, which is RFC 8785 §3.2.3.
  const names = Object.keys(object).sort();
  const parts: string[] = [];
  for (const name of names) {
    const member = (object as Record<string, unknown>)[name];
    if (member === undefined) {
      throw new JcsError(`member "${name}" is undefined`);
    }

    parts.push(`${quote(name, 'a member name')}:${write(member, depth + 1)}`);
  }

  return `{${parts.join(',')}}`;
}
