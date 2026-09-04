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
 * All three principals reaching this guard DO carry `role`: `JwtStrategy` and `ApiKeyStrategy` both
 * return `userService.findById(...)`, and `PortalTokenService.verifyAndProvision` returns a whole
 * `User` too — its interface merely used to say `{ id }` (now widened, and asserted in
 * `__tests__/AdminOnlyGuard.test.ts`). An earlier revision of this comment claimed the portal path
 * was refused here; it is not, and that claim was being cited as a reason not to admin-gate routes.
 *
 * ═══ THE REAL CAVEAT: A FRESH APPLIANCE HAS NO ADMIN AT ALL ═══
 *
 * Nothing in application code ever writes `role = 'admin'` — the only path is migration
 * 20260825233952, which promotes the earliest existing user and ONLY when no admin exists. On an
 * UPGRADE that finds the owner. On a FRESH install the migration runs against an empty `ci.users`,
 * matches nothing, and the first user then signs up on the column default `'user'` — so the
 * appliance has no admin, permanently, with no in-app way to mint one.
 *
 * Every route behind this guard is therefore unreachable on a fresh appliance. That is a live
 * problem for the MCP server-config routes already, and it is the reason `/jobs`' appliance-wide
 * controls are NOT gated here yet even though they should be: gating them today would take the
 * Jobs page's switches away from every new install. Admin bootstrapping has to land first.
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
