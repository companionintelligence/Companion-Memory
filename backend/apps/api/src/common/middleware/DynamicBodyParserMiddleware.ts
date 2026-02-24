import { Injectable, NestMiddleware } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { json } from 'express';
import type { NextFunction, Request, Response } from 'express';

import { BODY_LIMIT_KEY } from '../decorators';

/**
 * Middleware that dynamically applies JSON body size limits based on route metadata.
 * Uses the @BodyLimit decorator to determine the appropriate limit for each route.
 * Falls back to a default of 100kb if no limit is specified.
 */
@Injectable()
export class DynamicBodyParserMiddleware implements NestMiddleware {
  constructor(private readonly reflector: Reflector) {}

  use(req: Request, res: Response, next: NextFunction) {
    // Get the route handler from the request
    // Note: This is available after routing is resolved
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (req as any).route?.stack?.[0]?.handle;

    // Look up the body limit metadata from the route handler
    const limit = handler ? this.reflector.get<string>(BODY_LIMIT_KEY, handler) : undefined;

    // Use the specified limit or default to 100kb
    const bodyLimit = limit || '100kb';

    // Apply JSON body parser with the determined limit
    json({ limit: bodyLimit })(req, res, next);
  }
}
