import type { Reflector } from '@nestjs/core';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';

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
      '/v1/inventory',
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

describe('BodyParserMiddleware NDJSON streaming bypass', () => {
  it('leaves the raw stream untouched for application/x-ndjson on /v1/*', () => {
    for (const url of [
      '/v1/communications',
      '/v1/contents',
      '/v1/inventory',
      '/v1/browser-activity',
      '/v1/positions',
    ]) {
      const result = runMiddleware(url, 'application/x-ndjson');

      expect(result.parsersInvoked).toBe(false);
    }
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
