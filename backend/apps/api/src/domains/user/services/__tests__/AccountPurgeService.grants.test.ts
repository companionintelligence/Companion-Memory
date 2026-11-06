import { ACCOUNT_GRANT_REVOKER, type AccountGrantRevoker } from '../accountGrantRevoker';
import { AccountPurgeService } from '../AccountPurgeService';

/**
 * The purge revokes the provider grants an ended account still holds, before it deletes the
 * connection rows that hold the tokens. Both account deletes revoke and clear them when the account
 * ends, so this normally finds nothing; it is what catches an account ended before they did.
 *
 * The rows and the catalog are faked: the plan here is the user row alone. What the purge deletes
 * is covered against a real database by `AccountPurgeService.integration.spec.ts`.
 */
function makePurge(options: { locked?: boolean; revoker?: Partial<AccountGrantRevoker> | null } = {}) {
  const journal: string[] = [];

  const runner = {
    connect: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => undefined),
    commitTransaction: jest.fn(async () => undefined),
    rollbackTransaction: jest.fn(async () => undefined),
    isTransactionActive: false,
    query: jest.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) {
        journal.push('lock');

        return [{ locked: options.locked ?? true }];
      }

      if (sql.includes('pg_advisory_unlock')) {
        journal.push('unlock');

        return [];
      }

      if (sql.includes('INSERT INTO ci.account_purges')) {
        journal.push('mark-started');

        return [];
      }

      if (sql.includes('to_regclass') && sql.includes('AS present')) {
        return [{ present: false }];
      }

      if (sql.includes('FROM completed')) {
        journal.push('mark-completed');

        return [{ count: 1 }];
      }

      if (/^\s*(WITH|DELETE)[\s\S]*DELETE FROM/.test(sql)) {
        journal.push('delete');

        return [{ count: 1 }];
      }

      if (sql.includes('UPDATE ci.account_purges')) {
        journal.push('mark-failed');

        return [];
      }

      // The catalog reads: no table but the user row references the account.
      return [];
    }),
  };

  const dataSource = { createQueryRunner: jest.fn(() => runner), query: runner.query };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const revoker =
    options.revoker === null
      ? null
      : {
          revokeGrants: jest.fn(),
          recordAccountEnd: jest.fn(),
          recordAccountEndFailed: jest.fn(),
          revokeRemainingGrants: jest.fn(async () => {
            journal.push('revoke-remaining-grants');

            return [{ connectionId: 'conn-1', providerId: 'google', tokenRevoked: true }];
          }),
          ...options.revoker,
        };

  const moduleRef = revoker
    ? {
        get: jest.fn((token: string) => {
          if (token !== ACCOUNT_GRANT_REVOKER) {
            throw new Error(`no provider for ${token}`);
          }

          return revoker;
        }),
      }
    : undefined;

  const service = new AccountPurgeService(
    dataSource as never,
    logger as never,
    undefined,
    moduleRef as never,
  );

  return { service, journal, revoker, logger };
}

const REQUESTED = new Date('2026-10-01T00:00:00Z');
const DUE = new Date('2026-10-31T00:00:00Z');

describe('AccountPurgeService — provider grants', () => {
  it('revokes the remaining grants once, after taking the account, before deleting anything', async () => {
    const { service, journal, revoker } = makePurge();

    const outcome = await service.purgeAccount('user-1', REQUESTED, DUE);

    expect(outcome.status).toBe('purged');
    expect(revoker!.revokeRemainingGrants).toHaveBeenCalledTimes(1);
    expect(revoker!.revokeRemainingGrants).toHaveBeenCalledWith('user-1');
    expect(journal.slice(0, 3)).toEqual(['lock', 'mark-started', 'revoke-remaining-grants']);
    expect(journal).toContain('delete');
    expect(journal.indexOf('revoke-remaining-grants')).toBeLessThan(journal.indexOf('delete'));
  });

  it('deletes nothing, and fails for a retry, when the connections cannot be read or cleared', async () => {
    const { service, journal } = makePurge({
      revoker: {
        revokeRemainingGrants: jest.fn(async () => {
          throw new Error('connection pool exhausted');
        }),
      },
    });

    const outcome = await service.purgeAccount('user-1', REQUESTED, DUE);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('connection pool exhausted');
    expect(journal).not.toContain('delete');
    expect(journal).toContain('mark-failed');
    expect(journal).toContain('unlock');
  });

  it('revokes nothing while another worker holds the account', async () => {
    const { service, revoker } = makePurge({ locked: false });

    await expect(service.purgeAccount('user-1', REQUESTED, DUE)).resolves.toMatchObject({ status: 'locked' });
    expect(revoker!.revokeRemainingGrants).not.toHaveBeenCalled();
  });

  it('purges as before when nothing is bound to the token', async () => {
    const { service, journal } = makePurge({ revoker: null });

    await expect(service.purgeAccount('user-1', REQUESTED, DUE)).resolves.toMatchObject({ status: 'purged' });
    expect(journal).not.toContain('revoke-remaining-grants');
  });
});
