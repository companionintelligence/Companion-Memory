import { Injectable, NestMiddleware } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';

import { BODY_LIMIT_KEY } from '../decorators';

/** An express request carrying the unparsed body, for signature verification. */
export interface RawBodyRequest extends Request {
  rawBody?: string;
}

/**
 * Body size limit for the single POST /graphql endpoint. The GraphQL route is
 * mounted by the Apollo driver via `app.use('/graphql', expressMiddleware(...))`,
 * NOT as a Nest controller route, so `req.route` is undefined here and the
 * per-route @BodyLimit metadata path below can never match it — it would fall
 * back to the 100kb default and 413 on bulk batch mutations (the importer pushes
 * thousands of timeline items per createCommunications/createEvents call). Apollo
 * itself registers no body parser, so THIS middleware is the only thing parsing
 * the /graphql body; raise its limit here. 10mb comfortably fits the importer's
 * batches while still bounding a single request.
 */
const GRAPHQL_BODY_LIMIT = '10mb';
const GRAPHQL_PATH = '/graphql';

/**
 * The `/v1/*` machine-ingest plane carries bulk payloads: `POST /v1/events`
 * perception snapshots from Companion Capture (a single vizier baseline snapshot
 * serializes to ~1MB+), and the batch ingest endpoints
 * (`/v1/communications`, `/v1/contents`, `/v1/things`,
 * `/v1/browser-activity`, `/v1/positions` — see BulkIngestController) which
 * accept up to 10,000 records per request. All far over the 100kb default, so
 * the whole `/v1` prefix gets the same 10mb limit as GraphQL. Like GraphQL,
 * this is matched by path here rather than via @BodyLimit:
 * BodyParserMiddleware is applied with `forRoutes('*')`, so it runs before
 * routing and `req.route` (and thus per-route metadata) is undefined.
 */
const BULK_INGEST_BODY_LIMIT = '10mb';
const BULK_INGEST_PREFIX = '/v1';
const PORTABILITY_IMPORT_PATH = '/api/account/import/stream';

/**
 * NDJSON bulk streams (`Content-Type: application/x-ndjson`) on `/v1/*` are
 * parsed INCREMENTALLY by the route handlers themselves (see
 * domains/ingest/ndjson.ts): one record per line, unbounded stream, batched
 * flushes. This middleware must therefore leave the raw request stream
 * completely untouched — no buffering, no parsing, no size limit. The express
 * json()/urlencoded() parsers below would already skip an NDJSON content type,
 * but the bypass is explicit so a future parser addition (raw/text/etc.) can't
 * silently start consuming the stream. Nest's default body parser is disabled
 * globally (main.ts `bodyParser: false`), so skipping here guarantees the
 * handler receives `req` with zero bytes consumed.
 */
const NDJSON_CONTENT_TYPE = 'application/x-ndjson';

/**
 * The peer surface, whose requests are RFC 9421 signed.
 *
 * A signature covers a `Content-Digest` of the body, so verifying one needs the
 * bytes the peer actually sent -- not `JSON.stringify` of the parsed object,
 * which is not guaranteed to reproduce them (key order, number formatting,
 * unicode escapes). Re-serializing before digesting is the classic way to make
 * a signature check pass over content the sender never signed.
 *
 * Scoped to this ONE prefix on purpose. `verify` retains the whole buffer, and
 * doing that for every request would hold a second copy of every 10mb GraphQL
 * and bulk-ingest body for the life of the request.
 */
const SIGNED_PEER_PREFIX = '/agent/v1';

/**
 * Middleware that dynamically applies JSON body size limits based on route metadata.
 * Uses the @BodyLimit decorator to determine the appropriate limit for each route.
 * Falls back to a default of 100kb if no limit is specified.
 */
@Injectable()
export class BodyParserMiddleware implements NestMiddleware {
  constructor(private readonly reflector: Reflector) {}

  use(req: Request, res: Response, next: NextFunction) {
    // Get the route handler from the request
    // Note: This is available after routing is resolved
    const handler = req.route?.stack?.[0]?.handle;

    // Look up the body limit metadata from the route handler
    const limit = handler ? this.reflector.get<string>(BODY_LIMIT_KEY, handler) : undefined;

    // The /graphql endpoint is a single Apollo-mounted POST route (no Nest route
    // metadata), so it needs an explicit limit here rather than via @BodyLimit.
    // The Apollo driver mounts /graphql via `app.use('/graphql', …)`, so when this
    // middleware runs inside that mount `req.path` is '/' and `req.baseUrl` is
    // '/graphql'. Check baseUrl/originalUrl (not just req.path) so the limit
    // actually applies to the GraphQL route.
    const routePath = (req.originalUrl || req.url || req.path).split('?')[0];
    const isGraphql =
      req.baseUrl === GRAPHQL_PATH || routePath === GRAPHQL_PATH || routePath.startsWith(`${GRAPHQL_PATH}/`);
    const isBulkIngest = routePath === BULK_INGEST_PREFIX || routePath.startsWith(`${BULK_INGEST_PREFIX}/`);
    const isPortabilityImport = routePath === PORTABILITY_IMPORT_PATH;

    // NDJSON streaming bypass: hand the raw, unconsumed stream to the /v1
    // route handler (see NDJSON_CONTENT_TYPE above) and to account import/stream.
    const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

    if ((isBulkIngest || isPortabilityImport) && contentType === NDJSON_CONTENT_TYPE) {
      return next();
    }

    // Use the route's own limit, then the GraphQL / v1 bulk-ingest limits,
    // else default to 100kb.
    const bodyLimit =
      limit || (isGraphql ? GRAPHQL_BODY_LIMIT : isBulkIngest ? BULK_INGEST_BODY_LIMIT : '100kb');

    // Retain the exact bytes for the signed peer surface only. `verify` runs
    // before parsing and receives the raw buffer, which is the only hook that
    // sees the body as sent.
    const isSignedPeerRoute =
      routePath === SIGNED_PEER_PREFIX || routePath.startsWith(`${SIGNED_PEER_PREFIX}/`);

    // Chain both parsers so each checks the Content-Type header and only the
    // matching one actually parses the body. `next` is called exactly once at the end.
    json({
      limit: bodyLimit,
      ...(isSignedPeerRoute
        ? {
            verify: (request: Request, _response: Response, buffer: Buffer) => {
              (request as RawBodyRequest).rawBody = buffer.toString('utf8');
            },
          }
        : {}),
    })(req, res, (err?: unknown) => {
      if (err) {
        return next(err as Error);
      }

      urlencoded({ extended: true, limit: bodyLimit })(req, res, next);
    });
  }
}
