import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { ContextService } from '../services/ContextService';

const TRACE_ID_HEADER = 'X-Trace-Id';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const requestId = uuidv4();

    res.setHeader(TRACE_ID_HEADER, requestId);

    ContextService.run(
      {
        traceId: requestId,
      },
      () => {
        next();
      },
    );
  }
}
