import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { AuthService } from '../services/AuthService';
import { CsrfService, CsrfValidationError } from '../services/CsrfService';

const CSRF_COOKIE_NAME = config.auth.cookies.csrfTokenName;
const CSRF_HEADER_NAME = 'x-csrf-token';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly csrfService: CsrfService,
    private readonly authService: AuthService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(CsrfGuard.name);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    // The principal the CSRF token must be bound to: the session id carried by
    // the session cookie's JWT, or null for a pre-auth request.
    const scope = this.authService.resolveCsrfScope(req);

    try {
      this.csrfService.validateToken(
        req.cookies?.[CSRF_COOKIE_NAME],
        req.headers[CSRF_HEADER_NAME] as string | undefined,
        scope,
      );
    } catch (err) {
      if (err instanceof CsrfValidationError) {
        // Reason + route is enough to debug a rejection wave. Deliberately no
        // token values and no session id — both are credentials (or halves of
        // one) and must never reach the logs.
        this.logger.warn('CSRF validation failed', {
          reason: err.reason,
          method: req.method,
          path: req.path,
          authed: scope != null,
        });
      }

      throw err;
    }

    return true;
  }
}
