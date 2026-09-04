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
    // The deliberate, documented degradation, and the reason this guard can ship
    // where AdminOnlyGuard cannot. Nothing in application code writes
    // `role = 'admin'` — only migration 20260825233952, which promotes the
    // earliest EXISTING user and so matches nothing on a fresh install. Requiring
    // a role that cannot be granted would take the Jobs page's switches away from
    // every new appliance, permanently.
    const { dataSource } = dataSourceAnswering(false);

    await expect(new ApplianceAdminGuard(dataSource).canActivate(contextFor({ role: 'user' }))).resolves.toBe(
      true,
    );
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
