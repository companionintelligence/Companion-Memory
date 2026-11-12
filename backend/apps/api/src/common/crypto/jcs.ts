/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Shared deterministic JSON canonicalizer for SAID computation, ISO 27560 consent receipts,
 * and capability tokens. Enforces finite numbers, well-formed Unicode, plain objects, and
 * bounded nesting depth so two implementations never disagree by a single byte.
 */

export class JcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JcsError';
  }
}

export const DEFAULT_JCS_MAX_DEPTH = 128;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function assertWellFormed(text: string): void {
  if (LONE_SURROGATE.test(text)) {
    throw new JcsError('string contains a lone surrogate');
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
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

      if (!isPlainObject(value)) {
        throw new JcsError('non-plain object cannot be JCS-canonicalized');
      }

      const keys = Object.keys(value).sort();
      const entries: string[] = [];
      for (const key of keys) {
        const prop = value[key];
        if (prop === undefined) {
          continue;
        }

        assertWellFormed(key);
        entries.push(`${JSON.stringify(key)}:${serialize(prop, depth + 1, maxDepth)}`);
      }

      return `{${entries.join(',')}}`;
    }

    default:
      throw new JcsError(`unsupported JSON value type: ${typeof value}`);
  }
}

/** Canonicalizes `value` according to RFC 8785 (JCS). */
export function canonicalizeJcs(value: unknown, maxDepth = DEFAULT_JCS_MAX_DEPTH): string {
  if (value === undefined) {
    throw new JcsError('top-level value cannot be undefined');
  }

  return serialize(value, 0, maxDepth);
}
