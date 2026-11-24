import type { NextFunction, Request, Response } from 'express';

import { GraphqlRequestLimitsMiddleware } from '../GraphqlRequestLimitsMiddleware';

const BROAD = `{ ${Array.from({ length: 200 }, () => 'me { id }').join(' ')} }`;
const NARROW = 'query Me { me { id } }';

function run(req: Partial<Request>): { next: jest.Mock; status: jest.Mock; json: jest.Mock } {
  const next = jest.fn() as jest.Mock & NextFunction;
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const middleware = new GraphqlRequestLimitsMiddleware();

  middleware.use(
    { method: 'POST', baseUrl: '', headers: {}, ...req } as Request,
    { status } as unknown as Response,
    next,
  );

  return { next, status, json };
}

describe('GraphqlRequestLimitsMiddleware', () => {
  it('answers a too-broad POST document with a 400 before Apollo runs', () => {
    const { next, status, json } = run({ originalUrl: '/graphql', body: { query: BROAD } });

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      errors: [
        { message: expect.stringMatching(/same field too often/), extensions: { code: 'BAD_REQUEST' } },
      ],
    });
  });

  it('checks a GET query string too', () => {
    const search = new URLSearchParams({ query: BROAD }).toString();
    const { next, status } = run({ method: 'GET', originalUrl: `/graphql?${search}`, query: {} });

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });

  it('reads a GET document from the raw URL, as Apollo does, not from the parsed req.query', () => {
    // node's querystring (Express's req.query) stops after 1,000 parameters;
    // Apollo's URLSearchParams reads them all.
    const filler = Array.from({ length: 1_000 }, () => 'a=1').join('&');
    const search = `${filler}&${new URLSearchParams({ query: BROAD }).toString()}`;
    const { next, status } = run({ method: 'GET', originalUrl: `/graphql?${search}`, query: { a: '1' } });

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });

  it('passes a GET with no document, or an ordinary one, through', () => {
    for (const originalUrl of ['/graphql', `/graphql?${new URLSearchParams({ query: NARROW }).toString()}`]) {
      const { next, status } = run({ method: 'GET', originalUrl, query: {} });

      expect(next).toHaveBeenCalledTimes(1);
      expect(status).not.toHaveBeenCalled();
    }
  });

  it('matches the Apollo mount, where only baseUrl names the endpoint', () => {
    const { status } = run({ baseUrl: '/graphql', originalUrl: '/', url: '/', body: { query: BROAD } });

    expect(status).toHaveBeenCalledWith(400);
  });

  it('matches the endpoint in any letter case, as express routing does', () => {
    for (const req of [
      { originalUrl: '/GraphQL', body: { query: BROAD } },
      { baseUrl: '/GRAPHQL', originalUrl: '/', url: '/', body: { query: BROAD } },
    ]) {
      const { next, status } = run(req);

      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(400);
    }
  });

  it('matches an absolute-form request, which express routes by its parsed path', () => {
    // `POST http://host/graphql HTTP/1.1` reaches Apollo, and its originalUrl
    // starts with the scheme; only req.path names the endpoint.
    for (const req of [
      {
        originalUrl: 'http://api:3030/graphql',
        url: 'http://api:3030/graphql',
        path: '/graphql',
        body: { query: BROAD },
      },
      {
        method: 'GET',
        originalUrl: `http://api:3030/GraphQL?${new URLSearchParams({ query: BROAD }).toString()}`,
        path: '/GraphQL',
        query: {},
      },
    ]) {
      const { next, status } = run(req);

      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(400);
    }
  });

  it('passes an ordinary document through', () => {
    const { next, status } = run({ originalUrl: '/graphql', body: { query: NARROW, variables: {} } });

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it('leaves other routes, persisted-query hashes and batches alone', () => {
    for (const req of [
      { originalUrl: '/v1/events', body: { query: BROAD } },
      { originalUrl: '/graphql', body: { extensions: { persistedQuery: { sha256Hash: 'abc' } } } },
      { originalUrl: '/graphql', body: [{ query: BROAD }] },
    ]) {
      const { next, status } = run(req);

      expect(next).toHaveBeenCalledTimes(1);
      expect(status).not.toHaveBeenCalled();
    }
  });
});
