import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import {
  FORWARD_AUTH_SIGNATURE_HEADER,
  FORWARD_AUTH_TIMESTAMP_HEADER,
  FORWARD_AUTH_USER_HEADER,
  verifyForwardAuthHeaders,
} from '@ci/common/crypto';
import config from '@ci/configuration';

/**
 * Guard that trusts the `X-CI-Hub-User` identity header only when its HMAC
 * signature (issued by CI-Hub's forward-auth endpoint) verifies against the
 * shared secret. An unsigned or forged header is rejected with 401.
 *
 * When `auth.hubForwardAuth.enabled` is false, the guard is inert and rejects
 * every request (the feature is opt-in per deployment), so wiring it onto a
 * route without provisioning the secret fails closed rather than trusting an
 * unsigned header.
 *
 * On success the verified username is attached as `req.hubForwardAuthUser`.
 */
@Injectable()
export class HubForwardAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { hubForwardAuthUser?: string }>();
    const cfg = config.auth.hubForwardAuth;

    if (!cfg.enabled) {
      throw new UnauthorizedException('Hub forward-auth verification is not enabled on this server');
    }

    const headerValue = (name: string): string | null => {
      const raw = req.headers[name];
      if (Array.isArray(raw)) {
        return raw[0] ?? null;
      }

      return raw ?? null;
    };

    const result = verifyForwardAuthHeaders(
      cfg.secret,
      {
        user: headerValue(FORWARD_AUTH_USER_HEADER),
        timestamp: headerValue(FORWARD_AUTH_TIMESTAMP_HEADER),
        signature: headerValue(FORWARD_AUTH_SIGNATURE_HEADER),
      },
      { maxSkewMs: cfg.maxSkewMs },
    );

    if (!result.ok) {
      throw new UnauthorizedException(`Invalid Hub forward-auth header: ${result.reason}`);
    }

    req.hubForwardAuthUser = result.username;

    return true;
  }
}
