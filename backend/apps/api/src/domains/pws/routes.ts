/**
 * URL layout of a PWS server and the router that reads it back.
 *
 * A server may be mounted under a path (`https://example.com/pws/`), so every path in the
 * specification is relative to a configured base URL. The base is also the *only* source of the
 * origin this server believes it is serving: a capability's `invocationTarget` is compared with
 * the request URL as an exact string, so the origin is never taken from the request's `Host`.
 *
 * Canonical form (PWS "Reading This Document"): a container (a Space, a Collection) is written
 * with a trailing slash and everything else without. The other spelling is the same thing and is
 * answered with a `308` to the canonical one; a signed request has to be signed again for it.
 */
import { SPACE_RESERVED, isCollectionReserved, isSpaceReserved, isValidId } from './ids';

export class PwsUrls {
  readonly origin: string;
  /** Always begins and ends with `/`. */
  readonly basePath: string;
  /** `host[:port]`, as the `host` header must carry it. */
  readonly host: string;

  constructor(baseUrl: string) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new TypeError('baseUrl must be an http(s) URL');
    }
    if (url.search !== '' || url.hash !== '') {
      throw new TypeError('baseUrl must not carry a query or a fragment');
    }
    this.origin = url.origin;
    this.host = url.host;
    this.basePath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  }

  /** Root-relative path (begins with `/`, includes the mount path). */
  path(rel: string): string {
    return `${this.basePath}${rel}`;
  }

  url(rel: string): string {
    return `${this.origin}${this.path(rel)}`;
  }

  serviceUrl(): string {
    return this.url('service');
  }
  spacesUrl(): string {
    return this.url('spaces/');
  }
  spaceUrl(spaceId: string): string {
    return this.url(`space/${spaceId}/`);
  }
  collectionUrl(spaceId: string, collectionId: string): string {
    return this.url(`space/${spaceId}/${collectionId}/`);
  }
  resourceUrl(spaceId: string, collectionId: string, resourceId: string): string {
    return this.url(`space/${spaceId}/${collectionId}/${resourceId}`);
  }

  spacePath(spaceId: string): string {
    return this.path(`space/${spaceId}/`);
  }
  collectionPath(spaceId: string, collectionId: string): string {
    return this.path(`space/${spaceId}/${collectionId}/`);
  }
  resourcePath(spaceId: string, collectionId: string, resourceId: string): string {
    return this.path(`space/${spaceId}/${collectionId}/${resourceId}`);
  }
}

export type SpaceAuxiliary = 'meta' | 'linkset' | 'policy';
export type SpaceUnimplemented = Exclude<(typeof SPACE_RESERVED)[number], SpaceAuxiliary | 'collections'>;

export type Route =
  | { kind: 'root' }
  | { kind: 'service' }
  | { kind: 'spaces' }
  | { kind: 'space'; spaceId: string }
  | { kind: 'space-meta'; spaceId: string }
  | { kind: 'space-linkset'; spaceId: string }
  | { kind: 'space-policy'; spaceId: string }
  | { kind: 'space-optional'; spaceId: string; segment: SpaceUnimplemented }
  | { kind: 'collection'; spaceId: string; collectionId: string }
  | { kind: 'collection-meta'; spaceId: string; collectionId: string }
  | { kind: 'collection-meta-log'; spaceId: string; collectionId: string }
  | { kind: 'collection-linkset'; spaceId: string; collectionId: string }
  | { kind: 'collection-policy'; spaceId: string; collectionId: string }
  | {
      kind: 'collection-optional';
      spaceId: string;
      collectionId: string;
      segment: 'backend' | 'quota' | 'query';
    }
  | { kind: 'resource'; spaceId: string; collectionId: string; resourceId: string }
  | { kind: 'resource-meta'; spaceId: string; collectionId: string; resourceId: string }
  | { kind: 'resource-policy'; spaceId: string; collectionId: string; resourceId: string }
  /** `.../{r}/chunks/` (the list, `chunk` absent) or `.../{r}/chunks/{chunk}`: the PWS-EC group this server lacks. */
  | { kind: 'resource-chunks'; spaceId: string; collectionId: string; resourceId: string; chunk?: string }
  /**
   * The retired v0.4 `/space/{s}/collections` endpoint. Its segment stays reserved; the operations that
   * moved to the Space URL (list, add) may be redirected there, and no other method is defined.
   */
  | { kind: 'retired-collections'; spaceId: string; location: string }
  /** The other spelling of a canonical URL: `location` is root-relative. */
  | { kind: 'redirect'; location: string }
  /** A path segment in an id position that is not a legal id (400 `invalid-id`). */
  | { kind: 'invalid-id'; level: 'space' | 'collection' | 'resource' }
  | { kind: 'unknown' };

/**
 * Parses an absolute request URL. Never throws: anything that is not a route of this server is
 * `unknown`, which the handler answers with a bare 404 (it names no target, so it leaks nothing).
 */
export function parseRoute(urls: PwsUrls, requestUrl: string): Route {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { kind: 'unknown' };
  }
  if (url.origin !== urls.origin || !url.pathname.startsWith(urls.basePath)) {
    return { kind: 'unknown' };
  }
  // `new URL` resolves `.` and `..` (also `%2e`), reads `\` as `/` and drops tabs and newlines. Route only a
  // path the parser leaves alone, so that what is routed, what is signed and what a capability's target is
  // compared with are always the same string: `/space/s/c1/../c2/x` must never be served as `/space/s/c2/x`
  // under a grant for `c1`.
  const rawPath = requestUrl.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/, '').split(/[?#]/, 1)[0];
  if (rawPath !== url.pathname) {
    return { kind: 'unknown' };
  }

  const rel = url.pathname.slice(urls.basePath.length);
  const search = url.search;
  // A root-relative reference (RFC 9110 allows one): it keeps the mount path and the query, and a
  // client has to sign again for the target either way.
  const redirect = (canonical: string): Route => ({
    kind: 'redirect',
    location: `${canonical.slice(urls.origin.length)}${search}`,
  });

  if (rel === '') {
    return { kind: 'root' };
  }

  const segments = rel.split('/');
  const trailingSlash = segments[segments.length - 1] === '';
  if (trailingSlash) {
    segments.pop();
  }
  // An empty segment in the middle (`//`) or any percent-escape cannot be an id this server hands out.
  if (segments.some((segment) => segment === '' || segment.includes('%'))) {
    return { kind: 'unknown' };
  }

  const [head, spaceId, second, third, fourth, fifth] = segments;

  if (head === 'service' && segments.length === 1) {
    return trailingSlash ? redirect(urls.serviceUrl()) : { kind: 'service' };
  }
  if (head === 'spaces' && segments.length === 1) {
    return trailingSlash ? { kind: 'spaces' } : redirect(urls.spacesUrl());
  }
  if (head !== 'space' || spaceId === undefined) {
    return { kind: 'unknown' };
  }
  if (!isValidId(spaceId)) {
    return { kind: 'invalid-id', level: 'space' };
  }

  // /space/{s}
  if (second === undefined) {
    return trailingSlash ? { kind: 'space', spaceId } : redirect(urls.spaceUrl(spaceId));
  }

  // /space/{s}/{x} where x is reserved or a Collection id
  if (third === undefined) {
    if (isSpaceReserved(second)) {
      if (second === 'collections') {
        return {
          kind: 'retired-collections',
          spaceId,
          location: `${urls.spaceUrl(spaceId).slice(urls.origin.length)}${search}`,
        };
      }
      if (trailingSlash) {
        return redirect(urls.url(`space/${spaceId}/${second}`));
      }
      if (second === 'meta' || second === 'linkset' || second === 'policy') {
        return { kind: `space-${second}`, spaceId };
      }
      return { kind: 'space-optional', spaceId, segment: second };
    }
    if (!isValidId(second)) {
      return { kind: 'invalid-id', level: 'collection' };
    }
    return trailingSlash
      ? { kind: 'collection', spaceId, collectionId: second }
      : redirect(urls.collectionUrl(spaceId, second));
  }

  if (isSpaceReserved(second)) {
    // Nothing is defined beneath a Space-level reserved segment.
    return { kind: 'unknown' };
  }
  if (!isValidId(second)) {
    return { kind: 'invalid-id', level: 'collection' };
  }
  const collectionId = second;

  // /space/{s}/{c}/{y} where y is reserved or a Resource id
  if (fourth === undefined) {
    if (isCollectionReserved(third)) {
      if (trailingSlash) {
        return redirect(urls.url(`space/${spaceId}/${collectionId}/${third}`));
      }
      if (third === 'meta' || third === 'linkset' || third === 'policy') {
        return { kind: `collection-${third}`, spaceId, collectionId };
      }
      return { kind: 'collection-optional', spaceId, collectionId, segment: third };
    }
    if (!isValidId(third)) {
      return { kind: 'invalid-id', level: 'resource' };
    }
    return trailingSlash
      ? redirect(urls.resourceUrl(spaceId, collectionId, third))
      : { kind: 'resource', spaceId, collectionId, resourceId: third };
  }

  // /space/{s}/{c}/meta/log (the governing history log, an optional group this server lacks)
  if (third === 'meta' && fourth === 'log' && fifth === undefined) {
    return trailingSlash
      ? redirect(urls.url(`space/${spaceId}/${collectionId}/meta/log`))
      : { kind: 'collection-meta-log', spaceId, collectionId };
  }
  if (isCollectionReserved(third)) {
    return { kind: 'unknown' };
  }
  if (!isValidId(third)) {
    return { kind: 'invalid-id', level: 'resource' };
  }
  const resourceId = third;

  // /space/{s}/{c}/{r}/{z}
  if (fourth === 'meta' || fourth === 'policy') {
    if (fifth !== undefined) {
      return { kind: 'unknown' };
    }
    return trailingSlash
      ? redirect(urls.url(`space/${spaceId}/${collectionId}/${resourceId}/${fourth}`))
      : { kind: `resource-${fourth}`, spaceId, collectionId, resourceId };
  }
  if (fourth === 'chunks') {
    if (fifth === undefined) {
      return { kind: 'resource-chunks', spaceId, collectionId, resourceId };
    }
    if (segments.length === 6 && isValidId(fifth)) {
      return { kind: 'resource-chunks', spaceId, collectionId, resourceId, chunk: fifth };
    }
  }
  return { kind: 'unknown' };
}
