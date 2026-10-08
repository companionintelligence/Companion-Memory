import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { PortalPrincipalMarker } from './PortalTokenVerifier';

/**
 * Confines the APPLIANCE-WIDE control plane to an administrator — on any
 * appliance that has one.
 *
 * ── The hole this closes ───────────────────────────────────────────────────
 *
 * `@RequireCapability` looks like the gate on `/jobs`, and for a session it is
 * not one: `enforceApiKeyCapability` returns early when `request.apiKeyScopes`
 * is `undefined`, which is every JWT, Portal and cookie principal. So the
 * decorator governs exactly one axis — what an API KEY may do — and every route
 * carrying it was open to any signed-in user, however narrow their account.
 * That is not a bug in the decorator; capability is the key axis by design (see
 * `apiKeyScopeEnforcement.ts`). It is a bug in relying on it alone, because the
 * PRINCIPAL axis was never written. This is it.
 *
 * The two are complementary, not redundant, and both are load-bearing:
 * capability stops a `write` key (the DEFAULT level every new key is minted at)
 * from reaching a destructive route on an appliance with no admin, and this
 * stops a non-admin session — or a non-admin's `full` key — on one that has an
 * admin. Neither covers the other's case.
 *
 * ── Why not {@link AdminOnlyGuard} ─────────────────────────────────────────
 *
 * This guard was written when applying {@link AdminOnlyGuard} would have taken
 * the Jobs page's switches away from every fresh install, permanently, because
 * nothing in application code ever wrote `role = 'admin'` — the only path being
 * migration 20260825233952, which promotes the earliest EXISTING user and so
 * matched nothing on an empty `ci.users`. `UserService.claimApplianceIfUnowned`
 * and migration 20260910133657 fixed that, so every appliance with an account
 * has an admin from its first account onward.
 *
 * The one difference left is the appliance with NO live account at all, which
 * this guard still treats as unclaimed and admits. No signed-in person can be
 * standing on such a box, so in practice the two guards now agree.
 *
 * ── Live accounts but no live admin: refused ───────────────────────────────
 *
 * This guard used to admit everyone whenever no LIVE admin existed. That state
 * is not only "nobody has claimed the box yet": it is also what an owner leaves
 * behind by deleting their account while household members still have theirs
 * (`deleted_at` hides the owner's row, and its role with it). Every member then
 * passed this guard, and `POST /signup-codes` sits behind it, so a member could
 * mint an invitation and sign up a second account. The claim then promoted any
 * account created on an admin-less box, so that account became admin, which
 * reaches the MCP stdio transport and with it local command execution.
 *
 * Three rules close that, and this guard is the last of them:
 *
 * - `UserService.requestDeletion` refuses to delete the last live admin while
 *   other live accounts exist, unless the request names a successor.
 * - `UserService.claimApplianceIfUnowned` promotes only the appliance's first
 *   account ever, never "the next account after the owner left".
 * - Here, an appliance that has live accounts and no live admin is not
 *   unclaimed. It is an appliance whose admin is gone, and nobody on it is
 *   admitted until an operator names a new one (see `UserService`).
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 *
 * It was never a substitute for admin bootstrapping, and it did not close that
 * gap — a first-run promotion in application code did.
 *
 * Must run after an auth guard that populates `request.user` — combine as
 * `@UseGuards(JwtOrApiKeyAuthGuard, ApplianceAdminGuard)`. Like its sibling it
 * takes no dependency on `@ci/domains` (see `PortalTokenVerifier`'s comment for
 * the cycle that avoids); the admin probe is one SQL statement against a table
 * this file names, not a `UserService` call.
 */
@Injectable()
export class ApplianceAdminGuard implements CanActivate {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // As in AdminOnlyGuard: a Portal bearer that does not carry the user's admin authority here (one
    // from a Portal that predates addressing, or not addressed to this appliance) is refused,
    // whatever the user's role.
    if ((request as PortalPrincipalMarker | undefined)?.portalPrincipal?.admin === false) {
      throw new ForbiddenException('This action needs a sign-in issued for this Memory');
    }

    if (await this.admits(request?.user as { role?: string } | undefined)) {
      return true;
    }

    throw new ForbiddenException('This action requires an administrator account');
  }

  /**
   * The rule {@link canActivate} applies, as a boolean, for a caller that wants
   * to KNOW the answer rather than be refused by it — a settings page that
   * greys a control out instead of letting the click 403 (`canEdit` on
   * `GET /privacy/outbound`).
   *
   * One implementation, on purpose: a page that offered a control the route then
   * refused, or hid one the route would have allowed, would be two rules
   * drifting. A failed admin probe still throws (`probe` fails closed); a
   * caller that would rather read that as "no" must catch it.
   */
  async admits(user: { role?: string } | undefined, request?: PortalPrincipalMarker): Promise<boolean> {
    // The same refusal canActivate makes first, so a page asking here is not offered a control
    // the route would then refuse to this Portal bearer.
    if (request?.portalPrincipal?.admin === false) {
      return false;
    }

    if (user?.role === 'admin') {
      return true;
    }

    // Unclaimed appliance: no live account at all, so nobody can be an admin
    // yet and requiring one would gate the control plane on a role nobody can
    // hold. Live accounts with no live admin among them is NOT that: it is an
    // appliance whose admin is gone, and it stays closed.
    const { liveAdmin, liveAccounts } = await this.probe();

    return !liveAdmin && !liveAccounts;
  }

  /**
   * Whether a live admin exists, and whether any live account does.
   *
   * Not cached, on purpose. Every route behind this guard is an operator action
   * — clear terminal jobs, fire a cron, change a queue's mode — so this runs at
   * human frequency, not on the dashboard's 15-second poll. A TTL cache would
   * buy nothing measurable and would make a freshly promoted admin wait, or a
   * revoked one keep access, for reasons no operator could see.
   *
   * Fails CLOSED: a probe that cannot answer must not be read as "nobody is
   * here", which is the one answer that admits everybody.
   */
  private async probe(): Promise<{ liveAdmin: boolean; liveAccounts: boolean }> {
    try {
      const [row] = await this.dataSource.query<Array<{ admin: boolean; accounts: boolean }>>(
        `SELECT EXISTS (
                  SELECT 1 FROM ci.users WHERE role = 'admin' AND deleted_at IS NULL
                ) AS admin,
                EXISTS (
                  SELECT 1 FROM ci.users WHERE deleted_at IS NULL
                ) AS accounts`,
      );

      return { liveAdmin: row?.admin === true, liveAccounts: row?.accounts !== false };
    } catch {
      throw new ForbiddenException('This action requires an administrator account');
    }
  }
}
