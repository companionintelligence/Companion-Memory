import { Injectable, type ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Plan 07 — throttle by actor, not IP.
 *
 * The owner of a Hub commonly hits the API from many devices on the same NAT,
 * so IP-based throttling is hostile. Authenticated requests key on:
 *  - `req.apiKeyAuth.actorId` for API-key callers (set by ApiKeyStrategy).
 *  - `req.user.id` for session-JWT callers.
 *  - falling back to the remote IP for unauthenticated routes (login, signup).
 *
 * Also handles GraphQL execution context, where the express request lives at
 * `GqlExecutionContext.getContext().req`.
 */
@Injectable()
export class ActorThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const apiKeyAuth = req['apiKeyAuth'] as { actorId?: string } | undefined;
    if (apiKeyAuth?.actorId) {
      return `actor:${apiKeyAuth.actorId}`;
    }

    const user = req['user'] as { id?: string } | undefined;
    if (user?.id) {
      return `actor:${user.id}`;
    }

    const ip = (req['ip'] as string | undefined) ?? 'unknown';

    return `ip:${ip}`;
  }

  protected override getRequestResponse(context: ExecutionContext): {
    req: Record<string, unknown>;
    res: Record<string, unknown>;
  } {
    if (context.getType<string>() === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context).getContext<{
        req: Record<string, unknown>;
        res: Record<string, unknown>;
      }>();

      return { req: gqlCtx.req, res: gqlCtx.res };
    }

    return super.getRequestResponse(context);
  }
}
