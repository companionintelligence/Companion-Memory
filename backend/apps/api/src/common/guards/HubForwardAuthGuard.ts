import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import {
  type HubStableId,
  forwardAuthPolicy,
  readForwardAuthHeaders,
  verifyHubForwardAuth,
} from '@ci/common/crypto';
import config from '@ci/configuration';

/**
 * Guard that trusts the `X-CI-Hub-User` identity header only when CI-Hub's
 * forward-auth endpoint signed it: with the bound assertion under this app's own
 * key once the Hub has provided one, else with the shared secret, as
 * `forwardAuthPolicy` decides. An unsigned or forged header is rejected with 401.
 *
 * When `auth.hubForwardAuth.enabled` is false, the guard is inert and rejects
 * every request (the feature is opt-in per deployment), so wiring it onto a
 * route without provisioning the secret fails closed rather than trusting an
 * unsigned header.
 *
 * On success the verified username is attached as `req.hubForwardAuthUser`, and
 * the person's stable id — when the Hub sent one — as `req.hubForwardAuthStableId`.
 */
@Injectable()
export class HubForwardAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { hubForwardAuthUser?: string; hubForwardAuthStableId?: HubStableId | null }>();
    const cfg = config.auth.hubForwardAuth;

    if (!cfg.enabled) {
      throw new UnauthorizedException('Hub forward-auth verification is not enabled on this server');
    }

    const result = verifyHubForwardAuth(forwardAuthPolicy(cfg), readForwardAuthHeaders(req.headers));

    if (!result.ok) {
      throw new UnauthorizedException(`Invalid Hub forward-auth header: ${result.reason}`);
    }

    req.hubForwardAuthUser = result.username;
    req.hubForwardAuthStableId = result.stableId;

    return true;
  }
}
