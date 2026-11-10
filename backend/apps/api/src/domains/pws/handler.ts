/**
 * The Portable Web Spaces request handler: one function from `PwsRequest` to `PwsResponse`.
 *
 * `createPwsHandler()` wires the pieces in the order the specification needs them:
 *
 *   1. route the URL (a bad id, an unknown path, the other spelling of a canonical URL);
 *   2. refuse a method the endpoint lacks (`405`, before anything that depends on state, so the
 *      answer is the same whether or not the Space exists);
 *   3. verify the signature layer of any credential (`authn.ts`: failures here describe the request);
 *   4. open one store transaction and run the operation, which authorizes first and validates after.
 *
 * It decorates every response with the `Link: <service>; rel="service"` header the specification
 * requires on all of them, errors and redirects included, and with CORS and hardening headers.
 *
 * Nothing here is registered with Nest or bound to a port. `docs/pws.md` says how it is meant to be wired.
 */
import { SIGNATURE_CHALLENGE, authenticate } from './authn';
import type { NormalizedRequest } from './authn';
import { OpContext } from './context';
import type { HandlerEnv } from './context';
import { emptyResponse, jsonResponse, normalizeHeaders } from './http';
import type { PwsRequest, PwsResponse } from './http';
import { generateId } from './ids';
import { DidRegistry, didKeyMethod } from './keys';
import type { DidMethodSupport } from './keys';
import { linksetEndpoint, policyEndpoint, serviceDescriptionResponse, unimplementedGroup } from './opsAux';
import {
  deleteCollection,
  listResources,
  putCollection,
  readCollection,
  createCollection,
} from './opsCollection';
import {
  createResource,
  deleteResource,
  putResource,
  putResourceMeta,
  readResource,
  readResourceMeta,
} from './opsResource';
import { createSpace, deleteSpace, listCollections, listSpaces, putSpace, readSpace } from './opsSpace';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './pagination';
import { PwsError, methodNotAllowed, notFound } from './problems';
import { PwsUrls, parseRoute } from './routes';
import type { Route } from './routes';
import { serviceLink } from './serviceDescription';
import type { InstanceDisclosure } from './serviceDescription';
import { StampClock } from './stamp';
import type { PwsStore } from './store';
import { DEFAULT_MAX_CHAIN_LENGTH } from './zcap';

export interface PwsConfig {
  /**
   * The URL this server is addressed at, e.g. `https://example.com/` or `https://example.com/pws/`.
   * A capability's invocation target is compared with the request URL as a string, so this must be
   * byte-identical to what clients use; the origin is never taken from the request's `Host`.
   */
  baseUrl: string;
  store: PwsStore;
  /** DID methods understood for controllers and signers. Default: `did:key` only. */
  didMethods?: readonly DidMethodSupport[];
  now?: () => Date;
  generateId?: () => string;
  /** Names this store in write stamps (`[A-Za-z0-9_-]{1,64}`); default: random per handler. Keep it stable for a store. */
  originId?: string;
  maxClockSkewSeconds?: number;
  maxChainLength?: number;
  maxSignatureLifetimeSeconds?: number;
  maxUploadBytes?: number;
  maxJsonBytes?: number;
  pageDefaultLimit?: number;
  pageMaxLimit?: number;
  /** Whether a delegated capability has been withdrawn (the hook a grant store plugs into). */
  isRevoked?: (capabilityId: string) => Promise<boolean>;
  instance?: InstanceDisclosure;
  /** `Access-Control-Allow-Origin`; default `*`, safe because nothing here uses cookies. */
  corsAllowOrigin?: string;
  /** `Content-Security-Policy` on Resource content; default `sandbox`; `null` sends none. */
  resourceContentSecurityPolicy?: string | null;
  /** Called with anything that is not a `PwsError`, before it becomes a generic 500. */
  onError?: (error: unknown) => void;
}

export interface PwsHandler {
  handle(request: PwsRequest): Promise<PwsResponse>;
  /**
   * Adds the headers every response carries (the service `Link`, CORS, `nosniff`, `Cache-Control`) to a
   * response the handler did not make, such as a transport's own `413` for an oversized body.
   */
  decorate(method: string, response: PwsResponse): PwsResponse;
  readonly urls: PwsUrls;
}

const READ = ['GET', 'HEAD'] as const;

/**
 * The methods an endpoint defines. A request with any other method is `405` with an `Allow` header,
 * answered before anything that depends on state (authorization, existence), so the answer is the
 * same whether or not the Space exists. For an endpoint of an optional group this server does not
 * implement, the methods listed are the group's own: those reach authorization and then `501`.
 */
function allowedMethods(route: Route): readonly string[] | undefined {
  switch (route.kind) {
    case 'root':
    case 'service':
    case 'space-linkset':
    case 'collection-linkset':
      return READ;
    case 'spaces':
      return [...READ, 'POST'];
    case 'space':
    case 'collection':
      return [...READ, 'POST', 'DELETE'];
    case 'space-meta':
    case 'collection-meta':
    case 'resource-meta':
      return [...READ, 'PUT'];
    case 'space-policy':
    case 'collection-policy':
    case 'resource-policy':
    case 'resource':
      return [...READ, 'PUT', 'DELETE'];
    case 'retired-collections':
      return [...READ, 'POST'];
    case 'space-optional':
      return route.segment === 'backends' || route.segment === 'quotas' ? READ : ['POST'];
    case 'collection-optional':
      return route.segment === 'query' ? ['POST'] : READ;
    case 'collection-meta-log':
      return [...READ, 'PUT'];
    case 'resource-chunks':
      return route.chunk === undefined ? READ : [...READ, 'PUT', 'DELETE'];
    default:
      return undefined;
  }
}

const CORS_ALLOW_HEADERS =
  'authorization, capability-invocation, content-type, digest, if-match, if-none-match, key-epoch, writer-id';

export function createPwsHandler(config: PwsConfig): PwsHandler {
  const urls = new PwsUrls(config.baseUrl);
  const env: HandlerEnv = {
    urls,
    keys: new DidRegistry(config.didMethods ?? [didKeyMethod]),
    store: config.store,
    now: config.now ?? (() => new Date()),
    generateId: config.generateId ?? generateId,
    clock: new StampClock(config.originId),
    skewSeconds: config.maxClockSkewSeconds ?? 300,
    maxChainLength: config.maxChainLength ?? DEFAULT_MAX_CHAIN_LENGTH,
    maxSignatureLifetimeSeconds: config.maxSignatureLifetimeSeconds ?? 3600,
    maxUploadBytes: config.maxUploadBytes ?? 25 * 1024 * 1024,
    maxJsonBytes: config.maxJsonBytes ?? 1024 * 1024,
    page: {
      defaultLimit: config.pageDefaultLimit ?? DEFAULT_PAGE_LIMIT,
      maxLimit: config.pageMaxLimit ?? MAX_PAGE_LIMIT,
    },
    ...(config.isRevoked ? { isRevoked: config.isRevoked } : {}),
    ...(config.instance ? { instance: config.instance } : {}),
    corsAllowOrigin: config.corsAllowOrigin ?? '*',
    resourceContentSecurityPolicy:
      config.resourceContentSecurityPolicy === undefined ? 'sandbox' : config.resourceContentSecurityPolicy,
  };
  const link = serviceLink(urls);

  function problem(error: PwsError): PwsResponse {
    const headers =
      error.status === 401
        ? { 'www-authenticate': SIGNATURE_CHALLENGE, ...error.headers }
        : { ...error.headers };

    return jsonResponse(error.status, error.toProblem(), headers, 'application/problem+json');
  }

  function toResponse(error: unknown): PwsResponse {
    if (error instanceof PwsError) {
      return problem(error);
    }

    config.onError?.(error);

    return problem(new PwsError('internal-error', 'The request could not be completed.'));
  }

  function decorate(requestMethod: string, response: PwsResponse): PwsResponse {
    const headers: Record<string, string> = { ...response.headers };
    headers.link = link;
    headers['access-control-expose-headers'] = 'Link, ETag, Location, Allow, WWW-Authenticate';
    headers['access-control-allow-origin'] ??= env.corsAllowOrigin;
    headers['x-content-type-options'] = 'nosniff';
    const method = requestMethod.toUpperCase();
    if (!('cache-control' in headers)) {
      headers['cache-control'] = 'no-store';
    }

    let body = response.body;
    if (method === 'HEAD') {
      if (body && headers['content-length'] === undefined) {
        headers['content-length'] = String(body.byteLength);
      }

      body = undefined;
    }

    return { status: response.status, headers, ...(body ? { body } : {}) };
  }

  async function run(route: Route, ctx: OpContext): Promise<PwsResponse> {
    const read = ctx.method === 'GET' || ctx.method === 'HEAD';
    switch (route.kind) {
      case 'spaces':
        return read ? listSpaces(ctx) : createSpace(ctx);
      case 'space':
        if (read) {
          return listCollections(ctx, route.spaceId);
        }

        return ctx.method === 'POST' ? createCollection(ctx, route.spaceId) : deleteSpace(ctx, route.spaceId);
      case 'space-meta':
        return read ? readSpace(ctx, route.spaceId) : putSpace(ctx, route.spaceId);
      case 'space-linkset':
        return linksetEndpoint(ctx, route.spaceId);
      case 'space-policy':
        return policyEndpoint(ctx, { spaceId: route.spaceId });
      case 'space-optional':
        return unimplementedGroup(ctx, route.spaceId);
      case 'collection':
        if (read) {
          return listResources(ctx, route.spaceId, route.collectionId);
        }

        return ctx.method === 'POST'
          ? createResource(ctx, route.spaceId, route.collectionId)
          : deleteCollection(ctx, route.spaceId, route.collectionId);
      case 'collection-meta':
        return read
          ? readCollection(ctx, route.spaceId, route.collectionId)
          : putCollection(ctx, route.spaceId, route.collectionId);
      case 'collection-linkset':
        return linksetEndpoint(ctx, route.spaceId, route.collectionId);
      case 'collection-policy':
        return policyEndpoint(ctx, { spaceId: route.spaceId, collectionId: route.collectionId });
      case 'collection-meta-log':
        return unimplementedGroup(ctx, route.spaceId, route.collectionId);
      case 'collection-optional':
        return unimplementedGroup(ctx, route.spaceId, route.collectionId, {
          queryProfile: route.segment === 'query',
        });
      case 'resource':
        if (read) {
          return readResource(ctx, route.spaceId, route.collectionId, route.resourceId);
        }

        return ctx.method === 'PUT'
          ? putResource(ctx, route.spaceId, route.collectionId, route.resourceId)
          : deleteResource(ctx, route.spaceId, route.collectionId, route.resourceId);
      case 'resource-meta':
        return read
          ? readResourceMeta(ctx, route.spaceId, route.collectionId, route.resourceId)
          : putResourceMeta(ctx, route.spaceId, route.collectionId, route.resourceId);
      case 'resource-policy':
        return policyEndpoint(ctx, {
          spaceId: route.spaceId,
          collectionId: route.collectionId,
          resourceId: route.resourceId,
        });
      case 'resource-chunks':
        return unimplementedGroup(ctx, route.spaceId, route.collectionId);
      default:
        throw notFound();
    }
  }

  async function dispatch(request: PwsRequest): Promise<PwsResponse> {
    const method = request.method.toUpperCase();
    if (method === 'OPTIONS') {
      return emptyResponse(204, {
        'access-control-allow-methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': CORS_ALLOW_HEADERS,
        'access-control-max-age': '600',
      });
    }

    const route = parseRoute(urls, request.url);
    switch (route.kind) {
      case 'unknown':
        throw notFound();
      case 'invalid-id':
        throw new PwsError('invalid-id', `The ${route.level} identifier in the URL is not URL-safe.`);
      case 'redirect':
        return emptyResponse(308, { location: route.location });
      default:
    }

    const allowed = allowedMethods(route);
    if (allowed && !allowed.includes(method)) {
      const refusal = methodNotAllowed(allowed);

      return jsonResponse(refusal.status, refusal.body, refusal.headers, 'application/problem+json');
    }

    if (route.kind === 'retired-collections') {
      // Only the operations that moved to the Space URL (list, add) follow it there. DELETE of this
      // path must never become a delete of the Space, so every other method was refused above.
      return emptyResponse(308, { location: route.location });
    }

    const req: NormalizedRequest = {
      method,
      url: request.url,
      headers: normalizeHeaders(request.headers),
      body: request.body ?? new Uint8Array(),
    };

    if (route.kind === 'root') {
      return jsonResponse(200, { service: urls.serviceUrl() });
    }

    if (route.kind === 'service') {
      return serviceDescriptionResponse(env, req);
    }

    const now = env.now();
    const authn = await authenticate(req, {
      urls,
      keys: env.keys,
      now,
      skewSeconds: env.skewSeconds,
      maxSignatureLifetimeSeconds: env.maxSignatureLifetimeSeconds,
    });
    // An anonymous write is `401`, whatever the target: the answer does not depend on anything stored,
    // so it tells the caller to authenticate and nothing about what exists. (A signed caller who lacks
    // privilege gets the masked `404`; an anonymous read is a `404` unless a policy makes it public.)
    if (authn.kind === 'anonymous' && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
      throw new PwsError('missing-authorization', 'This operation requires a capability invocation.');
    }

    return env.store.transaction((tx) => run(route, new OpContext(env, tx, req, route, authn, now)));
  }

  return {
    urls,
    async handle(request) {
      let response: PwsResponse;
      try {
        response = await dispatch(request);
      } catch (error) {
        response = toResponse(error);
      }

      return decorate(request.method, response);
    },
    decorate,
  };
}
