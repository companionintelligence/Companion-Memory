import { digestHeaderValue } from './digest';
import type { Signer } from './ed25519';
import { base64Decode, base64Encode, MultibaseError } from './multibase';

/**
 * HTTP Signatures as the Portable Web Spaces authorization profile (PWS-AUTHZ) uses them: the Cavage draft-12
 * `Authorization: Signature ...` header, covering the pseudo-headers `(key-id) (created) (expires)
 * (request-target)` plus `host` and `capability-invocation`, and `content-type` and `digest` when the request has
 * a body.
 *
 * NOTE ON `(key-id)`: PWS-AUTHZ calls it a draft-12 pseudo-header, but draft-12 defines only `(request-target)`,
 * `(created)` and `(expires)`. `(key-id)` comes from the Digital Bazaar lineage of libraries
 * (`http-signature-header`), whose signing string is `(key-id): <keyId>`. That is what the reference
 * implementations exchange, so that is what interoperates, and it is what is built here.
 *
 * What the specs pin: the grammar rules below and the signing-string layout of the worked example printed in
 * PWS-AUTHZ (`httpSignature.spec.ts`; the signature printed in that example is illustrative and does not verify,
 * which that spec records), and, in `referenceVectors.spec.ts`, the headers `@interop/http-signature-zcap-invoke`
 * produces for fixed requests (generated 2026-11-05). This file parses, builds and signs.
 * Verification of the signature, the DID that holds the key and the capability named in the header is the
 * authorization layer's job.
 *
 * Grammar: `Signature` then comma-separated `name="value"` parameters, where `created` and `expires` may also be bare
 * integers. Unknown parameters are ignored, duplicates and malformed syntax are refused, and so are quoted-pair escapes
 * (nothing a key id or a base64 signature needs). `expires` must be an integer: draft-12 allows a decimal there, and no
 * implementation emits one.
 */

export class HttpSignatureError extends Error {
  constructor(
    message: string,
    readonly kind: 'syntax' | 'constraint',
  ) {
    super(message);
    this.name = 'HttpSignatureError';
  }
}

export interface ParsedSignature {
  keyId: string;
  /** Covered header names, lowercased, in signing order. */
  headers: string[];
  signature: Uint8Array;
  created?: number;
  expires?: number;
  algorithm?: string;
}

const PSEUDO_HEADERS: ReadonlySet<string> = new Set([
  '(key-id)',
  '(created)',
  '(expires)',
  '(request-target)',
]);
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
const KNOWN_PARAMETERS: ReadonlySet<string> = new Set([
  'keyId',
  'algorithm',
  'headers',
  'signature',
  'created',
  'expires',
]);
const MAX_INTEGER_DIGITS = 15;

function syntax(message: string): HttpSignatureError {
  return new HttpSignatureError(message, 'syntax');
}

function parseParameters(text: string): Map<string, string> {
  const parameters = new Map<string, string>();
  let i = 0;
  const skipSpaces = (): void => {
    while (text.charAt(i) === ' ' || text.charAt(i) === '\t') {
      i++;
    }
  };

  skipSpaces();
  while (i < text.length) {
    const nameStart = i;
    while (/[A-Za-z]/.test(text.charAt(i))) {
      i++;
    }
    const name = text.slice(nameStart, i);
    if (name === '' || text.charAt(i) !== '=') {
      throw syntax('malformed signature parameter');
    }
    i++;

    let value: string;
    if (text.charAt(i) === '"') {
      const close = text.indexOf('"', i + 1);
      if (close === -1) {
        throw syntax('unterminated quoted signature parameter');
      }
      value = text.slice(i + 1, close);
      if (value.includes('\\')) {
        throw syntax('quoted-pair escapes are not accepted in signature parameters');
      }
      i = close + 1;
    } else if (name === 'created' || name === 'expires') {
      const start = i;
      while (/[0-9]/.test(text.charAt(i))) {
        i++;
      }
      value = text.slice(start, i);
      if (value === '') {
        throw syntax(`the ${name} parameter is empty`);
      }
    } else {
      throw syntax(`the ${name} parameter must be quoted`);
    }

    if (parameters.has(name)) {
      throw syntax(`duplicate ${name} parameter`);
    }
    parameters.set(name, value);

    skipSpaces();
    if (i === text.length) {
      break;
    }
    if (text.charAt(i) !== ',') {
      throw syntax('signature parameters are separated by commas');
    }
    i++;
    skipSpaces();
    if (i === text.length) {
      throw syntax('trailing comma in signature parameters');
    }
  }

  return parameters;
}

function parseInteger(name: string, text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (!/^[0-9]+$/.test(text) || text.length > MAX_INTEGER_DIGITS) {
    throw syntax(`the ${name} parameter must be a Unix timestamp in whole seconds`);
  }

  return Number(text);
}

/** Parses the value of an `Authorization: Signature ...` header. Throws `HttpSignatureError('syntax')`. */
export function parseAuthorizationSignature(value: string): ParsedSignature {
  const space = value.indexOf(' ');
  if (space === -1 || value.slice(0, space).toLowerCase() !== 'signature') {
    throw syntax('the Authorization scheme must be Signature');
  }
  const parameters = parseParameters(value.slice(space + 1));

  for (const name of parameters.keys()) {
    if (!KNOWN_PARAMETERS.has(name)) {
      parameters.delete(name);
    }
  }

  const keyId = parameters.get('keyId');
  if (keyId === undefined || keyId === '') {
    throw syntax('keyId is required');
  }
  const signatureText = parameters.get('signature');
  if (signatureText === undefined || signatureText === '') {
    throw syntax('signature is required');
  }
  let signature: Uint8Array;
  try {
    signature = base64Decode(signatureText);
  } catch (error) {
    if (error instanceof MultibaseError) {
      throw syntax('signature is not strict base64');
    }
    throw error;
  }

  const headersText = parameters.get('headers');
  let headers: string[];
  if (headersText === undefined) {
    headers = ['(created)'];
  } else {
    if (headersText === '') {
      throw syntax('headers must not be empty');
    }
    headers = headersText.split(' ').map((name) => name.toLowerCase());
    for (const name of headers) {
      if (!(PSEUDO_HEADERS.has(name) || HEADER_NAME.test(name))) {
        throw syntax(`"${name}" is not a header name this profile signs`);
      }
    }
    if (new Set(headers).size !== headers.length) {
      throw syntax('headers lists a name twice');
    }
  }

  const parsed: ParsedSignature = { keyId, headers, signature };
  const created = parseInteger('created', parameters.get('created'));
  if (created !== undefined) {
    parsed.created = created;
  }
  const expires = parseInteger('expires', parameters.get('expires'));
  if (expires !== undefined) {
    parsed.expires = expires;
  }
  const algorithm = parameters.get('algorithm');
  if (algorithm !== undefined) {
    parsed.algorithm = algorithm.toLowerCase();
  }

  return parsed;
}

/**
 * The string an HTTP signature covers. `host` comes from the URL (as the reference implementations do), so a
 * caller that also wants the `Host` header to match checks that itself. `requestHeaders` keys are lowercase.
 */
export function buildSigningString(args: {
  headers: readonly string[];
  keyId: string;
  created?: number;
  expires?: number;
  method: string;
  url: string;
  requestHeaders: Readonly<Record<string, string>>;
}): string {
  let url: URL;
  try {
    url = new URL(args.url);
  } catch {
    throw syntax('the request URL must be absolute');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw syntax('the request URL must be http or https');
  }

  const lines: string[] = [];
  for (const name of args.headers) {
    switch (name) {
      case '(key-id)':
        lines.push(`(key-id): ${args.keyId}`);
        break;
      case '(created)':
      case '(expires)': {
        const value = name === '(created)' ? args.created : args.expires;
        if (value === undefined) {
          throw syntax(`${name} is covered but the signature has no such parameter`);
        }
        lines.push(`${name}: ${value}`);
        break;
      }
      case '(request-target)':
        lines.push(`(request-target): ${args.method.toLowerCase()} ${url.pathname}${url.search}`);
        break;
      case 'host':
        lines.push(`host: ${url.host}`);
        break;
      default: {
        if (name.startsWith('(')) {
          throw syntax(`unknown pseudo-header ${name}`);
        }
        const value = args.requestHeaders[name];
        if (value === undefined) {
          throw syntax(`the covered header ${name} is not in the request`);
        }
        if (/[\r\n]/.test(value)) {
          throw syntax(`the covered header ${name} holds a line break`);
        }
        lines.push(`${name}: ${value.trim()}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Refuses a signature made in the future or already expired, each with `skewSeconds` of tolerance. A signature
 * whose `expires` is before its `created` is refused too.
 */
export function checkSignatureWindow(
  parsed: Pick<ParsedSignature, 'created' | 'expires'>,
  nowSeconds: number,
  skewSeconds: number,
): void {
  const { created, expires } = parsed;
  if (created !== undefined && created > nowSeconds + skewSeconds) {
    throw new HttpSignatureError('the signature was created in the future', 'constraint');
  }
  if (expires !== undefined && expires < nowSeconds - skewSeconds) {
    throw new HttpSignatureError('the signature has expired', 'constraint');
  }
  if (created !== undefined && expires !== undefined && expires < created) {
    throw new HttpSignatureError('the signature expires before it was created', 'constraint');
  }
}

const BASE_COVERED = [
  '(key-id)',
  '(created)',
  '(expires)',
  '(request-target)',
  'host',
  'capability-invocation',
];

/**
 * Signs a request. Returns every header to send, lowercased: the caller's own, plus `host` (from the URL),
 * `capability-invocation`, `authorization` and, when there is a body, `digest`. The caller supplies `content-type`
 * with a body, and none without one. `capabilityInvocation` is the whole header value, e.g.
 * `zcap id="urn:zcap:root:...",action="GET"`.
 */
export async function signRequest(args: {
  method: string;
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
  signer: Signer;
  created: number;
  expires?: number;
  capabilityInvocation: string;
}): Promise<Record<string, string>> {
  const { method, url, body, signer, created, capabilityInvocation } = args;
  const expires = args.expires ?? created + 600;
  if (/["\\\r\n]/.test(signer.id) || /[\r\n]/.test(capabilityInvocation)) {
    throw new TypeError(
      'a key id or capability invocation header may not hold a quote, backslash or line break',
    );
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(args.headers)) {
    headers[name.toLowerCase()] = value;
  }
  headers['host'] = new URL(url).host;
  headers['capability-invocation'] = capabilityInvocation;

  const covered = [...BASE_COVERED];
  if (body !== undefined) {
    if (headers['content-type'] === undefined) {
      throw new TypeError('a request with a body needs a content-type');
    }
    headers['digest'] = digestHeaderValue(body);
    covered.push('content-type', 'digest');
  } else if (headers['content-type'] !== undefined) {
    throw new TypeError('a content-type without a body would not be covered by the signature');
  }

  const signingString = buildSigningString({
    headers: covered,
    keyId: signer.id,
    created,
    expires,
    method,
    url,
    requestHeaders: headers,
  });
  const signature = base64Encode(await signer.sign(new TextEncoder().encode(signingString)));

  headers['authorization'] =
    `Signature keyId="${signer.id}",headers="${covered.join(' ')}",signature="${signature}",` +
    `created="${created}",expires="${expires}"`;

  return headers;
}
