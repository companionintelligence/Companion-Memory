import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { isGraphqlRequest } from '@ci/common/middleware';

import { graphqlSourceViolation } from './requestLimits';

/** The document a GraphQL request carries: the `query` field of a POST body, or of a GET's query string. */
function documentSourceOf(req: Request): unknown {
  if (req.method === 'GET') {
    return (req.query as Record<string, unknown> | undefined)?.query;
  }

  const body: unknown = req.body;

  // A batched (array) body is refused by Apollo itself; nothing to measure.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }

  return (body as { query?: unknown }).query;
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

    const source = documentSourceOf(req);
    const violation = typeof source === 'string' ? graphqlSourceViolation(source) : null;

    if (!violation) {
      next();

      return;
    }

    res.status(400).json({ errors: [{ message: violation, extensions: { code: 'BAD_REQUEST' } }] });
  }
}
