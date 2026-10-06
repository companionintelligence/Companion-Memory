import {
  type ExecutionContext,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AuthGuard } from '@nestjs/passport';

import { ContextService } from '@ci/common/context';

import { enforceApiKeyCapability, enforceApiKeyScopes } from './apiKeyScopeEnforcement';
import { extractBearerToken } from './bearerToken';
import {
  PORTAL_TOKEN_VERIFIER,
  type PortalPrincipalMarker,
  type PortalTokenVerifier,
} from './PortalTokenVerifier';

@Injectable()
export class JwtOrApiKeyAuthGuard extends AuthGuard(['jwt', 'api-key']) {
  constructor(
    @Inject(PORTAL_TOKEN_VERIFIER) private readonly portalTokenVerifier: PortalTokenVerifier,
    private readonly reflector: Reflector,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Portal-brokered OIDC token path — runs alongside the legacy JWT/api-key
    // strategies during migration (gated by auth.portal.enabled).
    if (this.portalTokenVerifier.enabled) {
      const request = this.getRequest(context);
      const token = extractBearerToken(request?.headers?.authorization);

      if (token) {
        const principal = await this.portalTokenVerifier.verifyAndProvision(token);

        if (principal) {
          ContextService.set({ userId: principal.user.id });
          request.user = principal.user;
          (request as PortalPrincipalMarker).portalPrincipal = { admin: principal.admin };

          // A Portal bearer that is not the user's full authority (a capture client, or a
          // token not addressed to this appliance) is confined exactly like an api key
          // with the same scopes and capability, by the same enforcement.
          if (principal.limits) {
            // A copy: the verifier hands every capture principal the same constant array.
            request.apiKeyScopes = [...principal.limits.scopes];
            request.apiKeyCapability = principal.limits.capability;
            enforceApiKeyScopes(this.reflector, context, request);
            enforceApiKeyCapability(this.reflector, context, request);
          }

          return true;
        }
      }
    }

    const ok = (await super.canActivate(context)) as boolean;

    // Deny-by-default scope enforcement once the api-key strategy has populated
    // `req.apiKeyScopes`. A scope-limited key is confined to routes that grant
    // one of its scopes; empty-scope/legacy keys and JWT principals are unaffected.
    if (ok) {
      const request = this.getRequest(context);

      enforceApiKeyScopes(this.reflector, context, request);
      // Second axis: scopes got the key to this route, capability decides whether it may act here.
      enforceApiKeyCapability(this.reflector, context, request);
    }

    return ok;
  }

  getRequest(context: ExecutionContext) {
    if (context.getType<string>() === 'graphql') {
      const ctx = GqlExecutionContext.create(context);
      const { req } = ctx.getContext();

      if (req == null) {
        throw new InternalServerErrorException('Request object not found in GraphQL context');
      }

      return req;
    }

    if (context.getType<string>() === 'http') {
      return context.switchToHttp().getRequest();
    }

    throw new InternalServerErrorException(
      `${JwtOrApiKeyAuthGuard.name} does not support context type: ${context.getType()}`,
    );
  }

  handleRequest<TUser = unknown>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      throw new UnauthorizedException();
    }

    return user;
  }
}
