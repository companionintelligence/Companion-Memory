import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { enforceApiKeyAuthority } from './apiKeyScopeEnforcement';
import { requestFromContext } from './guardRequest';

@Injectable()
export class ApiKeyGuard extends AuthGuard('api-key') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  /**
   * Authenticate the api-key (via the passport strategy), then apply deny-by-
   * default scope and capability enforcement now that `req.apiKeyScopes` is
   * populated. A scope-limited key is confined to routes that declare a scope
   * it holds.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ok = (await super.canActivate(context)) as boolean;

    if (ok) {
      enforceApiKeyAuthority(this.reflector, context, this.getRequest(context));
    }

    return ok;
  }

  getRequest(context: ExecutionContext) {
    return requestFromContext(context, ApiKeyGuard.name);
  }
}
