import { type ExecutionContext, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

import type { ApiKeyScopedRequest } from './apiKeyScopeEnforcement';
import type { PortalPrincipalMarker } from './PortalTokenVerifier';

/** The request as the auth guards see it, with everything a strategy or the Portal path may leave on it. */
export type GuardedRequest = ApiKeyScopedRequest & PortalPrincipalMarker & { user?: unknown };

/**
 * The request behind an execution context, for a guard that serves REST and
 * GraphQL alike. `guardName` goes into the error for a context type the guards
 * do not handle (a websocket, say), so the failure names who refused it.
 *
 * Every passport-backed guard overrides `getRequest` with this: the mixin's own
 * version only knows HTTP.
 */
export function requestFromContext(context: ExecutionContext, guardName: string): GuardedRequest {
  if (context.getType<string>() === 'graphql') {
    const { req } = GqlExecutionContext.create(context).getContext<{ req?: GuardedRequest }>();

    if (req == null) {
      throw new InternalServerErrorException('Request object not found in GraphQL context');
    }

    return req;
  }

  if (context.getType<string>() === 'http') {
    return context.switchToHttp().getRequest();
  }

  throw new InternalServerErrorException(`${guardName} does not support context type: ${context.getType()}`);
}

/**
 * Passport's `handleRequest` for a guard that answers 401 to any failure: an
 * error from the strategy, or no user, with nothing about why in the response.
 */
export function userOrUnauthorized<TUser>(err: unknown, user: TUser): TUser {
  if (err || !user) {
    throw new UnauthorizedException();
  }

  return user;
}
