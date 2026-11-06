/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * This is the canonical form Data Integrity's `eddsa-jcs-2022` signs over, the form the duplicate
 * -execution record compares, and the form a task digest hashes. It must therefore be exactly
 * RFC 8785 and not "close to" it: two implementations that disagree about one byte disagree about
 * whether a signature verifies.
 *
 * ═══ WHY THIS IS NOT `asks/auditSaid.ts`'s `canonicalStringify` ═══
 *
 * That helper sorts keys and calls `JSON.stringify`, which its own header says is "close to but not
 * RFC 8785". Nothing leaves the box under it today. A Trust Task proof is verified by OTHER
 * implementations, so this file is stricter in the places a lenient one would silently diverge:
 *
 * - Numbers must be finite. NaN and the infinities are not JSON and have no canonical spelling.
 * - Strings must be well-formed Unicode. A lone surrogate is not I-JSON; `JSON.stringify` would escape
 *   it, and another implementation would not.
 * - Only plain objects, arrays, strings, finite numbers, booleans and null are accepted. A `Date`, a
 *   `Map` or a class instance throws rather than serializing as whatever its `toJSON` happens to say.
 * - Depth is bounded (SPEC §12.4 suggests 128), so a hostile document cannot overflow the stack here.
 *
 * What it can rely on from the platform: ECMAScript's `Number.prototype.toString` IS the number
 * format RFC 8785 §3.2.2.3 prescribes, `JSON.stringify` on a string produces the escapes §3.2.2.2
 * prescribes (lower-case `\u00xx` for controls, no escaping of `/` or of non-ASCII), and the default
 * `Array.prototype.sort` orders strings by UTF-16 code unit, which is the §3.2.3 key order.
 */

export class JcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JcsError';
  }
}

/** SPEC §12.4's suggested bound. */
export const DEFAULT_MAX_DEPTH = 128;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function assertWellFormed(text: string): void {
  if (LONE_SURROGATE.test(text)) {
    throw new JcsError('string contains a lone surrogate');
  }
}

function serialize(value: unknown, depth: number, maxDepth: number): string {
  if (depth > maxDepth) {
    throw new JcsError(`nesting deeper than ${maxDepth} levels`);
  }

  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      if (!Number.isFinite(value)) {
        throw new JcsError('number is not finite');
      }

      // `JSON.stringify(-0)` is "0", which is also what RFC 8785 requires.
      return JSON.stringify(value);

    case 'string':
      assertWellFormed(value);

      return JSON.stringify(value);

    case 'object': {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const item: unknown = value[index];
          if (item === undefined) {
            throw new JcsError('undefined is not a JSON value');
          }

          items.push(serialize(item, depth + 1, maxDepth));
        }

        return `[${items.join(',')}]`;
      }

      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new JcsError('only plain objects can be canonicalized');
      }

      const record = value as Record<string, unknown>;
      const members: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const member = record[key];
        // `undefined` is what an absent optional member looks like in a built object; JSON has no such
        // value, so it is omitted exactly as `JSON.stringify` omits it.
        if (member === undefined) {
          continue;
        }

        assertWellFormed(key);
        members.push(`${JSON.stringify(key)}:${serialize(member, depth + 1, maxDepth)}`);
      }

      return `{${members.join(',')}}`;
    }

    default:
      throw new JcsError(`${typeof value} is not a JSON value`);
  }
}

/** The RFC 8785 canonical form of `value`, as a string (UTF-8 encode it before hashing or signing). */
export function canonicalize(value: unknown, maxDepth: number = DEFAULT_MAX_DEPTH): string {
  return serialize(value, 0, maxDepth);
}
