import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { ApplianceAdminGuard } from '../ApplianceAdminGuard';

function contextFor(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

/** A DataSource whose only job is to answer the "is there an admin?" probe. */
function dataSourceAnswering(present: boolean | Error): {
  dataSource: DataSource;
  queries: string[];
} {
  const queries: string[] = [];

  const dataSource = {
    query: (sql: string) => {
      queries.push(sql);

      if (present instanceof Error) {
        return Promise.reject(present);
      }

      return Promise.resolve([{ present }]);
    },
  } as unknown as DataSource;

  return { dataSource, queries };
}

/**
 * The PRINCIPAL axis on the appliance-wide control plane.
 *
 * `@RequireCapability` is not this axis and never was: `enforceApiKeyCapability`
 * returns early when `request.apiKeyScopes` is undefined, which is every
 * session, JWT and Portal principal. So `POST /jobs/clear`, `POST /jobs/crons/run`
 * and `PUT /jobs/controls` carried a decorator that read as a gate and admitted
 * every signed-in user on the box. This guard is the missing half.
 */
describe('ApplianceAdminGuard', () => {
  it('admits an admin without asking the database anything', async () => {
    const { dataSource, queries } = dataSourceAnswering(true);

    await expect(
      new ApplianceAdminGuard(dataSource).canActivate(contextFor({ role: 'admin' })),
    ).resolves.toBe(true);
    expect(queries).toEqual([]);
  });

  it.each([['user'], ['readonly'], ['api_only']])(
    'refuses role %s once the appliance HAS an admin',
    async (role) => {
      const { dataSource } = dataSourceAnswering(true);

      await expect(
        new ApplianceAdminGuard(dataSource).canActivate(contextFor({ role })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('refuses a principal carrying no role at all', async () => {
    // Not a bypass: a role-less request is refused, never admitted. The guard
    // reads one untyped field, so this is worth pinning.
    const { dataSource } = dataSourceAnswering(true);
    const guard = new ApplianceAdminGuard(dataSource);

    await expect(guard.canActivate(contextFor({ id: 'u1' }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(contextFor(undefined))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admits a non-admin on an appliance that has NO admin', async () => {
    // The deliberate, documented degradation. This was once the steady state on
    // every fresh appliance, because nothing in application code wrote
    // `role = 'admin'`; now `UserService.claimApplianceIfUnowned` promotes the
    // first account, so the branch is transitional — it fires only before anyone
    // can authenticate at all, or after an owner deletes their account and
    // before the next one claims the box. Still pinned, because it is the
    // behaviour that distinguishes this guard from AdminOnlyGuard: an
    // appliance-wide control plane degrades open, arbitrary local command
    // execution degrades closed.
    const { dataSource } = dataSourceAnswering(false);

    await expect(new ApplianceAdminGuard(dataSource).canActivate(contextFor({ role: 'user' }))).resolves.toBe(
      true,
    );
  });

  it("refuses a Portal bearer without admin authority here, whatever the owner's role", async () => {
    // An owner's Portal token from a Portal that predates addressing keeps everything else, but
    // not the appliance's control plane, the same rule AdminOnlyGuard applies.
    const { dataSource, queries } = dataSourceAnswering(true);
    const request = { user: { role: 'admin' }, portalPrincipal: { admin: false } };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(new ApplianceAdminGuard(dataSource).canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(queries).toEqual([]);

    request.portalPrincipal.admin = true;
    await expect(new ApplianceAdminGuard(dataSource).canActivate(context)).resolves.toBe(true);
  });

  it('answers admits() as canActivate decides for that Portal bearer, so no page offers what the route refuses', async () => {
    const { dataSource, queries } = dataSourceAnswering(false);
    const guard = new ApplianceAdminGuard(dataSource);

    await expect(guard.admits({ role: 'admin' }, { portalPrincipal: { admin: false } })).resolves.toBe(false);
    expect(queries).toEqual([]);
    await expect(guard.admits({ role: 'admin' }, { portalPrincipal: { admin: true } })).resolves.toBe(true);
  });

  it('fails CLOSED when the probe cannot answer', async () => {
    // "I could not find out" must never be read as "there is no admin", which is
    // the one answer that admits everybody. A database that is down is also a
    // database whose job controls nobody needs to change.
    const { dataSource } = dataSourceAnswering(new Error('connection terminated'));

    await expect(
      new ApplianceAdminGuard(dataSource).canActivate(contextFor({ role: 'user' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('asks only about live admins, so a soft-deleted one does not gate the appliance', async () => {
    const { dataSource, queries } = dataSourceAnswering(true);

    await expect(
      new ApplianceAdminGuard(dataSource).canActivate(contextFor({ role: 'user' })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/role = 'admin'/);
    expect(queries[0]).toMatch(/deleted_at IS NULL/);
  });
});
