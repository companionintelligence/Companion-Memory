import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { Strategy } from 'passport';

import { ContextService, SYSTEM_USER } from '@ci/common/context';
import { type ApiKeyScopedRequest } from '@ci/common/guards';
import { extractBearerToken } from '@ci/common/guards/bearerToken';
import { UserService } from '@ci/domains/user';

import { ApiKeyService } from './ApiKeyService';

const API_KEY_HEADER = 'x-api-key';

/**
 * Read the api key from `x-api-key`, falling back to `Authorization: Bearer <key>`.
 *
 * `x-api-key` is non-standard for MCP: most clients expose a single bearer-token field and cannot
 * send a custom header at all, which made `/api/mcp` unreachable for them even though the endpoint
 * and the key were both fine. The Hub already authenticates its MCP surface with Bearer, so
 * accepting both here also removes a gratuitous difference between the two servers.
 *
 * Precedence is "first *usable* credential wins": a blank `x-api-key` (a proxy that always sets the
 * header) falls through to the bearer form rather than 401ing a request that carried a good key.
 *
 * This does not shadow session auth. On guards that chain jwt before api-key, a bearer JWT is
 * consumed by the jwt strategy first; only values it rejects reach here, and a JWT that got this far
 * fails ApiKeyService's `^[0-9a-f]{64}$` gate before any DB lookup. The portal OIDC path likewise
 * returns null for anything it cannot verify — note that it is handed this raw key first, but
 * `jose.jwtVerify` rejects a non-JWS string while parsing, before any JWKS fetch, so the key never
 * leaves the process.
 */
function extractApiKey(req: Request): string | null {
  const headerKey = req.get(API_KEY_HEADER)?.trim();

  if (headerKey) {
    return headerKey;
  }

  return extractBearerToken(req.get('authorization'));
}

/**
 * Minimal passport strategy that passes the incoming request to the verify
 * callback. This is functionally identical to what `passport-custom` provides
 * but avoids adding an unmaintained dependency for ~15 lines of code.
 */
class RequestStrategy extends Strategy {
  private _verify: (req: Request, done: (err: unknown, user?: unknown) => void) => void;

  constructor(verify: (req: Request, done: (err: unknown, user?: unknown) => void) => void) {
    super();
    this._verify = verify;
  }

  authenticate(req: Request) {
    this._verify(req, (err, user) => {
      if (err) {
        return this.error(err as Error);
      }

      if (!user) {
        return this.fail('Unauthorized', 401);
      }

      this.success(user as object);
    });
  }
}

@Injectable()
export class ApiKeyStrategy extends PassportStrategy(RequestStrategy, 'api-key') {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly userService: UserService,
  ) {
    super();
  }

  async validate(req: Request) {
    const apiKey = extractApiKey(req);

    if (!apiKey) {
      return null;
    }

    const result = await this.apiKeyService.validateKey(apiKey);

    if (!result) {
      return null;
    }

    const user = await this.userService.findById({ userId: SYSTEM_USER }, result.userId);

    if (!user) {
      return null;
    }

    ContextService.set({
      userId: user.id,
      // Also onto the async-local context, not only onto the request: services below the
      // controller (ToolRegistry, writing the tool-invocation ledger) never see the express
      // request, and "which agent key called" is exactly what that ledger exists to record.
      // `RequestContextMiddleware` cannot carry it — it runs before the guards, so nothing has
      // authenticated yet when it opens the store.
      apiKeyId: result.keyId,
    });

    // Expose the key's scopes so enforceApiKeyScopes (run inside the api-key auth
    // guards) can enforce @RequireScopes on the route. Absence of this field on
    // the request means "not an api-key principal" (full authority); an empty
    // array means a legacy full-access key.
    const scopedRequest = req as ApiKeyScopedRequest;

    scopedRequest.apiKeyScopes = result.scopes;
    // WHICH key authenticated, for surfaces that bind state to one caller's authority
    // (the MCP session map). Scopes alone cannot tell two keys apart — both chat-agent
    // connect keys carry an identical set on a single-owner appliance.
    scopedRequest.apiKeyId = result.keyId;
    // ...and WHAT it may do on the surfaces those scopes reach. Scopes decide which tools a key
    // can see; capability decides which of those it may run.
    scopedRequest.apiKeyCapability = result.capability;

    return user;
  }
}
