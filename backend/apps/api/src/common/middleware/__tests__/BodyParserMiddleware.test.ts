import type { Reflector } from '@nestjs/core';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';

import { BODY_LIMIT_KEY } from '../../decorators';
import { BodyParserMiddleware } from '../BodyParserMiddleware';

// Stub the express parsers: capture the options they're constructed with and
// hand back a pass-through handler so use() completes synchronously.
jest.mock('express', () => ({
  json: jest.fn(() => (_req: Request, _res: Response, next: NextFunction) => next()),
  urlencoded: jest.fn(() => (_req: Request, _res: Response, next: NextFunction) => next()),
}));

function runMiddleware(
  url: string,
  contentType = 'application/json',
): { jsonLimit?: string; urlencodedLimit?: string; parsersInvoked: boolean } {
  jest.clearAllMocks();

  const middleware = new BodyParserMiddleware({ get: () => undefined } as unknown as Reflector);
  const req = {
    originalUrl: url,
    url,
    path: url,
    baseUrl: '',
    headers: { 'content-type': contentType },
  } as unknown as Request;
  const next = jest.fn();

  middleware.use(req, {} as Response, next);

  expect(next).toHaveBeenCalledTimes(1);

  return {
    jsonLimit: (json as jest.Mock).mock.calls[0]?.[0]?.limit,
    urlencodedLimit: (urlencoded as jest.Mock).mock.calls[0]?.[0]?.limit,
    parsersInvoked: (json as jest.Mock).mock.calls.length > 0,
  };
}

describe('BodyParserMiddleware limits', () => {
  it('gives every /v1/* bulk-ingest route the 10mb limit', () => {
    for (const url of [
      '/v1/events',
      '/v1/communications',
      '/v1/contents',
      '/v1/things',
      '/v1/browser-activity',
      '/v1/positions',
      '/v1/ingest/finish',
    ]) {
      expect(runMiddleware(url)).toEqual({
        jsonLimit: '10mb',
        urlencodedLimit: '10mb',
        parsersInvoked: true,
      });
    }
  });

  it('keeps the 10mb limit on /graphql', () => {
    expect(runMiddleware('/graphql')).toEqual({
      jsonLimit: '10mb',
      urlencodedLimit: '10mb',
      parsersInvoked: true,
    });
  });

  it('leaves other routes on the 100kb default, and does not match /v1-lookalike prefixes', () => {
    expect(runMiddleware('/api/maintenance/orchestrate')).toEqual({
      jsonLimit: '100kb',
      urlencodedLimit: '100kb',
      parsersInvoked: true,
    });
    expect(runMiddleware('/v10/events')).toEqual({
      jsonLimit: '100kb',
      urlencodedLimit: '100kb',
      parsersInvoked: true,
    });
  });

  it('ignores query strings when matching the bulk-ingest prefix', () => {
    expect(runMiddleware('/v1/ingest/finish?stream=0')).toEqual({
      jsonLimit: '10mb',
      urlencodedLimit: '10mb',
      parsersInvoked: true,
    });
  });
});

/**
 * Every scenario above builds the middleware with `{ get: () => undefined }`,
 * so `limit` (from `reflector.get(BODY_LIMIT_KEY, handler)`) is ALWAYS
 * undefined and only the hardcoded GraphQL/bulk-ingest/default fallback
 * branch is ever reached. Real routing populates `req.route.stack[0].handle`
 * with the controller method, and the `@BodyLimit` decorator
 * (`AccountDataController`'s `500mb` export route is the production example)
 * relies on that handler being looked up in the reflector and its limit
 * taking PRIORITY over the path-based defaults — `bodyLimit = limit || (...)`
 * short-circuits on a truthy per-route limit before the isGraphql/isBulkIngest
 * branches are even consulted. None of that was exercised.
 */
function runMiddlewareWithRoute(
  url: string,
  routeLimit: string | undefined,
  contentType = 'application/json',
): {
  jsonLimit?: string;
  urlencodedLimit?: string;
  handler: () => undefined;
  reflectorGet: jest.Mock;
} {
  jest.clearAllMocks();

  const handler = () => undefined;
  const reflectorGet = jest.fn((key: string) => (key === BODY_LIMIT_KEY ? routeLimit : undefined));
  const middleware = new BodyParserMiddleware({ get: reflectorGet } as unknown as Reflector);
  const req = {
    originalUrl: url,
    url,
    path: url,
    baseUrl: '',
    headers: { 'content-type': contentType },
    route: { stack: [{ handle: handler }] },
  } as unknown as Request;
  const next = jest.fn();

  middleware.use(req, {} as Response, next);

  expect(next).toHaveBeenCalledTimes(1);

  return {
    jsonLimit: (json as jest.Mock).mock.calls[0]?.[0]?.limit,
    urlencodedLimit: (urlencoded as jest.Mock).mock.calls[0]?.[0]?.limit,
    handler,
    reflectorGet,
  };
}

describe('BodyParserMiddleware per-route @BodyLimit override', () => {
  it('takes priority over the /v1 bulk-ingest 10mb default', () => {
    // A route metadata limit of 500mb (AccountDataController's export route)
    // reached via /v1 must win over the path-based 10mb, not be shadowed by it.
    expect(runMiddlewareWithRoute('/v1/some-route', '500mb')).toEqual(
      expect.objectContaining({ jsonLimit: '500mb', urlencodedLimit: '500mb' }),
    );
  });

  it('takes priority over the /graphql 10mb default', () => {
    expect(runMiddlewareWithRoute('/graphql', '500mb')).toEqual(
      expect.objectContaining({ jsonLimit: '500mb', urlencodedLimit: '500mb' }),
    );
  });

  it('takes priority over the 100kb default on an otherwise-unmatched route', () => {
    expect(runMiddlewareWithRoute('/api/account/export', '500mb')).toEqual(
      expect.objectContaining({ jsonLimit: '500mb', urlencodedLimit: '500mb' }),
    );
  });

  it('looks the limit up via BODY_LIMIT_KEY against the resolved route handler', () => {
    const { handler, reflectorGet } = runMiddlewareWithRoute('/api/account/export', '500mb');
    expect(reflectorGet).toHaveBeenCalledWith(BODY_LIMIT_KEY, handler);
  });

  it('falls back to the path-based default when the route carries no @BodyLimit metadata', () => {
    // req.route IS present (so the handler lookup happens), but the reflector
    // has nothing registered for it — must still fall through cleanly.
    expect(runMiddlewareWithRoute('/v1/some-route', undefined)).toEqual(
      expect.objectContaining({ jsonLimit: '10mb', urlencodedLimit: '10mb' }),
    );
    expect(runMiddlewareWithRoute('/api/account/export', undefined)).toEqual(
      expect.objectContaining({ jsonLimit: '100kb', urlencodedLimit: '100kb' }),
    );
  });
});

describe('BodyParserMiddleware NDJSON streaming bypass', () => {
  it('leaves the raw stream untouched for application/x-ndjson on /v1/*', () => {
    for (const url of [
      '/v1/communications',
      '/v1/contents',
      '/v1/things',
      '/v1/browser-activity',
      '/v1/positions',
    ]) {
      const result = runMiddleware(url, 'application/x-ndjson');

      expect(result.parsersInvoked).toBe(false);
    }
  });

  it('leaves the raw stream untouched for account import/stream', () => {
    expect(runMiddleware('/api/account/import/stream', 'application/x-ndjson').parsersInvoked).toBe(false);
  });

  it('tolerates content-type parameters and casing on the bypass', () => {
    expect(runMiddleware('/v1/communications', 'Application/X-NDJSON; charset=utf-8').parsersInvoked).toBe(
      false,
    );
  });

  it('does NOT bypass NDJSON outside /v1 (parsers run and no-op on the unmatched type)', () => {
    expect(runMiddleware('/api/maintenance/orchestrate', 'application/x-ndjson').parsersInvoked).toBe(true);
  });

  it('still parses JSON envelopes on /v1/* at the 10mb limit', () => {
    expect(runMiddleware('/v1/communications', 'application/json')).toEqual({
      jsonLimit: '10mb',
      urlencodedLimit: '10mb',
      parsersInvoked: true,
    });
  });
});
