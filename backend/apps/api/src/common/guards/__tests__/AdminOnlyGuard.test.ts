import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';

import { AdminOnlyGuard } from '../AdminOnlyGuard';

function contextFor(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('AdminOnlyGuard', () => {
  const guard = new AdminOnlyGuard();

  it('admits an admin', () => {
    expect(guard.canActivate(contextFor({ id: 'u1', role: 'admin' }))).toBe(true);
  });

  it.each([['user'], ['readonly'], ['api_only']])('refuses role %s', (role) => {
    expect(() => guard.canActivate(contextFor({ id: 'u1', role }))).toThrow(ForbiddenException);
  });

  it('fails closed on a principal with no role at all', () => {
    // Not a bypass: an unauthenticated or role-less request is refused, never
    // admitted. Worth pinning because the guard reads one untyped field.
    expect(() => guard.canActivate(contextFor({ id: 'u1' }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(ForbiddenException);
  });
});

/**
 * ═══ WHY THIS SUITE READS SOURCE ═══
 *
 * The guard is four lines; what actually decides whether a route can be gated
 * behind it is whether a `role` ever reaches `request.user`, and whether any
 * admin exists to hold one. Both are facts about OTHER files, and both were
 * stated wrongly in review: the AdminOnlyGuard doc claimed portal principals
 * carry no role (they do), which was then cited as the reason not to
 * admin-gate the appliance-wide `/jobs` controls.
 *
 * Asserted by reading the sources rather than by standing up three auth
 * strategies, a JWKS endpoint and a database — the claims are about which
 * value each strategy returns, which is visible in the text and would
 * otherwise be re-litigated from memory every time.
 */
describe('the preconditions for gating a route behind AdminOnlyGuard', () => {
  const src = (path: string) => readFileSync(resolve(__dirname, '..', '..', '..', path), 'utf8');

  /**
   * One method of a class, from its signature to the closing brace at
   * class-member indentation, so a claim about `create()` cannot be satisfied by
   * text that happens to sit in another method.
   */
  const methodSource = (source: string, name: string): string => {
    const start = source.search(new RegExp(`^  (?:private |public )?(?:async )?${name}\\(`, 'm'));
    const end = start < 0 ? -1 : source.indexOf('\n  }\n', start);

    if (end < 0) {
      throw new Error(`could not find ${name}() in the source this suite reads`);
    }

    return source.slice(start, end);
  };

  it.each([['domains/auth/services/JwtStrategy.ts'], ['domains/auth/services/ApiKeyStrategy.ts']])(
    '%s resolves the full user record, so role reaches the request',
    (path) => {
      // Both return `userService.findById(...)`, whose egress type carries `role`
      // (UserEntity.toEgressType). Neither projects a narrower principal.
      expect(src(path)).toMatch(/return user;/);
      expect(src(path)).toMatch(/userService\.findById/);
    },
  );

  it('the portal verifier promises a role rather than only an id', () => {
    // The claim this pins is the one that was wrong. PortalTokenService has
    // always returned a whole `User`; the INTERFACE said `{ id: string }`,
    // which read as "portal principals cannot be admins".
    expect(src('common/guards/PortalTokenVerifier.ts')).toMatch(
      /verifyAndProvision\(token: string\): Promise<\{ id: string; role\?: string \} \| null>;/,
    );
  });

  it('has an admin to require, because application code promotes the first account', () => {
    // ═══ THIS TEST USED TO ASSERT THE OPPOSITE ═══
    //
    // It pinned the fact that admin bootstrapping existed ONLY in migration
    // 20260825233952, which promotes the earliest EXISTING user and therefore
    // matched nothing on a fresh install — leaving the appliance permanently
    // admin-less and every route behind this guard 403 for everybody. That was
    // a real defect being pinned as if it were a design note, which is exactly
    // how it survived: gating a route here was refused on its authority.
    //
    // `UserService.claimApplianceIfUnowned` is the fix, and this asserts the
    // two properties the guard depends on — that it writes the role at all, and
    // that its "unowned" test is the same one ApplianceAdminGuard applies.
    const service = src('domains/user/services/UserService.ts');

    expect(service).toMatch(/claimApplianceIfUnowned/);
    expect(service).toMatch(/SET role = 'admin'/);
    expect(service).toMatch(/role = 'admin' AND deleted_at IS NULL/);

    // Called from insertAccount(), the one method that writes an account, inside
    // the transaction that does, under the lock every creation takes. Both public
    // ways in go through it: create(), and createFirstAccount() for the doors that
    // admit someone without an invitation. So every user-creation site (local
    // signup, portal JIT-provisioning, the Hub forward-auth bridge, and both OIDC
    // paths) is promoted. Promoting in any one caller would leave the others able
    // to create the first account unpromoted.
    expect(methodSource(service, 'insertAccount')).toMatch(
      /await this\.claimApplianceIfUnowned\(manager, saved\.id\)/,
    );
    expect(methodSource(service, 'create')).toMatch(
      /this\.insertAccount\(\s*data,\s*\{\s*onlyIfFirst:\s*false\s*\}\s*\)/,
    );
    expect(methodSource(service, 'createFirstAccount')).toMatch(
      /this\.insertAccount\(\s*data,\s*\{\s*onlyIfFirst:\s*true,\s*alongside\s*\}\s*\)/,
    );
  });

  it('heals the fresh installs the original backfill could not reach', () => {
    // 20260825233952 runs once and cannot be re-run to pick up a fix, so the
    // appliances it missed need their own migration.
    const heal = readFileSync(
      resolve(
        __dirname,
        '../../../../db/postgres/migrations/20260910133657_bootstrap_first_user_as_admin.sql',
      ),
      'utf8',
    );

    expect(heal).toMatch(/ORDER BY created_at ASC/);
    // Scoped to live admins, unlike its predecessor — an appliance whose only
    // admin had deleted their account looked "already promoted" to that one.
    expect(heal).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM ci\.users WHERE role = 'admin' AND deleted_at IS NULL/,
    );
  });
});
