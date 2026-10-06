import {
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AuthGuard } from '@nestjs/passport';

import { ContextService } from '@ci/common/context';

import { extractBearerToken } from './bearerToken';
import {
  PORTAL_TOKEN_VERIFIER,
  type PortalPrincipalMarker,
  type PortalTokenVerifier,
} from './PortalTokenVerifier';

/**
 * Accepts a CI-Server session JWT or a portal-issued OIDC bearer — and,
 * deliberately, NOT an api key.
 *
 * This exists for credential-management routes (minting/listing/revoking api
 * keys): portal-authenticated clients like Companion Capture hold only a
 * short-lived portal id_token after sign-in and need to exchange it for a
 * durable api key, but an api key itself must never reach those routes — a
 * leaked key that could mint replacement keys would survive its own
 * revocation. Requiring a JWT/portal principal keeps key management anchored
 * to an interactive sign-in.
 */
@Injectable()
export class JwtOrPortalAuthGuard extends AuthGuard('jwt') {
  constructor(@Inject(PORTAL_TOKEN_VERIFIER) private readonly portalTokenVerifier: PortalTokenVerifier) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Portal-brokered OIDC token path — mirrors JwtOrApiKeyAuthGuard (gated by
    // auth.portal.enabled), falling back to the legacy session-JWT strategy.
    if (this.portalTokenVerifier.enabled) {
      const request = this.getRequest(context);
      const token = extractBearerToken(request?.headers?.authorization);

      if (token) {
        const principal = await this.portalTokenVerifier.verifyAndProvision(token);

        if (principal) {
          // Minting a key turns an hour-long token into a credential that never expires, and
          // the MCP routes behind this guard can run commands. Only a token that carries the
          // user's full authority here may do either.
          if (!principal.credentialRoutes) {
            throw new ForbiddenException(
              'This Companion sign-in cannot manage keys on this Memory. Sign in to this Memory directly, or connect again from an up-to-date app.',
            );
          }

          ContextService.set({ userId: principal.user.id });
          request.user = principal.user;
          (request as PortalPrincipalMarker).portalPrincipal = { admin: principal.admin };

          return true;
        }
      }
    }

    return (await super.canActivate(context)) as boolean;
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
      `${JwtOrPortalAuthGuard.name} does not support context type: ${context.getType()}`,
    );
  }

  handleRequest<TUser = unknown>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      throw new UnauthorizedException();
    }

    return user;
  }
}
