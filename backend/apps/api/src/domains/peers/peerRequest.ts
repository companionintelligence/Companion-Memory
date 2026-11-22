import { type RawBodyRequest } from '@ci/common/middleware/BodyParserMiddleware';

import { SignatureFormatError, parseSignatureHeaders } from './httpSignature';

/*
 * What every `/agent/v1` controller needs to read a peer request the same way:
 * the signed `@target-uri` is rebuilt from this box's published base, never from
 * `Host`, and the body is read from the exact bytes a digest covers.
 */

/** The path every peer route is served under, as this process receives it. */
export const PEER_ROUTE_PREFIX = '/agent/v1';

/**
 * This box's published `/agent/v1` base: the origin and path of
 * `peers.memoryEndpoint`, with no trailing slash, query or fragment.
 *
 * Peers sign `${memoryEndpoint}/ask` (and `${memoryEndpoint}/ask/<correlation>`
 * to collect): `PeerAskClient` signs the very URL it dials. Behind Companion
 * Memory's gateway the base is `https://<host>/api/agent/v1`, and the gateway
 * strips `/api` before proxying, so this process sees `/agent/v1/...` and the
 * prefix survives only in config. The authority and any path prefix therefore
 * come from config, never from `Host` or a forwarded header: a server behind a
 * reverse proxy has to know the original request URI to use `@target-uri`
 * (RFC 9421 section 1.4), and a header says whatever the caller wrote.
 *
 * Returns null for anything empty or unparseable, and for a URL with no origin
 * of its own (`mailto:` and the like), which the caller turns into a refusal
 * rather than a guess.
 */
export function publishedBase(endpoint: string | undefined): string | null {
  const trimmed = endpoint?.trim();
  if (!trimmed) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  // `URL.origin` is the string 'null' for a scheme with an opaque origin.
  if (url.origin === 'null') {
    return null;
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * The `@target-uri` a peer signed, rebuilt from this box's {@link publishedBase}
 * and the path the route `received`; null when that path is outside
 * `/agent/v1`.
 *
 * A base that ends in `/agent/v1` (`https://<host>/api/agent/v1` behind the
 * gateway, `https://<host>/agent/v1` in front of the API itself) is followed by
 * whatever was received after `/agent/v1`. Any other base, such as an endpoint
 * published at the bare origin, is read as its origin plus the path received,
 * as before.
 */
export function signedTargetUri(base: string, received: string): string | null {
  const onPeerRoute =
    received === PEER_ROUTE_PREFIX ||
    received.startsWith(`${PEER_ROUTE_PREFIX}/`) ||
    received.startsWith(`${PEER_ROUTE_PREFIX}?`);
  if (!onPeerRoute) {
    return null;
  }

  const url = new URL(base);
  if (url.pathname.endsWith(PEER_ROUTE_PREFIX)) {
    return `${base}${received.slice(PEER_ROUTE_PREFIX.length)}`;
  }

  return `${url.origin}${received}`;
}

/**
 * The JSON value in the bytes this box kept for the request; undefined when it
 * kept none, or they are empty or not JSON, which the ask schema then refuses
 * as a malformed ask.
 */
export function parseRawJson(raw: string | undefined): unknown {
  if (raw == null || raw.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The keyid a request's signature names, unverified; null when there is none to read. */
export function claimedKeyId(request: RawBodyRequest): string | null {
  if (request.headers['signature-input'] == null) {
    return null;
  }

  try {
    return parseSignatureHeaders(header(request, 'signature-input'), header(request, 'signature')).params
      .keyid;
  } catch (error) {
    if (error instanceof SignatureFormatError) {
      return null;
    }

    throw error;
  }
}

/** Read a single-valued header, dropping the array form express allows. */
export function header(request: RawBodyRequest, name: string): string | undefined {
  const value = request.headers[name];

  return typeof value === 'string' ? value : undefined;
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const [scheme, value] = header.split(' ');

  return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
}
