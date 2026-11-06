/**
 * The handler's transport-neutral request and response, and the small helpers that build them.
 *
 * `PwsRequest` is what an adapter (Nest, `node:http`, a test) hands over; `PwsResponse` is what it
 * writes back. Nothing here knows about a web framework, so the same handler serves the
 * conformance run, the unit tests and, later, a Nest controller.
 */

export interface PwsRequest {
  method: string;
  /** Absolute URL as the client addressed the server (scheme, host, path and query). */
  url: string;
  /** Header names are case-insensitive; repeated headers may be an array or comma-joined. */
  headers: Record<string, string | string[] | undefined>;
  body?: Uint8Array;
}

export interface PwsResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body?: Uint8Array;
}

const encoder = new TextEncoder();

export function jsonResponse(
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
  contentType = 'application/json',
): PwsResponse {
  return {
    status,
    headers: { 'content-type': contentType, ...headers },
    body: encoder.encode(JSON.stringify(value)),
  };
}

export function emptyResponse(status: number, headers: Record<string, string> = {}): PwsResponse {
  return { status, headers: { ...headers } };
}

/** Lowercases header names and joins repeated values, the shape the verifier works with. */
export function normalizeHeaders(headers: PwsRequest['headers']): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    normalized[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return normalized;
}

/** `application/json`, or any `+json` structured-syntax type (RFC 6839), with parameters ignored. */
export function isJsonMediaType(contentType: string): boolean {
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return mediaType === 'application/json' || /^[a-z0-9.+-]+\/[a-z0-9.+-]+\+json$/.test(mediaType);
}
