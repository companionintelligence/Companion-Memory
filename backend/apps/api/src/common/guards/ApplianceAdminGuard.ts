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
 * Because applying it today would take the Jobs page's switches away from every
 * fresh install, permanently. Nothing in application code ever writes
 * `role = 'admin'`: the only path is migration 20260825233952, which promotes
 * the earliest EXISTING user and only when no admin exists. On an upgrade that
 * finds the owner; on a fresh install it runs against an empty `ci.users`, the
 * first signup lands on the column default `'user'`, and the appliance has no
 * admin and no in-app way to mint one. `AdminOnlyGuard`'s own doc says so, and
 * cites it as the reason `/jobs` is not gated.
 *
 * So this guard asks the question that is actually answerable: **is there an
 * admin to require?** If yes, require one. If no, the appliance is unclaimed and
 * the request is admitted — exactly today's behaviour, not worse. That makes it
 * a strict tightening on every appliance where it can mean anything, with no
 * install left locked out of its own job controls.
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 *
 * It is not a substitute for admin bootstrapping, and it must not be read as
 * closing that gap. On an appliance with no admin this admits everyone, and
 * that is the honest state of the system rather than a decision made here.
 * Once a first-run promotion exists in application code, every appliance has an
 * admin and this becomes a plain admin gate with no change to this file.
 *
 * It is also deliberately NOT applied to `AdminOnlyGuard`'s existing routes.
 * Widening that guard the same way would LOOSEN the MCP server-config routes
 * (stdio transport is arbitrary local command execution), which are today
 * unreachable rather than open on a fresh appliance. Tightening one surface must
 * not silently open another.
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
    const role = (request?.user as { role?: string } | undefined)?.role;

    if (role === 'admin') {
      return true;
    }

    // Unclaimed appliance — nobody can be an admin here, so requiring one would
    // gate the control plane on a role that cannot be granted. Deliberately
    // permissive, and only in that one case.
    if (!(await this.applianceHasAdmin())) {
      return true;
    }

    throw new ForbiddenException('This action requires an administrator account');
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
