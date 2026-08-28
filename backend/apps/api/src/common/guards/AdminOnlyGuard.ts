import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/**
 * Refuses any request whose authenticated principal is not `role === 'admin'`
 * (`UserEntity.role` — see `domains/user/entities/UserEntity.ts`).
 *
 * The first `@Roles`/`@RequireRole`-style check in this codebase, so kept deliberately small:
 * one field read, no decorator/metadata machinery, because there is exactly one thing gated on it
 * today (mutating a user's MCP server configs — stdio transport is arbitrary local command
 * execution, a materially bigger capability than an api key, which is why this sits ABOVE the
 * existing `JwtOrPortalAuthGuard`/`JwtOrApiKeyAuthGuard` checks rather than replacing them).
 *
 * Must run after an auth guard that populates `request.user` (e.g. `JwtOrPortalAuthGuard`) —
 * combine as `@UseGuards(JwtOrPortalAuthGuard, AdminOnlyGuard)`. Deliberately has no dependency on
 * `UserService`/`UserModule`: guards in this directory stay free of `@ci/domains` imports (see
 * `PortalTokenVerifier`'s doc comment) to avoid a guard → auth → user → guard cycle, so this reads
 * only what the auth guard already put on the request.
 *
 * One consequence of that: a request authenticated via the portal-bearer path currently populates
 * `request.user` with only `{ id }` (see `PortalTokenVerifier.verifyAndProvision`), not the full
 * user record — so a portal-authenticated admin is refused here today, not just a non-admin. That
 * fails closed (403, not a bypass), and widening the portal principal to carry `role` is a change
 * to that path, not to this guard.
 */
@Injectable()
export class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const role = (request?.user as { role?: string } | undefined)?.role;

    if (role !== 'admin') {
      throw new ForbiddenException('This action requires an administrator account');
    }

    return true;
  }
}
