import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

import { ContextService } from '@ci/common/context';

import { LoggerService } from '../services/LoggerService';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext('request');
  }

  use(req: Request, res: Response, next: NextFunction) {
    const start = process.hrtime.bigint();
    let fired = false;

    const handleDone = () => {
      if (fired) {
        return false;
      }

      fired = true;

      const duration = process.hrtime.bigint() - start;
      const userId = ContextService.getUserId();

      this.logger.log('Request processed', {
        ...(userId && { userId }),
        method: req.method,
        path: req.originalUrl,
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
