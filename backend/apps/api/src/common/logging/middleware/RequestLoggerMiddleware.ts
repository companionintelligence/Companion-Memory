import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

import { ContextService } from '@ci/common/context';

import { LoggerService } from '../services/LoggerService';

/**
 * Routes whose URL carries a CREDENTIAL in a path segment, and the shape that
 * finds it.
 *
 * This middleware is mounted `forRoutes('*')` and logs `req.originalUrl`
 * verbatim, so anything secret in a path is written to the app log on every
 * request. `POST /api/bluebubbles/webhook/:secret` is exactly that: BlueBubbles'
 * outgoing webhooks carry no header auth of their own, so the unguessable path
 * segment IS the credential — and every delivery from a working install was
 * writing it in plaintext.
 *
 * A path pattern rather than a route-level opt-out because the leak is this
 * logger's, not the controller's: a future route that puts a token in its path
 * must be added here, and nowhere else, to stop leaking it.
 */
/**
 * The `/api` prefix is OPTIONAL here, and that is the whole point: there is no
 * `setGlobalPrefix` on this server (see `docs/api/auth-and-conventions.md`), and
 * every edge that fronts it strips `/api` before forwarding — Caddy in dev
 * (`scripts/dev-stack/index.ts`), nginx in production
 * (`rewrite ^/api/(.*)$ /$1 break`). So the string this middleware actually
 * receives is `/bluebubbles/webhook/<secret>`, and a pattern anchored on the
 * browser-facing `/api/...` form matched nothing in any deployment — the
 * credential went to the log in plaintext on every delivery while a test
 * feeding the prefixed form passed.
 */
const SECRET_PATH_SEGMENTS: readonly RegExp[] = [
  /^((?:\/api)?\/bluebubbles\/webhook\/)[^/?#]+/,
];

/**
 * The request path as it is safe to write down.
 *
 * Redacts rather than drops the segment: "a webhook was delivered" is the fact
 * the log line exists for, and a bare `/api/bluebubbles/webhook` would be
 * indistinguishable from a request that never named a secret at all.
 */
export function redactRequestPath(url: string): string {
  let redacted = url;

  for (const pattern of SECRET_PATH_SEGMENTS) {
    redacted = redacted.replace(pattern, '$1REDACTED');
  }

  return redacted;
}

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
        path: redactRequestPath(req.originalUrl),
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
