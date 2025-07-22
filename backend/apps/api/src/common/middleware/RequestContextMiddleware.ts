import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

import type { RequestWithContext } from '../types';

export const REQUEST_ID_HEADER = 'X-Request-Id';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request & RequestWithContext, res: Response, next: NextFunction) {
    const requestId = uuidv4();

    req.context = {
      requestId,
      query: req.query,
    };

    res.setHeader(REQUEST_ID_HEADER, requestId);

    next();
  }
}
