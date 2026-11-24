import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { isGraphqlRequest } from '@ci/common/middleware';

import { graphqlSourceViolation } from './requestLimits';

/**
 * The documents a GraphQL request carries: the `query` field of a POST body, or
 * every `query` parameter of a GET's query string.
 *
 * A GET is read from the raw URL with URLSearchParams, the way Apollo reads it,
 * and not from `req.query`. Express builds that with node's querystring, which
 * stops after 1,000 parameters, so a document placed after 1,000 filler
 * parameters reached Apollo without ever being measured here.
 */
function documentSourcesOf(req: Request): unknown[] {
  if (req.method === 'GET') {
    const url = req.originalUrl || req.url || '';
    const searchStart = url.indexOf('?');

    if (searchStart === -1) {
      return [];
    }

    const hash = url.indexOf('#', searchStart);

    return new URLSearchParams(url.slice(searchStart + 1, hash === -1 ? undefined : hash)).getAll('query');
  }

  const body: unknown = req.body;

  // A batched (array) body is refused by Apollo itself; nothing to measure.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return [];
  }

  return [(body as { query?: unknown }).query];
}

/**
 * Refuses a GraphQL document too broad to validate cheaply, before Apollo sees it.
 *
 * Apollo offers no hook that runs between parsing and validation and can still
 * answer the client: a plugin that throws from `didResolveSource` or
 * `validationDidStart` becomes a logged 500. So the check lives here, after
 * `BodyParserMiddleware` has parsed the body, and answers with the same 400
 * shape Apollo uses for a bad request. See `./requestLimits.ts` for the limits
 * and why they exist. Parsing the document a second time costs well under a
 * millisecond at the token limit.
 */
@Injectable()
export class GraphqlRequestLimitsMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (!isGraphqlRequest(req)) {
      next();

      return;
    }

    let violation: string | null = null;

    for (const source of documentSourcesOf(req)) {
      violation ??= typeof source === 'string' ? graphqlSourceViolation(source) : null;
    }

    if (!violation) {
      next();

      return;
    }

    res.status(400).json({ errors: [{ message: violation, extensions: { code: 'BAD_REQUEST' } }] });
  }
}
