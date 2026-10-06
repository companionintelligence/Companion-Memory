import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { AuthService } from '../services/AuthService';
import { CsrfService, CsrfValidationError } from '../services/CsrfService';

const CSRF_COOKIE_NAME = config.auth.cookies.csrfTokenName;
const CSRF_HEADER_NAME = 'x-csrf-token';

@Injectable()
export class CsrfGuard implements CanActivate {
  /** Whether the native app's cookie-less shape (header token alone) is accepted. */
  protected readonly allowCookieless: boolean = true;

  constructor(
    private readonly csrfService: CsrfService,
    private readonly authService: AuthService,
    private readonly logger: LoggerService,
  ) {
    // new.target, so a CookieCsrfGuard rejection is logged under its own name.
    this.logger.setContext(new.target.name);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    const cookieToken = req.cookies?.[CSRF_COOKIE_NAME] as string | undefined;
    const headerToken = req.headers[CSRF_HEADER_NAME] as string | undefined;

    // Cookie-less native clients: no ambient session cookie (they authenticate via an
    // API key, so cookie-replay CSRF doesn't apply and a cross-site caller cannot set a
    // custom request header either), but they DO carry a header token read from the
    // /csrf response body. That header-without-cookie shape is the native signature.
    // There is no session cookie to bind a scope against, so require only that the
    // header token was minted by us (scope-agnostic verifyToken).
    //
    // A request with NEITHER cookie nor header is not native — it is a malformed or
    // pre-auth request, so let it fall through to validateToken, which reports it as a
    // "missing" CSRF rejection (logged) rather than being silently reclassified here.
    const hasCookie = cookieToken != null && cookieToken !== '';
    const hasHeader = headerToken != null && headerToken !== '';

    if (this.allowCookieless && !hasCookie && hasHeader) {
      if (!this.csrfService.verifyToken(headerToken)) {
        throw new ForbiddenException('Missing or invalid CSRF token');
      }

      return true;
    }

    // Browser clients: strict signed double-submit, bound to the principal. The
    // scope is the session id carried by the session cookie's JWT, or null pre-auth.
    const scope = this.authService.resolveCsrfScope(req);

    try {
      this.csrfService.validateToken(cookieToken, headerToken, scope);
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

/**
 * {@link CsrfGuard} without the native cookie-less shortcut: the cookie and header pair, bound to
 * the session, or nothing.
 *
 * For routes only the browser app calls. `POST /authenticate/hub-bridge` is one: the web app primes
 * the cookie and echoes it before calling, and the native app never calls it (it has no Hub
 * forward-auth in front of it). The shortcut there only served a caller with no cookie at all.
 */
@Injectable()
export class CookieCsrfGuard extends CsrfGuard {
  protected override readonly allowCookieless: boolean = false;
}
