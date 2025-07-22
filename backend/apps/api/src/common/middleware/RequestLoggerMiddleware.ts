import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Response, NextFunction } from 'express';

import { LoggerService } from '../services';
import type { RequestWithContext } from '../types';

export const REQUEST_ID_HEADER = 'X-Request-Id';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new LoggerService('request');

  use(req: RequestWithContext, res: Response, next: NextFunction) {
    const start = process.hrtime.bigint();
    let fired = false;

    const handleDone = () => {
      if (fired) {
        return false;
      }

      fired = true;

      const duration = process.hrtime.bigint() - start;

      this.logger.log('Request processed', {
        ...req.context,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration: Number(duration) / 1_000_000,
        termination: res.writableEnded ? 'finished' : 'closed',
      });
    };

    res.on('finish', handleDone);
    res.on('close', handleDone);

    next();
  }
}
