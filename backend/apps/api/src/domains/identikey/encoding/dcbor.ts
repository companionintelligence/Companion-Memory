import { IdentiKeyError } from '../errors';

/**
 * The deterministic-CBOR (dCBOR) subset the IdentiKey authentication protocol signs over:
 * unsigned integers, byte strings, text strings, definite-length arrays and text-keyed maps.
 *
 * ═══ WHY A CODEC OF OUR OWN ═══
 *
 * This is a port of `identikey-auth`'s `cbor.rs`, which is itself hand-rolled "so the encoding the
 * protocol signs over is small, auditable, and fully under our control". The same reasoning holds
 * here: a signature is over BYTES, so two implementations that disagree about how a value is written
 * disagree about whether a signature is valid. The committed Rust fixtures (`__tests__/fixtures`) are
 * what pin this file to the reference, byte for byte.
 *
 * The rules, from identikey's `dcbor-determinism.md` and RFC 8949 §4.2.1:
 *
 *   * integers in the smallest form that holds them;
 *   * definite lengths only;
 *   * map keys sorted by the ENCODED BYTES of each key (not by string value, not by insertion order),
 *     with no duplicates;
 *   * no floats, no tags, no negative integers, no simple values.
 *
 * DECODING IS STRICT. A non-canonical input is refused, never normalised: a peer must not be able to
 * send a second, differently-encoded form of one logical value, because the signature covers the
 * bytes it sent. That is also why callers verify over the bytes they RECEIVED and decode only to
 * read fields out of them.
 *
 * Deliberately NOT here: tags and negative integers (Gordian Envelope, used by the wallet and op-log
 * tiers, needs both). They arrive with the phase that needs them rather than being half-supported now.
 */

/** A value in the supported subset. Maps are ordered pair lists: a JS object cannot hold `__proto__` safely. */
export type Cbor =
  | { readonly t: 'uint'; readonly v: bigint }
  | { readonly t: 'bytes'; readonly v: Uint8Array }
  | { readonly t: 'text'; readonly v: string }
  | { readonly t: 'array'; readonly v: readonly Cbor[] }
  | { readonly t: 'map'; readonly v: readonly (readonly [string, Cbor])[] };

const UINT64_MAX = (1n << 64n) - 1n;

/** Default ceilings on untrusted input. Every IdentiKey auth message is a few kilobytes at most. */
export const DEFAULT_MAX_BYTES = 64 * 1024;
export const DEFAULT_MAX_DEPTH = 16;

const textEncoder = new TextEncoder();
// `fatal`: malformed UTF-8 is an error, not U+FFFD. `ignoreBOM: true` keeps a leading U+FEFF in the
// output instead of silently dropping it, which would change what the bytes mean.
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Builders. They validate, so an encoder cannot be handed a value it would silently mangle. */
export const cbor = {
  uint(n: number | bigint): Cbor {
    // Check a number BEFORE converting it: BigInt(1.5) and BigInt(NaN) throw a less helpful error.
    if (typeof n === 'number' && !Number.isSafeInteger(n)) {
      throw new RangeError('uint: number is not a safe integer; pass a bigint');
    }

    const v = typeof n === 'bigint' ? n : BigInt(n);
    if (v < 0n || v > UINT64_MAX) {
      throw new RangeError('uint: out of range for an unsigned 64-bit integer');
    }

    return { t: 'uint', v };
  },

  bytes(value: Uint8Array): Cbor {
    return { t: 'bytes', v: value };
  },

  text(value: string): Cbor {
    return { t: 'text', v: value };
  },

  array(items: readonly Cbor[]): Cbor {
    return { t: 'array', v: items };
  },

  map(entries: readonly (readonly [string, Cbor])[]): Cbor {
    return { t: 'map', v: entries };
  },
};

// ─── encoding ────────────────────────────────────────────────────────────────

/** Serialise to canonical bytes. Throws on a duplicate map key or a string that is not well-formed. */
export function encode(value: Cbor): Uint8Array {
  const chunks: Uint8Array[] = [];
  write(value, chunks);

  return concat(chunks);
}

function write(value: Cbor, out: Uint8Array[]): void {
  switch (value.t) {
    case 'uint':
      out.push(head(0, value.v));

      return;
    case 'bytes':
      out.push(head(2, BigInt(value.v.length)), value.v);

      return;
    case 'text': {
      const bytes = utf8(value.v);
      out.push(head(3, BigInt(bytes.length)), bytes);

      return;
    }

    case 'array':
      out.push(head(4, BigInt(value.v.length)));
      for (const item of value.v) {
        write(item, out);
      }

      return;
    case 'map': {
      // Canonical order is the order of the ENCODED key bytes. For short ASCII keys that is length
      // first (the head byte carries the length), then the bytes: "v" < "aud" < "exp" < "nonce".
      const keyed = value.v.map(([key, item]) => {
        const keyBytes = utf8(key);

        return { encodedKey: concat([head(3, BigInt(keyBytes.length)), keyBytes]), item };
      });
      keyed.sort((a, b) => Buffer.compare(a.encodedKey, b.encodedKey));

      for (let i = 1; i < keyed.length; i += 1) {
        if (Buffer.compare(keyed[i - 1].encodedKey, keyed[i].encodedKey) === 0) {
          throw new IdentiKeyError('malformed', 'duplicate map key');
        }
      }

      out.push(head(5, BigInt(keyed.length)));
      for (const { encodedKey, item } of keyed) {
        out.push(encodedKey);
        write(item, out);
      }
    }
  }
}

/** A CBOR head: major type in the high three bits, the argument in the smallest form that holds it. */
function head(major: number, n: bigint): Uint8Array {
  const mt = major << 5;

  if (n < 24n) {
    return Uint8Array.of(mt | Number(n));
  }

  if (n <= 0xffn) {
    return Uint8Array.of(mt | 24, Number(n));
  }

  if (n <= 0xffffn) {
    const out = new Uint8Array(3);
    out[0] = mt | 25;
    new DataView(out.buffer).setUint16(1, Number(n));

    return out;
  }

  if (n <= 0xffff_ffffn) {
    const out = new Uint8Array(5);
    out[0] = mt | 26;
    new DataView(out.buffer).setUint32(1, Number(n));

    return out;
  }

  const out = new Uint8Array(9);
  out[0] = mt | 27;
  new DataView(out.buffer).setBigUint64(1, n);

  return out;
}

// `TextEncoder` replaces a lone surrogate with U+FFFD instead of failing, which would encode a
// different string than the caller handed over. Refuse it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function utf8(value: string): Uint8Array {
  if (LONE_SURROGATE.test(value)) {
    throw new IdentiKeyError('malformed', 'text is not well-formed Unicode');
  }

  return textEncoder.encode(value);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
}

// ─── decoding ────────────────────────────────────────────────────────────────

export interface DecodeOptions {
  /** Refuse input longer than this. Defaults to {@link DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
  /** Refuse nesting deeper than this. Defaults to {@link DEFAULT_MAX_DEPTH}. */
  maxDepth?: number;
}

/**
 * Parse canonical bytes, requiring all of the input to be consumed.
 *
 * Refuses (as `malformed`): non-minimal integers, indefinite lengths, unsupported major types,
 * non-text map keys, keys out of canonical order or repeated, invalid UTF-8, trailing bytes, input over
 * `maxBytes`, and nesting past `maxDepth`.
 */
export function decode(data: Uint8Array, options: DecodeOptions = {}): Cbor {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (data.length > maxBytes) {
    throw new IdentiKeyError('malformed', `input is ${data.length} bytes, over the ${maxBytes} byte limit`);
  }

  const reader = new Reader(data, options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const value = reader.readValue(0);
  if (reader.remaining !== 0) {
    throw new IdentiKeyError('malformed', 'trailing bytes after the top-level value');
  }

  return value;
}

class Reader {
  private pos = 0;

  constructor(
    private readonly data: Uint8Array,
    private readonly maxDepth: number,
  ) {}

  get remaining(): number {
    return this.data.length - this.pos;
  }

  readValue(depth: number): Cbor {
    if (depth > this.maxDepth) {
      throw new IdentiKeyError('malformed', 'nesting is too deep');
    }

    const { major, arg } = this.readHead();

    switch (major) {
      case 0:
        return { t: 'uint', v: arg };
      case 2:
        return { t: 'bytes', v: this.take(this.length(arg)).slice() };
      case 3:
        return { t: 'text', v: this.decodeText(this.take(this.length(arg))) };
      case 4: {
        // Every element is at least one byte, so a count beyond what is left is a lie, and refusing
        // it here stops a short input from asking for a loop of 2^64 iterations.
        const count = this.length(arg);
        const items: Cbor[] = [];
        for (let i = 0; i < count; i += 1) {
          items.push(this.readValue(depth + 1));
        }

        return { t: 'array', v: items };
      }

      case 5:
        return this.readMap(this.length(arg), depth);
      default:
        throw new IdentiKeyError('malformed', 'unsupported CBOR major type');
    }
  }

  private readMap(count: number, depth: number): Cbor {
    const entries: [string, Cbor][] = [];
    let previous: Uint8Array | null = null;

    for (let i = 0; i < count; i += 1) {
      const keyStart = this.pos;
      const { major, arg } = this.readHead();
      if (major !== 3) {
        throw new IdentiKeyError('malformed', 'map key must be a text string');
      }

      const key = this.decodeText(this.take(this.length(arg)));
      const encodedKey = this.data.subarray(keyStart, this.pos);

      // Strictly increasing encoded bytes: that is both "sorted" and "no duplicates".
      if (previous !== null && Buffer.compare(encodedKey, previous) <= 0) {
        throw new IdentiKeyError('malformed', 'map keys are not in canonical order, or are repeated');
      }

      previous = encodedKey;
      entries.push([key, this.readValue(depth + 1)]);
    }

    return { t: 'map', v: entries };
  }

  /** Read a head, refusing any argument that is not in its smallest form. */
  private readHead(): { major: number; arg: bigint } {
    const first = this.take(1)[0];
    const major = first >> 5;
    const info = first & 0x1f;

    if (info < 24) {
      return { major, arg: BigInt(info) };
    }

    const view = (size: number) => {
      const bytes = this.take(size);

      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };

    switch (info) {
      case 24: {
        const arg = BigInt(this.take(1)[0]);
        if (arg < 24n) {
          throw new IdentiKeyError('malformed', 'non-minimal integer (1-byte form)');
        }

        return { major, arg };
      }

      case 25: {
        const arg = BigInt(view(2).getUint16(0));
        if (arg <= 0xffn) {
          throw new IdentiKeyError('malformed', 'non-minimal integer (2-byte form)');
        }

        return { major, arg };
      }

      case 26: {
        const arg = BigInt(view(4).getUint32(0));
        if (arg <= 0xffffn) {
          throw new IdentiKeyError('malformed', 'non-minimal integer (4-byte form)');
        }

        return { major, arg };
      }

      case 27: {
        const arg = view(8).getBigUint64(0);
        if (arg <= 0xffff_ffffn) {
          throw new IdentiKeyError('malformed', 'non-minimal integer (8-byte form)');
        }

        return { major, arg };
      }

      default:
        throw new IdentiKeyError('malformed', 'indefinite-length or reserved encoding');
    }
  }

  /** A length or count that must fit in what is left of the input. */
  private length(arg: bigint): number {
    if (arg > BigInt(this.remaining)) {
      throw new IdentiKeyError('malformed', 'length runs past the end of the input');
    }

    return Number(arg);
  }

  private take(n: number): Uint8Array {
    if (n > this.remaining) {
      throw new IdentiKeyError('malformed', 'unexpected end of input');
    }

    const slice = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;

    return slice;
  }

  private decodeText(bytes: Uint8Array): string {
    try {
      return textDecoder.decode(bytes);
    } catch {
      throw new IdentiKeyError('malformed', 'invalid UTF-8');
    }
  }
}

// ─── reading values out ──────────────────────────────────────────────────────

function expect<T extends Cbor['t']>(value: Cbor, t: T): Extract<Cbor, { t: T }> {
  if (value.t !== t) {
    throw new IdentiKeyError('malformed', `expected ${t}, found ${value.t}`);
  }

  return value as Extract<Cbor, { t: T }>;
}

export const asUint = (value: Cbor): bigint => expect(value, 'uint').v;
export const asBytes = (value: Cbor): Uint8Array => expect(value, 'bytes').v;
export const asText = (value: Cbor): string => expect(value, 'text').v;
export const asArray = (value: Cbor): readonly Cbor[] => expect(value, 'array').v;

/** An unsigned integer that must also be exactly representable as a JS number. */
export function asSafeUint(value: Cbor): number {
  const v = asUint(value);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new IdentiKeyError('malformed', 'integer is too large');
  }

  return Number(v);
}

/**
 * A map with a CLOSED set of members: every `required` key present, nothing outside `required` and
 * `optional`. The Rust reference ignores members it does not know; this does not. A member nobody
 * defined is a place to hide data that no signature covers, and v1 messages have none.
 */
export function closedMap(
  value: Cbor,
  required: readonly string[],
  optional: readonly string[] = [],
): ReadonlyMap<string, Cbor> {
  const entries = expect(value, 'map').v;
  const allowed = new Set([...required, ...optional]);
  const out = new Map<string, Cbor>();

  for (const [key, item] of entries) {
    if (!allowed.has(key)) {
      throw new IdentiKeyError('malformed', `unknown member "${key}"`);
    }

    out.set(key, item);
  }

  for (const key of required) {
    if (!out.has(key)) {
      throw new IdentiKeyError('malformed', `missing member "${key}"`);
    }
  }

  return out;
}
