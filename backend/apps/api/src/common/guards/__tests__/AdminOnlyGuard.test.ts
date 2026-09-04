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

  it('leaves admin bootstrapping to a migration that cannot fire on a fresh install', () => {
    // The actual blocker on gating /jobs, pinned where someone will read it.
    // 20260825233952 promotes the EARLIEST EXISTING user and only when no admin
    // exists; on a fresh install it runs against an empty ci.users, matches
    // nothing, and the first signup lands on the column default 'user'. So the
    // appliance has no admin and no in-app way to mint one.
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../../../db/postgres/migrations/20260825233952_add_role_to_users_backfill_admin.sql',
      ),
      'utf8',
    );

    expect(migration).toMatch(/AND NOT EXISTS \(\s*SELECT 1 FROM ci\.users WHERE role = 'admin'/);
    expect(migration).toMatch(/ORDER BY created_at ASC/);
  });
});
