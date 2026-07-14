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

import { enforceApiKeyScopes } from './apiKeyScopeEnforcement';
import { PORTAL_TOKEN_VERIFIER, type PortalTokenVerifier } from './PortalTokenVerifier';

function extractBearerToken(request: { headers?: Record<string, unknown> }): string | null {
  const header = request?.headers?.authorization;

  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
}

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
      const token = extractBearerToken(request);

      if (token) {
        const user = await this.portalTokenVerifier.verifyAndProvision(token);

        if (user) {
          ContextService.set({ userId: user.id });
          request.user = user;

          // Portal principal carries full user authority and no api-key scopes,
          // so scope enforcement does not apply to this path.
          return true;
        }
      }
    }

    const ok = (await super.canActivate(context)) as boolean;

    // Deny-by-default scope enforcement once the api-key strategy has populated
    // `req.apiKeyScopes`. A scope-limited key is confined to routes that grant
    // one of its scopes; empty-scope/legacy keys and JWT principals are unaffected.
    if (ok) {
      enforceApiKeyScopes(this.reflector, context, this.getRequest(context));
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
