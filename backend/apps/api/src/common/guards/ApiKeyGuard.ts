import { type ExecutionContext, Injectable, InternalServerErrorException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AuthGuard } from '@nestjs/passport';

import { enforceApiKeyScopes } from './apiKeyScopeEnforcement';

@Injectable()
export class ApiKeyGuard extends AuthGuard('api-key') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  /**
   * Authenticate the api-key (via the passport strategy), then apply deny-by-
   * default scope enforcement now that `req.apiKeyScopes` is populated. A
   * scope-limited key is confined to routes that declare a scope it holds.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ok = (await super.canActivate(context)) as boolean;

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
      `${ApiKeyGuard.name} does not support context type: ${context.getType()}`,
    );
  }
}
