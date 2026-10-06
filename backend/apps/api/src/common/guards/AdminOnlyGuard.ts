import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import type { PortalPrincipalMarker } from './PortalTokenVerifier';

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
 * return `userService.findById(...)`, and the Portal guards put `PortalPrincipal.user`, a whole
 * `User`, on the request (asserted in `__tests__/AdminOnlyGuard.test.ts`). A Portal principal also
 * leaves `request.portalPrincipal`, and one whose `admin` is false is refused here whatever its
 * role: only a token addressed to this appliance acts as its administrator.
 *
 * ═══ ADMIN BOOTSTRAPPING (was: THE REAL CAVEAT) ═══
 *
 * This guard used to be unreachable on a fresh appliance, and this comment used to say so. The
 * cause: nothing in application code ever wrote `role = 'admin'`. The only path was migration
 * 20260825233952, which promotes the earliest EXISTING user and only when no admin exists — on an
 * upgrade that found the owner, but on a FRESH install it ran against an empty `ci.users`, matched
 * nothing, and the first signup landed on the column default `'user'`. Those appliances had no
 * admin, permanently, so every route here returned 403 to everybody: all MCP server configuration
 * (including the outbound per-tool approval UI, which the web app renders and which therefore
 * failed for every user) and `GET /api/tools/invocations/system`, the only reader of the tool
 * ledger's `user_id IS NULL` rows.
 *
 * Both halves are now closed. `UserService.claimApplianceIfUnowned` promotes the account that
 * claims an unowned appliance, covering every appliance created from that release on, and
 * migration 20260910133657 re-runs the backfill for the fresh installs 20260825233952 could not
 * reach. Read those two for the reasoning; the short version is that on a single-owner personal
 * appliance the first account IS the owner, which is what `SignupController`'s first-account
 * exemption and `UserService.findAllOnboarded` already assumed.
 *
 * So a route may now be gated here without stranding new installs. `/jobs`' appliance-wide
 * controls still use {@link ApplianceAdminGuard}, which differs only on an appliance with no live
 * account at all (it admits there). It used to admit everyone whenever no live admin existed,
 * which let a member reach admin once the owner deleted their account; it no longer does. These
 * routes fail closed in every case, because stdio transport is arbitrary local command execution
 * and "unclaimed" is not a reason to hand that out.
 */
@Injectable()
export class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const role = (request?.user as { role?: string } | undefined)?.role;

    if (role !== 'admin') {
      throw new ForbiddenException('This action requires an administrator account');
    }

    // The owner's role says who they are, not that this bearer may act as them here. A Portal
    // token not addressed to this appliance carries the owner's role too.
    if ((request as PortalPrincipalMarker | undefined)?.portalPrincipal?.admin === false) {
      throw new ForbiddenException('This action needs a sign-in issued for this Memory');
    }

    return true;
  }
}
