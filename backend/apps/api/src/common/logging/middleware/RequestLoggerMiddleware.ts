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
const SECRET_PATH_SEGMENTS: readonly RegExp[] = [/^((?:\/api)?\/bluebubbles\/webhook\/)[^/?#]+/];

/**
 * Routes whose QUERY carries a credential, and the parameters that do.
 *
 * A Companion sign-in passes through `/authenticate/oidc` twice. The start
 * carries the invitation (`signup_code`) and the native client's PKCE challenge
 * and state (`code_challenge`, `app_state`); the callback carries the Portal's
 * authorization code and the OAuth `state`. They are single-use and short-lived,
 * but the log outlives them, and logs get pasted into bug reports. The `/api`
 * prefix is optional for the reason given above.
 */
const SECRET_QUERY_PATHS: readonly RegExp[] = [/^(?:\/api)?\/authenticate\/oidc(?:\/|$)/];

const SECRET_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'code',
  'state',
  'signup_code',
  'code_challenge',
  'code_verifier',
  'app_state',
]);

function decodedName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** `url` with the value of each credential parameter replaced, on the routes that take them. */
function redactQuery(url: string): string {
  const start = url.indexOf('?');

  if (start === -1 || !SECRET_QUERY_PATHS.some((pattern) => pattern.test(url.slice(0, start)))) {
    return url;
  }

  const query = url
    .slice(start + 1)
    .split('&')
    .map((pair) => {
      const name = pair.split('=', 1)[0];

      return SECRET_QUERY_PARAMS.has(decodedName(name)) ? `${name}=REDACTED` : pair;
    })
    .join('&');

  return `${url.slice(0, start)}?${query}`;
}

/**
 * The request path as it is safe to write down.
 *
 * Redacts rather than drops the segment: "a webhook was delivered" is the fact
 * the log line exists for, and a bare `/api/bluebubbles/webhook` would be
 * indistinguishable from a request that never named a secret at all. Query
 * parameters are redacted the same way, keeping their names: a callback that
 * arrived with a `code` and a `state` reads differently from one that arrived
 * with an `error`.
 */
export function redactRequestPath(url: string): string {
  let redacted = redactQuery(url);

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
