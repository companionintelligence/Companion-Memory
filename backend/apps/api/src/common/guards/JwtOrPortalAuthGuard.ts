import { type ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { requestFromContext, userOrUnauthorized } from './guardRequest';
import { acceptPortalBearer, bindPortalPrincipal } from './portalBearer';
import { PORTAL_TOKEN_VERIFIER, type PortalTokenVerifier } from './PortalTokenVerifier';

/**
 * Accepts a CI-Server session JWT or a portal-issued OIDC bearer — and,
 * deliberately, NOT an api key.
 *
 * This exists for credential-management routes (minting/listing/revoking api
 * keys): a phone pairing with this Memory holds only a short-lived Portal token
 * after sign-in and exchanges it for a durable api key, but an api key itself
 * must never reach those routes: a leaked key that could mint replacement keys
 * would survive its own revocation. Requiring a JWT/portal principal keeps key
 * management anchored to an interactive sign-in.
 *
 * Not every Portal token gets in (`PortalPrincipal.credentialRoutes`). One
 * addressed to this appliance does, and so does one from a Portal that predates
 * addressing. A capture client's token (Companion Capture, the browser
 * extension) and an unaddressed one are refused, so neither becomes a key that
 * never expires.
 */
@Injectable()
export class JwtOrPortalAuthGuard extends AuthGuard('jwt') {
  constructor(@Inject(PORTAL_TOKEN_VERIFIER) private readonly portalTokenVerifier: PortalTokenVerifier) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = this.getRequest(context);
    // Portal-brokered OIDC token path — mirrors JwtOrApiKeyAuthGuard (gated by
    // auth.portal.enabled), falling back to the legacy session-JWT strategy.
    const principal = await acceptPortalBearer(this.portalTokenVerifier, request);

    if (principal) {
      // Minting a key turns an hour-long token into a credential that never expires, and
      // the MCP routes behind this guard can run commands. Only a token that carries the
      // user's full authority here may do either. This guard runs no scope enforcement, so a
      // principal with limits is refused here too rather than let in unconfined.
      if (!principal.credentialRoutes || principal.limits) {
        throw new ForbiddenException(
          'This Companion sign-in cannot manage keys on this Memory. Sign in to this Memory directly, or connect again from an up-to-date app.',
        );
      }

      bindPortalPrincipal(request, principal);

      return true;
    }

    return (await super.canActivate(context)) as boolean;
  }

  getRequest(context: ExecutionContext) {
    return requestFromContext(context, JwtOrPortalAuthGuard.name);
  }

  handleRequest<TUser = unknown>(err: unknown, user: TUser): TUser {
    return userOrUnauthorized(err, user);
  }
}
