import {
  ACCOUNT_GRANT_REVOKER,
  type AccountGrantRevoker,
  type GrantRevocation,
} from '../accountGrantRevoker';
import { AccountPurgeService, REVOCATION_RETRY_DAYS } from '../AccountPurgeService';

/**
 * The purge asks again for every provider grant an ended account still has pending, before it
 * deletes the connection rows that hold the tokens, and refuses to delete while one still fails.
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
          recordAccountEnd: jest.fn(),
          recordAccountEndFailed: jest.fn(),
          revokePendingGrants: jest.fn(async (): Promise<GrantRevocation[]> => {
            journal.push('revoke-pending-grants');

            return [REVOKED];
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

const REVOKED: GrantRevocation = {
  connectionId: 'conn-1',
  providerId: 'google',
  outcome: 'revoked',
  tokenRevoked: true,
};
const FAILED: GrantRevocation = {
  connectionId: 'conn-2',
  providerId: 'dropbox',
  outcome: 'failed',
  tokenRevoked: false,
};

const REQUESTED = new Date('2026-10-01T00:00:00Z');
/** Due an hour ago: inside the window in which a failed revocation holds the purge. */
const due = () => new Date(Date.now() - 60 * 60 * 1000);

describe('AccountPurgeService — provider grants', () => {
  it('asks again for the pending grants once, after taking the account, before deleting anything', async () => {
    const { service, journal, revoker } = makePurge();

    const outcome = await service.purgeAccount('user-1', REQUESTED, due());

    expect(outcome.status).toBe('purged');
    expect(revoker!.revokePendingGrants).toHaveBeenCalledTimes(1);
    expect(revoker!.revokePendingGrants).toHaveBeenCalledWith('user-1');
    expect(journal.slice(0, 3)).toEqual(['lock', 'mark-started', 'revoke-pending-grants']);
    expect(journal).toContain('delete');
    expect(journal.indexOf('revoke-pending-grants')).toBeLessThan(journal.indexOf('delete'));
  });

  it('deletes nothing and fails the run while a revocation still fails, then purges once it succeeds', async () => {
    const revokePendingGrants = jest
      .fn<Promise<GrantRevocation[]>, [string]>()
      .mockResolvedValueOnce([REVOKED, FAILED])
      .mockResolvedValueOnce([{ ...FAILED, outcome: 'revoked', tokenRevoked: true }]);
    const { service, journal } = makePurge({ revoker: { revokePendingGrants } });

    const first = await service.purgeAccount('user-1', REQUESTED, due());

    expect(first.status).toBe('failed');
    expect(first.error).toMatch(/1 provider grant revocation\(s\) failed \(conn-2\)/);
    expect(journal).not.toContain('delete');
    expect(journal).toContain('mark-failed');
    expect(journal).toContain('unlock');

    // The next run (the hourly retry) asks again, and this time the provider answers.
    const second = await service.purgeAccount('user-1', REQUESTED, due());

    expect(second.status).toBe('purged');
    expect(revokePendingGrants).toHaveBeenCalledTimes(2);
    expect(journal).toContain('delete');
  });

  it('goes on with the purge once the revocation has failed for longer than the retry window', async () => {
    const { service, journal, logger } = makePurge({
      revoker: { revokePendingGrants: jest.fn(async () => [FAILED]) },
    });
    const longAgo = new Date(Date.now() - (REVOCATION_RETRY_DAYS + 1) * 24 * 60 * 60 * 1000);

    await expect(service.purgeAccount('user-1', REQUESTED, longAgo)).resolves.toMatchObject({
      status: 'purged',
    });
    expect(journal).toContain('delete');
    expect(logger.error).toHaveBeenCalledWith(
      'Purging an account whose provider grants could not be revoked',
      expect.objectContaining({ connections: ['conn-2'] }),
    );
  });

  it('deletes nothing, and fails for a retry, when the connections cannot be read or cleared', async () => {
    const { service, journal } = makePurge({
      revoker: {
        revokePendingGrants: jest.fn(async () => {
          throw new Error('connection pool exhausted');
        }),
      },
    });

    const outcome = await service.purgeAccount('user-1', REQUESTED, due());

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('connection pool exhausted');
    expect(journal).not.toContain('delete');
    expect(journal).toContain('mark-failed');
  });

  it('asks nothing while another worker holds the account', async () => {
    const { service, revoker } = makePurge({ locked: false });

    await expect(service.purgeAccount('user-1', REQUESTED, due())).resolves.toMatchObject({
      status: 'locked',
    });
    expect(revoker!.revokePendingGrants).not.toHaveBeenCalled();
  });

  it('fails the run and deletes nothing when no revoker is bound', async () => {
    const { service, journal } = makePurge({ revoker: null });

    const outcome = await service.purgeAccount('user-1', REQUESTED, due());

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/No provider is bound to ACCOUNT_GRANT_REVOKER/);
    expect(journal).not.toContain('delete');
    expect(journal).toContain('mark-failed');
  });
});
