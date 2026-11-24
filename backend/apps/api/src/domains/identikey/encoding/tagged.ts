import { IdentiKeyError } from '../errors';

/**
 * The `b64:<base64>` text form for blobs too big for base58: signatures, ML-DSA keys, ciphertexts.
 *
 * IdentiKey's conventions (`encoding-conventions.md` §5.1) accept ONE tagged form in both directions
 * and reject an untagged string rather than guessing. The reasons carry over: a decoder that guesses
 * the encoding is a decoder with two parsers, and the second one is where the unbounded work hides.
 * Standard RFC 4648 base64 WITH padding, and nothing else: no URL-safe alphabet, no missing `=`, no
 * embedded whitespace.
 */
const PREFIX = 'b64:';

/** Standard base64 with padding, and nothing but the alphabet. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function encodeTagged(bytes: Uint8Array): string {
  return `${PREFIX}${Buffer.from(bytes).toString('base64')}`;
}

/**
 * Decode `b64:<base64>`.
 *
 * `maxBytes` is required: every caller knows how big the thing it expects can be, and a decoder with
 * no ceiling is the shape of the bug this convention was written to prevent.
 */
export function decodeTagged(text: string, maxBytes: number): Uint8Array {
  if (!text.startsWith(PREFIX)) {
    throw new IdentiKeyError('malformed', `expected "${PREFIX}<base64>"`);
  }

  const body = text.slice(PREFIX.length);
  // Four characters become at most three bytes, so this bounds the work before any is done.
  if (body.length > Math.ceil(maxBytes / 3) * 4) {
    throw new IdentiKeyError('malformed', `base64 body is over the ${maxBytes} byte limit`);
  }

  if (!BASE64.test(body)) {
    throw new IdentiKeyError('malformed', 'not standard padded base64');
  }

  const bytes = Buffer.from(body, 'base64');
  if (bytes.length > maxBytes) {
    throw new IdentiKeyError('malformed', `base64 body is over the ${maxBytes} byte limit`);
  }

  // Padding bits that are not zero are a second spelling of the same bytes; refuse it.
  if (bytes.toString('base64') !== body) {
    throw new IdentiKeyError('malformed', 'base64 is not canonical');
  }

  return new Uint8Array(bytes);
}
