import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

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
 * matched nothing on an empty `ci.users`.
 *
 * **That is fixed** (`UserService.claimApplianceIfUnowned` promotes the account
 * that claims an unowned appliance; migration 20260910133657 heals the installs
 * the original backfill could not reach), so the original objection no longer
 * holds. This guard stays anyway, and the difference from `AdminOnlyGuard` is
 * now a deliberate choice about failure mode rather than a workaround:
 *
 * It asks **is there an admin to require?** If yes, require one. If no, the
 * appliance is unclaimed and the request is admitted. For an appliance-wide
 * control plane that is the honest answer — an unclaimed box's job controls
 * should not be inert — whereas `AdminOnlyGuard` fails closed because the
 * routes behind it hand out arbitrary local command execution, where
 * "unclaimed" is not a reason to grant anything.
 *
 * With bootstrapping in place the permissive branch is now transitional rather
 * than the steady state: a fresh appliance has an admin from its first account
 * onward, so the branch only fires in the window before anyone can authenticate
 * at all, or if an owner later deletes their account (and the next account
 * created re-claims the box, by the same rule).
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 *
 * It was never a substitute for admin bootstrapping, and it did not close that
 * gap — a first-run promotion in application code did, and as this file
 * predicted, that turned this into a plain admin gate with no change to the
 * code below.
 *
 * It is still deliberately NOT applied to `AdminOnlyGuard`'s routes. Widening
 * that guard the same way would LOOSEN the MCP server-config routes on any
 * appliance that has lost its admin, handing arbitrary local command execution
 * to whoever is signed in. Tightening one surface must not silently open
 * another.
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
   * drifting. A failed admin probe still throws (`applianceHasAdmin` fails
   * closed); a caller that would rather read that as "no" must catch it.
   */
  async admits(user: { role?: string } | undefined): Promise<boolean> {
    if (user?.role === 'admin') {
      return true;
    }

    // Unclaimed appliance — nobody can be an admin here, so requiring one would
    // gate the control plane on a role that cannot be granted. Deliberately
    // permissive, and only in that one case.
    return !(await this.applianceHasAdmin());
  }

  /**
   * Whether any admin account exists.
   *
   * Not cached, on purpose. Every route behind this guard is an operator action
   * — clear terminal jobs, fire a cron, change a queue's mode — so this runs at
   * human frequency, not on the dashboard's 15-second poll. A TTL cache would
   * buy nothing measurable and would make a freshly promoted admin wait, or a
   * revoked one keep access, for reasons no operator could see.
   *
   * Fails CLOSED: a probe that cannot answer must not be read as "no admin
   * exists", which is the one answer that admits everybody.
   */
  private async applianceHasAdmin(): Promise<boolean> {
    try {
      const [row] = await this.dataSource.query<Array<{ present: boolean }>>(
        `SELECT EXISTS (
                  SELECT 1 FROM ci.users WHERE role = 'admin' AND deleted_at IS NULL
                ) AS present`,
      );

      return row?.present === true;
    } catch {
      throw new ForbiddenException('This action requires an administrator account');
    }
  }
}
