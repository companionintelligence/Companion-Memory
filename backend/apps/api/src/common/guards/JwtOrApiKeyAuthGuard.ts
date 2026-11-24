import { type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { enforceApiKeyAuthority } from './apiKeyScopeEnforcement';
import { requestFromContext, userOrUnauthorized } from './guardRequest';
import { acceptPortalBearer, bindPortalPrincipal } from './portalBearer';
import { PORTAL_TOKEN_VERIFIER, type PortalTokenVerifier } from './PortalTokenVerifier';

@Injectable()
export class JwtOrApiKeyAuthGuard extends AuthGuard(['jwt', 'api-key']) {
  constructor(
    @Inject(PORTAL_TOKEN_VERIFIER) private readonly portalTokenVerifier: PortalTokenVerifier,
    private readonly reflector: Reflector,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = this.getRequest(context);
    // Portal-brokered OIDC token path — runs alongside the legacy JWT/api-key
    // strategies during migration (gated by auth.portal.enabled).
    const principal = await acceptPortalBearer(this.portalTokenVerifier, request);

    if (principal) {
      bindPortalPrincipal(request, principal);

      // A Portal bearer that is not the user's full authority (a capture client, or a
      // token not addressed to this appliance) is confined exactly like an api key
      // with the same scopes and capability, by the same enforcement.
      if (principal.limits) {
        // A copy: the verifier hands every capture principal the same constant array.
        request.apiKeyScopes = [...principal.limits.scopes];
        request.apiKeyCapability = principal.limits.capability;
        enforceApiKeyAuthority(this.reflector, context, request);
      }

      return true;
    }

    const ok = (await super.canActivate(context)) as boolean;

    // Deny-by-default scope enforcement once the api-key strategy has populated
    // `req.apiKeyScopes`. A scope-limited key is confined to routes that grant
    // one of its scopes; empty-scope/legacy keys and JWT principals are unaffected.
    if (ok) {
      enforceApiKeyAuthority(this.reflector, context, request);
    }

    return ok;
  }

  getRequest(context: ExecutionContext) {
    return requestFromContext(context, JwtOrApiKeyAuthGuard.name);
  }

  handleRequest<TUser = unknown>(err: unknown, user: TUser): TUser {
    return userOrUnauthorized(err, user);
  }
}
