import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { Request } from 'express';

import { SCOPES_METADATA_KEY } from './decorator';
import { matchScopes, missingScopes, type Scope } from './taxonomy';

/**
 * Per-request shape stashed on the express Request by ApiKeyStrategy.
 */
interface ApiKeyAuthMarker {
  scopes: string[];
  keyId: string;
}

type RequestWithAuth = Request & { apiKeyAuth?: ApiKeyAuthMarker };

/**
 * Enforces `@Scopes(...)` declarations against the validated API key's scopes.
 *
 * - If the route has no `@Scopes()` decorator → allow.
 * - If the request did not come in via an API key (e.g. session JWT) → allow.
 *   The human owner browsing their own UI always has full access.
 * - If the API key's scopes satisfy every required scope → allow.
 * - Otherwise → `403 Forbidden` with a list of missing scopes.
 *
 * Apply at the controller / handler level, *after* the auth guard:
 *
 * ```typescript
 * @UseGuards(JwtOrApiKeyAuthGuard, ScopesGuard)
 * @Get('/entities/:id')
 * @Scopes(SCOPES.MEMORY_READ)
 * async getEntity(...) { ... }
 * ```
 */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Scope[] | undefined>(SCOPES_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const req = this.extractRequest(context);
    const apiKeyAuth = req.apiKeyAuth;

    // No API-key marker → caller is a session JWT (the owner). Allow.
    if (!apiKeyAuth) {
      return true;
    }

    if (matchScopes(apiKeyAuth.scopes, required)) {
      return true;
    }

    throw new ForbiddenException({
      error: 'insufficient_scope',
      missing: missingScopes(apiKeyAuth.scopes, required),
      required,
    });
  }

  private extractRequest(context: ExecutionContext): RequestWithAuth {
    const kind = context.getType<string>();

    if (kind === 'graphql') {
      const ctx = GqlExecutionContext.create(context);
      const { req } = ctx.getContext();

      if (req == null) {
        throw new InternalServerErrorException('Request object not found in GraphQL context');
      }

      return req as RequestWithAuth;
    }

    if (kind === 'http') {
      return context.switchToHttp().getRequest<RequestWithAuth>();
    }

    throw new InternalServerErrorException(`${ScopesGuard.name} does not support context type: ${kind}`);
  }
}
