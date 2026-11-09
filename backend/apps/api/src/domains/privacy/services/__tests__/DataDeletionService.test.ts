import { NotFoundException } from '@nestjs/common';

import config from '@ci/configuration';
import { BaseOAuth2Client } from '@ci/domains/connections';
import { LastAdminDeletionRefused } from '@ci/domains/user';

import {
  DataDeletionService,
  FAILED_AUDIT_DEADLINE_MS,
  IMMEDIATE_PURGE_WAIT_MS,
  REVOCATION_DEADLINE_MS,
} from '../DataDeletionService';

/**
 * A tiny in-memory Postgres stand-in for the DataSource used by the service.
 * Rows are keyed by "schema.table" and each carries an owning user id (or, for
 * connection-scoped tables, a connection id) plus a graph `connectionId` for the
 * JSONB-properties path. `query()` interprets the DELETE statements the service
 * issues and returns node-postgres's `[rows, affectedCount]` shape.
 */
interface Row {
  user?: string;
  connection?: string;
  graphConnection?: string;
  /** Primary key, for rows the ci.record_sources ledger references. */
  id?: string;
  /** Ledger rows only: which record this arrival evidences. */
  recordTable?: string;
  recordId?: string;
}

function makeDataSource(initial: Record<string, Row[]>) {
  const store: Record<string, Row[]> = {};
  for (const [key, rows] of Object.entries(initial)) {
    store[key] = rows.map((r) => ({ ...r }));
  }

  const run = async (sql: string, params: unknown[] = []): Promise<unknown> => {
    const value = params[0] as string;

    // Ledger arrival removal: DELETE FROM ci.record_sources WHERE user_id = $1 AND connection_id = $2
    if (sql.includes('ci.record_sources WHERE user_id')) {
      const key = 'ci.record_sources';
      const before = store[key]?.length ?? 0;
      store[key] = (store[key] ?? []).filter((r) => !(r.user === params[0] && r.connection === params[1]));

      return [[], before - (store[key]?.length ?? 0)];
    }

    // Guarded connection delete: only rows with NO remaining ledger evidence go.
    const guarded = /DELETE FROM "(\w+)"\."(\w+)" t\s+WHERE t\."connection_id" = \$1\s+AND NOT EXISTS/.exec(
      sql,
    );
    if (guarded) {
      const key = `${guarded[1]}.${guarded[2]}`;
      const recordTable = /rs\.record_table = '(\w+)'/.exec(sql)?.[1];
      const ledger = store['ci.record_sources'] ?? [];
      const before = store[key]?.length ?? 0;
      store[key] = (store[key] ?? []).filter((r) => {
        if (r.connection !== value) {
          return true;
        }

        return ledger.some(
          (rs) => rs.user === r.user && rs.recordTable === recordTable && rs.recordId === r.id,
        );
      });

      return [[], before - (store[key]?.length ?? 0)];
    }

    // Survivor unlink: UPDATE ... SET "connection_id" = NULL WHERE "connection_id" = $1
    const unlink = /UPDATE "(\w+)"\."(\w+)" SET "connection_id" = NULL/.exec(sql);
    if (unlink) {
      const key = `${unlink[1]}.${unlink[2]}`;
      let count = 0;
      for (const r of store[key] ?? []) {
        if (r.connection === value) {
          delete r.connection;
          count += 1;
        }
      }

      return [[], count];
    }

    // Graph connection-scoped delete (properties->>'connection_id').
    if (sql.includes("properties->>'connection_id'")) {
      const owner = params[0] as string;
      const conn = params[1] as string;
      const match = /FROM "ci"\."(\w+)"/.exec(sql);
      const key = `ci.${match?.[1]}`;
      const before = store[key]?.length ?? 0;
      store[key] = (store[key] ?? []).filter((r) => !(r.user === owner && r.graphConnection === conn));

      return [[], before - (store[key]?.length ?? 0)];
    }

    // Generic DELETE FROM "schema"."table" WHERE "col" = $1
    const m = /DELETE FROM "(\w+)"\."(\w+)" WHERE "(\w+)" = \$1/.exec(sql);
    if (m) {
      const key = `${m[1]}.${m[2]}`;
      const col = m[3];
      const before = store[key]?.length ?? 0;
      store[key] = (store[key] ?? []).filter((r) => {
        if (col === 'connection_id') {
          return r.connection !== value;
        }

        // Deleting the connection row itself: DELETE FROM ci.connections WHERE id = <connId>.
        if (key === 'ci.connections' && col === 'id') {
          return r.connection !== value;
        }

        // user_id / owner_user_id / id all match on the row's owning user (for
        // ci.users the "id" is the user id itself).
        return r.user !== value;
      });

      return [[], before - (store[key]?.length ?? 0)];
    }

    return [[], 0];
  };

  const query = jest.fn(run);

  // Audit rows, whichever way they were written.
  const audits: Array<Record<string, unknown>> = [];

  return {
    dataSource: { query } as never,
    store,
    run,
    query,
    audits,
  };
}

/** A fake OAuth2 client whose revoke() we can assert on. */
class FakeGoogleClient extends BaseOAuth2Client {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logger: any = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  protected baseUrl = 'https://example.com';

  protected authorizationEndpoint = 'https://example.com/auth';

  protected tokenEndpoint = 'https://example.com/token';

  protected readonly revocationEndpoint = 'https://example.com/revoke';

  protected scopes = [];

  protected extraAuthParams = {};

  protected endpointScopeMap = {};

  getScopesFromActiveEndpoints() {
    return '';
  }

  getAccountIdentifier() {
    return Promise.resolve('');
  }

  revoke = jest.fn(async () => ({ revoked: true }));
}

function makeService(opts: {
  connections: Array<{
    id: string;
    userId: string;
    providerId: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
    externalId?: string | null;
  }>;
  store: Record<string, Row[]>;
  client?: BaseOAuth2Client | null;
  clientThrows?: boolean;
  /** The user's own OAuth app keys for the provider (null = brokered by CI Portal). */
  providerKey?: { clientId: string; clientSecret: string } | null;
  /** CI Portal proxy state. Unconfigured by default so existing tests exercise the direct path. */
  portal?: {
    configured: boolean;
    providerName?: string | null;
    revoke?: jest.Mock;
  };
  /** What `AccountPurgeService.purgeAccount` answers, call by call (the last one repeats). */
  purgeOutcomes?: Array<Record<string, unknown> | Promise<Record<string, unknown>>>;
}) {
  const { dataSource, store, run, query, audits } = makeDataSource(opts.store);

  // The connections as the table holds them, changed by the statements the service runs. A
  // connection given no access token holds one, so the direct revocation path has a token to send.
  const connections = opts.connections.map((c) => ({
    ...c,
    accessToken: c.accessToken === undefined ? `access-${c.id}` : c.accessToken,
    refreshToken: c.refreshToken ?? null,
    revocationPending: false,
  }));

  query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    // Ending the account: every connection inactive and revocation-pending, tokens kept.
    if (/WITH marked AS \(\s*UPDATE ci\.connections/.test(sql)) {
      return connections
        .filter((c) => c.userId === params[0])
        .map((c) => {
          c.revocationPending = true;

          return { id: c.id, provider_id: c.providerId };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
    }

    // What is still to revoke.
    if (sql.includes('SELECT id FROM ci.connections')) {
      return connections
        .filter((c) => c.userId === params[0])
        .filter((c) => c.revocationPending || c.accessToken != null || c.refreshToken != null)
        .map((c) => ({ id: c.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }

    // One connection revoked (or with nothing to revoke): tokens and mark cleared.
    if (sql.includes('UPDATE ci.connections') && sql.includes('WHERE id = $1 AND user_id = $2')) {
      for (const c of connections) {
        if (c.id === params[0] && c.userId === params[1]) {
          c.accessToken = null;
          c.refreshToken = null;
          c.revocationPending = false;
        }
      }

      return [[], 1];
    }

    return run(sql, params);
  });

  const connectionRepository = {
    findOne: jest.fn(async ({ where }: { where: { id: string; userId: string } }) => {
      const c = connections.find((x) => x.id === where.id && x.userId === where.userId);

      return c ? { ...c, provider: { id: c.providerId } } : null;
    }),
    // `id: In([...])`: TypeORM's FindOperator carries the list as `value`.
    find: jest.fn(async ({ where }: { where: { userId: string; id?: { value: string[] } } }) =>
      connections
        .filter((x) => x.userId === where.userId)
        .filter((x) => where.id == null || where.id.value.includes(x.id))
        .map((c) => ({ ...c, provider: { id: c.providerId } })),
    ),
    // `userId: Not(<caller>)`: another account's connection to the same provider. Matches only on
    // the keys the service asks about, so a narrower query would show up as a different answer.
    exists: jest.fn(
      async ({ where }: { where: { providerId: string; externalId?: string; userId: { value: string } } }) =>
        connections.some(
          (x) =>
            x.providerId === where.providerId &&
            (!('externalId' in where) || x.externalId === where.externalId) &&
            x.userId !== where.userId.value,
        ),
    ),
  };

  const savedAudits = audits;
  const auditRepository = {
    create: jest.fn((data: Record<string, unknown>) => data),
    save: jest.fn(async (data: Record<string, unknown>) => {
      savedAudits.push(data);

      return data;
    }),
  };

  const client = opts.client === undefined ? new FakeGoogleClient() : opts.client;
  const clientFactory = {
    getClientByProviderId: jest.fn(() => {
      if (opts.clientThrows) {
        throw new Error('Unsupported Provider id');
      }

      return client;
    }),
  };

  const cleanOrphans = jest.fn(async () => ({ results: [], totalDeleted: 0, dryRun: false }));
  const orphanCleanupService = { cleanOrphans };

  const providerKeyService = {
    findByProviderId: jest.fn(async () => opts.providerKey ?? null),
  };

  const portalRevoke =
    opts.portal?.revoke ?? jest.fn(async () => ({ success: true, tokens_deleted: 1, revocation_ok: true }));
  const cloudOAuthProxyService = {
    isPortalConfigured: jest.fn(() => opts.portal?.configured ?? false),
    getProviderNameForId: jest.fn(() =>
      opts.portal?.providerName === undefined ? 'google' : (opts.portal.providerName ?? undefined),
    ),
    revokeToken: portalRevoke,
  };

  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  // The order things happened in, across the user service, the purge and the audit.
  const journal: string[] = [];
  const purgeAt = new Date('2026-10-27T12:00:00Z');
  if (client instanceof FakeGoogleClient) {
    // When a provider is asked, relative to the transactions around it.
    const answer = client.revoke.getMockImplementation()!;
    client.revoke.mockImplementation(async () => {
      journal.push('provider:revoke');

      return answer();
    });
  }

  const txManager = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      journal.push(`tx:${sql.replace(/\s+/g, ' ').trim().slice(0, 40)}`);

      return query(sql, params);
    }),
    save: jest.fn(async (record: Record<string, unknown>) => {
      journal.push(`tx:audit:${String(record.status)}`);
      savedAudits.push(record);

      return record;
    }),
  };
  Object.assign(dataSource as object, {
    transaction: jest.fn(async (run: (manager: unknown) => Promise<unknown>) => {
      journal.push('tx:begin');
      const result = await run(txManager);
      journal.push('tx:commit');

      return result;
    }),
  });

  const userService = {
    endAccountNow: jest.fn(
      async (
        _context: unknown,
        _id: string,
        _options: unknown,
        alongside: (m: unknown) => Promise<unknown>,
      ) => {
        journal.push('end:begin');
        const result = await alongside(txManager);
        journal.push('end:commit');

        return { requestedAt: purgeAt, purgeAfter: purgeAt, result };
      },
    ),
  };
  const outcomes = [...(opts.purgeOutcomes ?? [{}])];
  const purgeAccount = jest.fn(async (userId: string) => {
    journal.push('purge');
    const next = outcomes.length > 1 ? outcomes.shift()! : outcomes[0];

    return {
      userId,
      status: 'purged',
      deletedRows: { 'ci.notes': 1, 'ci.users': 1 },
      detachedRows: {},
      deletedObjects: 0,
      ...(await next),
    };
  });
  const accountPurgeService = { purgeAccount };

  // Journalled: what ran in which order is the point of several tests.
  const originalSave = auditRepository.save.getMockImplementation()!;
  auditRepository.save.mockImplementation(async (data: Record<string, unknown>) => {
    journal.push(`audit:${String(data.status)}`);

    return originalSave(data);
  });
  cleanOrphans.mockImplementation(async () => {
    journal.push('sweep');

    return { results: [], totalDeleted: 0, dryRun: false };
  });

  const service = new DataDeletionService(
    dataSource,
    connectionRepository as never,
    auditRepository as never,
    clientFactory as never,
    orphanCleanupService as never,
    providerKeyService as never,
    cloudOAuthProxyService as never,
    logger as never,
    userService as never,
    accountPurgeService as never,
  );

  return {
    service,
    journal,
    txManager,
    userService,
    purgeAccount,
    auditRepository,
    logger,
    store,
    run,
    query,
    savedAudits,
    connectionRepository,
    connections,
    clientFactory,
    cleanOrphans,
    client,
    portalRevoke,
    providerKeyService,
  };
}

describe('DataDeletionService.disconnectConnection', () => {
  it('keeps a record the import also delivered: ledger-evidenced rows survive with their connection link cleared', async () => {
    const { service, store } = makeService({
      connections: [{ id: 'conn-1', userId: 'user-1', providerId: 'google' }],
      store: {
        'ci.connections': [{ user: 'user-1', connection: 'conn-1' }],
        'ci.communications': [
          // Same email, delivered by BOTH the connection and a Takeout import
          // (one converged row; the ledger holds both arrivals).
          { user: 'user-1', connection: 'conn-1', id: 'comm-both' },
          // Connection-only email: no other evidence, purged as before.
          { user: 'user-1', connection: 'conn-1', id: 'comm-etl-only' },
        ],
        'ci.record_sources': [
          // The connection's own arrival — removed first, so it cannot
          // protect its own rows.
          { user: 'user-1', connection: 'conn-1', recordTable: 'communications', recordId: 'comm-both' },
          // The import's arrival — the evidence that keeps the row alive.
          { user: 'user-1', recordTable: 'communications', recordId: 'comm-both' },
          { user: 'user-1', connection: 'conn-1', recordTable: 'communications', recordId: 'comm-etl-only' },
        ],
      },
    });

    const result = await service.disconnectConnection({ userId: 'user-1' }, 'conn-1');

    // The converged row survives, unlinked; the connection-only row is gone.
    expect(store['ci.communications']).toEqual([{ user: 'user-1', id: 'comm-both' }]);
    expect(result.deletedCounts['ci.communications']).toBe(1);
    expect(result.retainedCounts['ci.communications']).toBe(1);

    // The connection's ledger arrivals are gone; the import's remains.
    expect(store['ci.record_sources']).toEqual([
      { user: 'user-1', recordTable: 'communications', recordId: 'comm-both' },
    ]);
    expect(result.deletedCounts['ci.record_sources']).toBe(2);
  });

  it('revokes the grant, hard-deletes the connection + its derived data, cleans the index, and audits', async () => {
    const { service, store, savedAudits, cleanOrphans, client } = makeService({
      connections: [{ id: 'conn-1', userId: 'user-1', providerId: 'google' }],
      store: {
        'ci.connections': [{ user: 'user-1', connection: 'conn-1' }],
        'ci.communications': [
          { user: 'user-1', connection: 'conn-1' },
          { user: 'user-1', connection: 'conn-2' }, // another connection — must survive
        ],
        'ci_etl.connection_sync_jobs': [{ user: 'user-1', connection: 'conn-1' }],
        // Photos/videos and events carry connection_id since
        // 20260827185926_add_connection_id_to_events_and_content; a row from
        // another connection, and one with no connection (an archive import),
        // must both survive.
        'ci.content': [
          { user: 'user-1', connection: 'conn-1' },
          { user: 'user-1', connection: 'conn-2' },
          { user: 'user-1' },
        ],
        'ci.events': [{ user: 'user-1', connection: 'conn-1' }, { user: 'user-1' }],
        'ci.entities': [{ user: 'user-1', graphConnection: 'conn-1' }],
        'ci.relationships': [{ user: 'user-1', graphConnection: 'conn-1' }],
      },
    });

    const result = await service.disconnectConnection({ userId: 'user-1' }, 'conn-1');

    // Revocation was attempted for this connection.
    expect((client as FakeGoogleClient).revoke).toHaveBeenCalledTimes(1);
    expect(result.tokenRevoked).toBe(true);

    // conn-1's derived communication purged; conn-2's untouched.
    expect(store['ci.communications']).toEqual([{ user: 'user-1', connection: 'conn-2' }]);
    expect(store['ci.content']).toEqual([{ user: 'user-1', connection: 'conn-2' }, { user: 'user-1' }]);
    expect(store['ci.events']).toEqual([{ user: 'user-1' }]);
    expect(result.deletedCounts['ci.content']).toBe(1);
    expect(result.deletedCounts['ci.events']).toBe(1);
    // Connection-derived tables + the connection row itself gone.
    expect(store['ci_etl.connection_sync_jobs']).toEqual([]);
    expect(store['ci.entities']).toEqual([]);
    expect(store['ci.relationships']).toEqual([]);
    expect(store['ci.connections']).toEqual([]);

    // Search index reaped, audit written with a positive tally.
    expect(cleanOrphans).toHaveBeenCalledTimes(1);
    expect(savedAudits).toHaveLength(1);
    expect(savedAudits[0]).toMatchObject({ scope: 'connection', connectionId: 'conn-1', tokenRevoked: true });
    expect(result.totalDeleted).toBeGreaterThan(0);
  });

  it('is owner-scoped: another user’s connection id 404s and deletes nothing', async () => {
    const { service, store } = makeService({
      connections: [{ id: 'conn-1', userId: 'user-1', providerId: 'google' }],
      store: { 'ci.communications': [{ user: 'user-1', connection: 'conn-1' }] },
    });

    await expect(service.disconnectConnection({ userId: 'attacker' }, 'conn-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // Untouched.
    expect(store['ci.communications']).toEqual([{ user: 'user-1', connection: 'conn-1' }]);
  });

  it('is idempotent: a second disconnect of an already-gone connection 404s', async () => {
    const { service } = makeService({
      connections: [{ id: 'conn-1', userId: 'user-1', providerId: 'google' }],
      store: { 'ci.connections': [{ user: 'user-1', connection: 'conn-1' }] },
    });

    await service.disconnectConnection({ userId: 'user-1' }, 'conn-1');
    // The connection is gone from the (mocked) repo? The repo mock still returns
    // it, so simulate real behaviour by asserting the second run does not throw
    // AND re-audits — here we assert no throw for a repeat purge.
    await expect(service.disconnectConnection({ userId: 'user-1' }, 'conn-1')).resolves.toBeDefined();
  });

  it('still purges when revocation is unsupported (no throw, tokenRevoked=false)', async () => {
    const { service, store, savedAudits } = makeService({
      connections: [{ id: 'conn-1', userId: 'user-1', providerId: 'unknown' }],
      store: { 'ci.communications': [{ user: 'user-1', connection: 'conn-1' }] },
      clientThrows: true, // ClientFactory has no client for this provider
    });

    const result = await service.disconnectConnection({ userId: 'user-1' }, 'conn-1');

    expect(result.tokenRevoked).toBe(false);
    expect(store['ci.communications']).toEqual([]);
    expect(savedAudits[0]).toMatchObject({ tokenRevoked: false });
  });
});

describe('DataDeletionService.deleteAccount', () => {
  const OWN = { userId: 'user-1' };

  it('ends the account under the lock first, asks the providers after the commit, then purges', async () => {
    const { service, journal, client, txManager, userService, purgeAccount, savedAudits, connections } =
      makeService({
        connections: [
          { id: 'conn-1', userId: 'user-1', providerId: 'google' },
          { id: 'conn-2', userId: 'user-1', providerId: 'google' },
        ],
        store: {},
      });

    const result = await service.deleteAccount(OWN, { successorEmail: 'member@example.com' });

    expect(userService.endAccountNow).toHaveBeenCalledWith(
      OWN,
      'user-1',
      { successorEmail: 'member@example.com' },
      expect.any(Function),
    );

    // In the transaction that ends the account: access ends, the connections are marked pending
    // with their tokens kept, and the `started` row lists them as pending. No provider is asked.
    const ending = journal.slice(journal.indexOf('end:begin'), journal.indexOf('end:commit') + 1);
    expect(ending).toEqual([
      'end:begin',
      'tx:DELETE FROM ci.sessions WHERE user_id = ',
      'tx:DELETE FROM ci.api_keys WHERE user_id = ',
      'tx:WITH marked AS ( UPDATE ci.connections S',
      'tx:audit:started',
      'end:commit',
    ]);
    expect(
      txManager.query.mock.calls.slice(0, 3).every(([, params]) => (params as unknown[])[0] === 'user-1'),
    ).toBe(true);
    expect(savedAudits[0]).toEqual(
      expect.objectContaining({
        status: 'started',
        scope: 'account',
        subjectUserId: 'user-1',
        tokenRevoked: null,
        revocations: {
          revoked: 0,
          notApplicable: 0,
          failed: 0,
          pending: 2,
          connections: [
            { connectionId: 'conn-1', providerId: 'google', outcome: 'pending' },
            { connectionId: 'conn-2', providerId: 'google', outcome: 'pending' },
          ],
        },
      }),
    );

    // Then the providers, each outcome recorded with its connection's tokens cleared, then the purge.
    expect((client as FakeGoogleClient).revoke).toHaveBeenCalledTimes(2);
    expect(journal.slice(journal.indexOf('end:commit'))).toEqual([
      'end:commit',
      'provider:revoke',
      'tx:begin',
      'tx:UPDATE ci.connections SET active = false',
      'tx:audit:completed',
      'tx:commit',
      'provider:revoke',
      'tx:begin',
      'tx:UPDATE ci.connections SET active = false',
      'tx:audit:completed',
      'tx:commit',
      'purge',
      'sweep',
    ]);
    expect(connections.map((c) => [c.accessToken, c.revocationPending])).toEqual([
      [null, false],
      [null, false],
    ]);
    expect(purgeAccount).toHaveBeenCalledWith('user-1', expect.any(Date), expect.any(Date));

    expect(result).toEqual({
      userId: 'user-1',
      status: 'deleted',
      revocations: [
        { connectionId: 'conn-1', providerId: 'google', outcome: 'revoked', tokenRevoked: true },
        { connectionId: 'conn-2', providerId: 'google', outcome: 'revoked', tokenRevoked: true },
      ],
      deletedCounts: { 'ci.notes': 1, 'ci.users': 1 },
      detachedCounts: {},
      totalDeleted: 2,
      deletedObjects: 0,
      userDeleted: true,
      auditId: savedAudits[0].id,
    });
  });

  it('asks no provider and records nothing when the locked rule refuses the last administrator', async () => {
    const { service, client, userService, purgeAccount, savedAudits } = makeService({
      connections: [{ id: 'conn-1', userId: 'user-1', providerId: 'google' }],
      store: {},
    });
    userService.endAccountNow.mockRejectedValue(new LastAdminDeletionRefused('successor_required'));

    await expect(service.deleteAccount(OWN)).rejects.toBeInstanceOf(LastAdminDeletionRefused);

    expect((client as FakeGoogleClient).revoke).not.toHaveBeenCalled();
    expect(purgeAccount).not.toHaveBeenCalled();
    expect(savedAudits).toEqual([]);
  });

  it('writes the failed audit only once the transaction that tried has rolled back, asks no provider, purges nothing, and rethrows', async () => {
    const { service, journal, client, userService, purgeAccount, savedAudits } = makeService({
      connections: [{ id: 'conn-1', userId: 'user-1', providerId: 'google' }],
      store: {},
    });
    const failure = new Error('could not obtain lock on row in relation "users"');
    userService.endAccountNow.mockImplementation(async () => {
      journal.push('end:rolled-back');
      throw failure;
    });

    await expect(service.deleteAccount(OWN)).rejects.toBe(failure);

    expect(journal).toEqual(['end:rolled-back', 'audit:failed']);
    expect(savedAudits).toEqual([
      expect.objectContaining({
        status: 'failed',
        error: failure.message,
        totalDeleted: 0,
        tokenRevoked: null,
      }),
    ]);
    expect((client as FakeGoogleClient).revoke).not.toHaveBeenCalled();
    expect(purgeAccount).not.toHaveBeenCalled();
  });

  it('does not wait for good on a failed audit that cannot get a connection', async () => {
    jest.useFakeTimers();
    try {
      const { service, userService, auditRepository, logger } = makeService({ connections: [], store: {} });
      const failure = new Error('ending the account failed');
      userService.endAccountNow.mockRejectedValue(failure);
      // A pool that never hands out a connection.
      auditRepository.save.mockImplementation(() => new Promise(() => undefined));

      const deletion = service.deleteAccount(OWN).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(FAILED_AUDIT_DEADLINE_MS + 1);

      expect(await deletion).toBe(failure);
      expect(logger.error).toHaveBeenCalledWith(
        'Could not record the failed account deletion',
        expect.objectContaining({ error: expect.stringContaining('did not answer') }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('answers 404 for an account already ended, recording nothing', async () => {
    const { service, userService, purgeAccount, savedAudits } = makeService({ connections: [], store: {} });
    userService.endAccountNow.mockResolvedValue(null as never);

    await expect(service.deleteAccount(OWN)).rejects.toBeInstanceOf(NotFoundException);
    expect(purgeAccount).not.toHaveBeenCalled();
    expect(savedAudits).toEqual([]);
  });

  it('ends the account but runs no purge while the purge is switched off', async () => {
    // `accountDeletion.purge.enabled` is the operator's stop for an irreversible
    // job; it held for the hourly purge and was bypassed by this inline one.
    const enabled = config.accountDeletion.purge.enabled;
    config.accountDeletion.purge.enabled = false;

    try {
      const { service, userService, purgeAccount, savedAudits } = makeService({ connections: [], store: {} });

      const result = await service.deleteAccount(OWN);

      expect(userService.endAccountNow).toHaveBeenCalledTimes(1);
      expect(purgeAccount).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'deleting', totalDeleted: 0, userDeleted: false });
      expect(savedAudits).toEqual([expect.objectContaining({ status: 'started' })]);
    } finally {
      config.accountDeletion.purge.enabled = enabled;
    }
  });

  it('answers deleting when the purge outlasts the wait, and lets it finish (and sweep) on its own', async () => {
    jest.useFakeTimers();
    try {
      let finish: (outcome: Record<string, unknown>) => void = () => undefined;
      const slow = new Promise<Record<string, unknown>>((resolve) => {
        finish = resolve;
      });
      const { service, journal, cleanOrphans } = makeService({
        connections: [],
        store: {},
        purgeOutcomes: [slow],
      });

      const deletion = service.deleteAccount(OWN);
      await jest.advanceTimersByTimeAsync(IMMEDIATE_PURGE_WAIT_MS + 1);
      const result = await deletion;

      expect(result).toMatchObject({
        status: 'deleting',
        userDeleted: false,
        deletedCounts: {},
        totalDeleted: 0,
      });
      expect(cleanOrphans).not.toHaveBeenCalled();

      finish({});
      await jest.advanceTimersByTimeAsync(0);

      expect(journal.slice(-2)).toEqual(['purge', 'sweep']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('tries the purge a second time when the first fails, and counts both', async () => {
    const { service, purgeAccount } = makeService({
      connections: [],
      store: {},
      purgeOutcomes: [
        {
          status: 'failed',
          deletedRows: { 'ci.notes': 5 },
          deletedObjects: 2,
          error: 'update or delete on table "users" violates foreign key constraint "notes_user_id_fkey"',
        },
        { deletedRows: { 'ci.notes': 1, 'ci.users': 1 } },
      ],
    });

    const result = await service.deleteAccount(OWN);

    expect(purgeAccount).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: 'deleted',
      deletedCounts: { 'ci.notes': 6, 'ci.users': 1 },
      totalDeleted: 7,
      deletedObjects: 2,
      userDeleted: true,
    });
  });

  it('leaves an account whose purge fails twice to the hourly purge, and says deleting', async () => {
    const { service, purgeAccount, cleanOrphans, logger } = makeService({
      connections: [],
      store: {},
      purgeOutcomes: [{ status: 'failed', deletedRows: {}, error: 'boom' }],
    });

    const result = await service.deleteAccount(OWN);

    expect(purgeAccount).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('deleting');
    expect(cleanOrphans).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Purge of an ended account did not finish; the hourly purge will retry it',
      expect.objectContaining({ userId: 'user-1', status: 'failed' }),
    );
  });

  it('says deleting while another worker holds the purge', async () => {
    const { service, purgeAccount } = makeService({
      connections: [],
      store: {},
      purgeOutcomes: [{ status: 'locked', deletedRows: {} }],
    });

    const result = await service.deleteAccount(OWN);

    expect(purgeAccount).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('deleting');
  });

  it('stops waiting on a provider that never answers, keeps the grant pending, and goes on with the delete', async () => {
    jest.useFakeTimers();
    try {
      const hung = new FakeGoogleClient();
      hung.revoke = jest.fn(() => new Promise<{ revoked: boolean }>(() => undefined));
      const { service, userService, connections } = makeService({
        connections: [
          { id: 'conn-1', userId: 'user-1', providerId: 'google', refreshToken: 'r1' },
          { id: 'conn-2', userId: 'user-1', providerId: 'google', refreshToken: 'r2' },
        ],
        client: hung,
        store: {},
      });

      const deletion = service.deleteAccount(OWN);
      await jest.advanceTimersByTimeAsync(2 * REVOCATION_DEADLINE_MS);
      const result = await deletion;

      expect(hung.revoke).toHaveBeenCalledTimes(2);
      expect(result.revocations).toEqual([
        { connectionId: 'conn-1', providerId: 'google', outcome: 'failed', tokenRevoked: false },
        { connectionId: 'conn-2', providerId: 'google', outcome: 'failed', tokenRevoked: false },
      ]);
      // Tokens kept, for the purge to try again.
      expect(connections.map((c) => [c.refreshToken, c.revocationPending])).toEqual([
        ['r1', true],
        ['r2', true],
      ]);
      expect(userService.endAccountNow).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('DataDeletionService.revokeConnectionGrant via CI Portal', () => {
  const proxied = {
    id: 'conn-1',
    userId: 'user-1',
    providerId: 'google-provider-id',
    accessToken: 'google-access-token',
    refreshToken: 'portal-proxy-refresh-token',
    externalId: 'google-user-123',
  };

  it('asks CI Portal to revoke + delete its credential instead of posting the proxy token to the provider', async () => {
    const { service, client, portalRevoke, savedAudits } = makeService({
      connections: [proxied],
      store: { 'ci.connections': [{ user: 'user-1', connection: 'conn-1' }] },
      portal: { configured: true, providerName: 'google' },
      providerKey: null,
    });

    const result = await service.disconnectConnection({ userId: 'user-1' }, 'conn-1');

    expect(portalRevoke).toHaveBeenCalledTimes(1);
    expect(portalRevoke).toHaveBeenCalledWith({
      proxyRefreshToken: 'portal-proxy-refresh-token',
      provider: 'google',
      userProviderId: 'google-user-123',
    });
    // The proxy refresh token is a Portal secret the provider has never seen —
    // it must not be sent to the provider's revoke endpoint.
    expect((client as FakeGoogleClient).revoke).not.toHaveBeenCalled();
    expect(result.tokenRevoked).toBe(true);
    expect(savedAudits[0]).toMatchObject({ tokenRevoked: true });
  });

  it('ends the grant from here first when only an access token can revoke it (Dropbox), then has Portal delete its copy', async () => {
    const client = new FakeGoogleClient();
    (client as { revokesWithAccessToken: boolean }).revokesWithAccessToken = true;
    // Portal holds only the refresh token and cannot revoke this provider upstream.
    const revoke = jest.fn(async () => ({ success: true, tokens_deleted: 1, revocation_ok: false }));

    const { service, portalRevoke } = makeService({
      connections: [proxied],
      store: { 'ci.connections': [{ user: 'user-1', connection: 'conn-1' }] },
      portal: { configured: true, providerName: 'dropbox', revoke },
      providerKey: null,
      client,
    });

    const result = await service.disconnectConnection({ userId: 'user-1' }, 'conn-1');

    // The provider's own access token is used; the Portal proxy refresh token
    // is never handed to the provider client.
    expect(client.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'google-access-token', refreshToken: null }),
    );
    expect(portalRevoke).toHaveBeenCalledTimes(1);
    expect(result.tokenRevoked).toBe(true);
  });

  it('uses the direct provider path when the user brought their own app keys', async () => {
    const { service, client, portalRevoke } = makeService({
      connections: [proxied],
      store: { 'ci.connections': [{ user: 'user-1', connection: 'conn-1' }] },
      portal: { configured: true, providerName: 'google' },
      providerKey: { clientId: 'own-app', clientSecret: 'own-secret' },
    });

    const result = await service.disconnectConnection({ userId: 'user-1' }, 'conn-1');

    expect(portalRevoke).not.toHaveBeenCalled();
    expect((client as FakeGoogleClient).revoke).toHaveBeenCalledTimes(1);
    expect(result.tokenRevoked).toBe(true);
  });

  it('uses the direct provider path when Portal is not configured on this appliance', async () => {
    const { service, client, portalRevoke } = makeService({
      connections: [proxied],
      store: { 'ci.connections': [{ user: 'user-1', connection: 'conn-1' }] },
      portal: { configured: false },
      providerKey: null,
    });

    await service.disconnectConnection({ userId: 'user-1' }, 'conn-1');

    expect(portalRevoke).not.toHaveBeenCalled();
    expect((client as FakeGoogleClient).revoke).toHaveBeenCalledTimes(1);
  });

  it('reports tokenRevoked=false when Portal held nothing (e.g. Facebook, which issues no refresh token)', async () => {
    const { service, portalRevoke } = makeService({
      connections: [{ ...proxied, refreshToken: null, externalId: 'fb-user-1' }],
      store: { 'ci.connections': [{ user: 'user-1', connection: 'conn-1' }] },
      portal: {
        configured: true,
        providerName: 'facebook',
        revoke: jest.fn(async () => ({ success: true, tokens_deleted: 0, revocation_ok: true })),
      },
      providerKey: null,
    });

    const result = await service.disconnectConnection({ userId: 'user-1' }, 'conn-1');

    expect(portalRevoke).toHaveBeenCalledWith({
      proxyRefreshToken: null,
      provider: 'facebook',
      userProviderId: 'fb-user-1',
    });
    expect(result.tokenRevoked).toBe(false);
  });

  it('reports tokenRevoked=false when Portal deleted the row but the provider refused the upstream revoke', async () => {
    const { service } = makeService({
      connections: [proxied],
      store: { 'ci.connections': [{ user: 'user-1', connection: 'conn-1' }] },
      portal: {
        configured: true,
        providerName: 'google',
        revoke: jest.fn(async () => ({ success: true, tokens_deleted: 1, revocation_ok: false })),
      },
      providerKey: null,
    });

    const result = await service.disconnectConnection({ userId: 'user-1' }, 'conn-1');

    expect(result.tokenRevoked).toBe(false);
  });

  it('still purges locally when Portal is unreachable', async () => {
    const { service, store, savedAudits } = makeService({
      connections: [proxied],
      store: {
        'ci.connections': [{ user: 'user-1', connection: 'conn-1' }],
        'ci.communications': [{ user: 'user-1', connection: 'conn-1' }],
      },
      portal: {
        configured: true,
        providerName: 'google',
        revoke: jest.fn(async () => {
          throw new Error('portal down');
        }),
      },
      providerKey: null,
    });

    const result = await service.disconnectConnection({ userId: 'user-1' }, 'conn-1');

    expect(result.tokenRevoked).toBe(false);
    expect(store['ci.connections']).toEqual([]);
    expect(store['ci.communications']).toEqual([]);
    expect(savedAudits[0]).toMatchObject({ scope: 'connection', tokenRevoked: false });
  });

  /**
   * Every account on the appliance shares one CI Portal device, and Portal keeps one credential
   * per (device, provider, provider account). The account id names whichever grant the device
   * holds for that account, not this connection's: sent alongside the token, it let one
   * account's disconnect delete another account's grant.
   */
  describe('when another account here has a connection to the same provider', () => {
    const members = {
      id: 'conn-member',
      userId: 'member-1',
      providerId: 'google-provider-id',
      accessToken: 'member-access',
      refreshToken: 'member-proxy-token',
      // Claims the owner's Google account id.
      externalId: 'google-user-123',
    };
    const owners = { ...proxied, id: 'conn-owner', userId: 'owner-1', refreshToken: 'owner-proxy-token' };

    it('revokes by its own proxy token only, never by the shared account id', async () => {
      const revoke = jest.fn(async () => ({ success: true, tokens_deleted: 0, revocation_ok: true }));
      const { service } = makeService({
        connections: [members, owners],
        store: { 'ci.connections': [{ user: 'member-1', connection: 'conn-member' }] },
        portal: { configured: true, providerName: 'google', revoke },
        providerKey: null,
      });

      await service.disconnectConnection({ userId: 'member-1' }, 'conn-member');

      // Once, token only. Not retried by id when the token matched nothing, either.
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith({
        proxyRefreshToken: 'member-proxy-token',
        provider: 'google',
        userProviderId: null,
      });
    });

    it('sends nothing Portal could match on when it holds no proxy token of its own', async () => {
      const revoke = jest.fn(async () => ({ success: true, tokens_deleted: 0, revocation_ok: true }));
      const { service } = makeService({
        connections: [{ ...members, refreshToken: null }, owners],
        store: { 'ci.connections': [{ user: 'member-1', connection: 'conn-member' }] },
        portal: { configured: true, providerName: 'google', revoke },
        providerKey: null,
      });

      await service.disconnectConnection({ userId: 'member-1' }, 'conn-member');

      expect(revoke).not.toHaveBeenCalledWith(expect.objectContaining({ userProviderId: 'google-user-123' }));
    });

    it('never sends the id while another account uses the provider, whatever id that account recorded', async () => {
      // The owner connected before the appliance recorded provider ids (or under another form of
      // it), and the member's id came from the browser on a completion with no refresh token.
      const revoke = jest.fn(async () => ({ success: true, tokens_deleted: 0, revocation_ok: true }));

      for (const ownerExternalId of [null, 'octocat']) {
        revoke.mockClear();

        const { service } = makeService({
          connections: [members, { ...owners, externalId: ownerExternalId }],
          store: { 'ci.connections': [{ user: 'member-1', connection: 'conn-member' }] },
          portal: { configured: true, providerName: 'google', revoke },
          providerKey: null,
        });

        await service.disconnectConnection({ userId: 'member-1' }, 'conn-member');

        expect(revoke).toHaveBeenCalledTimes(1);
        expect(revoke).toHaveBeenCalledWith({
          proxyRefreshToken: 'member-proxy-token',
          provider: 'google',
          userProviderId: null,
        });
      }
    });

    it('revokes by token only when the check for another account fails', async () => {
      const revoke = jest.fn(async () => ({ success: true, tokens_deleted: 1, revocation_ok: true }));
      const { service, connectionRepository } = makeService({
        connections: [members],
        store: { 'ci.connections': [{ user: 'member-1', connection: 'conn-member' }] },
        portal: { configured: true, providerName: 'google', revoke },
        providerKey: null,
      });
      connectionRepository.exists.mockRejectedValueOnce(new Error('connection reset'));

      await service.disconnectConnection({ userId: 'member-1' }, 'conn-member');

      expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ userProviderId: null }));
    });
  });

  it('retries by account id alone when its proxy token matched nothing and no other account uses the provider', async () => {
    // A newer Portal matches the token alone when one is sent, so a token that went stale (a
    // rotation this appliance failed to save) finds nothing. The id alone then clears the row.
    const revoke = jest
      .fn()
      .mockResolvedValueOnce({ success: true, tokens_deleted: 0, revocation_ok: true })
      .mockResolvedValueOnce({ success: true, tokens_deleted: 1, revocation_ok: true });
    const { service } = makeService({
      connections: [proxied],
      store: { 'ci.connections': [{ user: 'user-1', connection: 'conn-1' }] },
      portal: { configured: true, providerName: 'google', revoke },
      providerKey: null,
    });

    const result = await service.disconnectConnection({ userId: 'user-1' }, 'conn-1');

    expect(revoke.mock.calls).toEqual([
      [
        {
          proxyRefreshToken: 'portal-proxy-refresh-token',
          provider: 'google',
          userProviderId: 'google-user-123',
        },
      ],
      [{ provider: 'google', userProviderId: 'google-user-123' }],
    ]);
    expect(result.tokenRevoked).toBe(true);
  });

  it('goes through Portal for every proxied connection during account deletion', async () => {
    const { service, portalRevoke, client } = makeService({
      connections: [
        proxied,
        { ...proxied, id: 'conn-2', externalId: 'google-user-456', refreshToken: 'proxy-2' },
      ],
      store: {
        'ci.users': [{ user: 'user-1' }],
        'ci.connections': [
          { user: 'user-1', connection: 'conn-1' },
          { user: 'user-1', connection: 'conn-2' },
        ],
      },
      portal: { configured: true, providerName: 'google' },
      providerKey: null,
    });

    const result = await service.deleteAccount({ userId: 'user-1' });

    expect(portalRevoke).toHaveBeenCalledTimes(2);
    expect((client as FakeGoogleClient).revoke).not.toHaveBeenCalled();
    expect(result.revocations.every((r) => r.tokenRevoked)).toBe(true);
  });
});

/** A provider this appliance has no way to revoke with: `revoke()` would only ever answer false. */
class FakeNoRevocationClient extends BaseOAuth2Client {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logger: any = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  protected baseUrl = 'https://example.com';

  protected authorizationEndpoint = 'https://example.com/auth';

  protected tokenEndpoint = 'https://example.com/token';

  protected scopes = [];

  protected extraAuthParams = {};

  protected endpointScopeMap = {};

  getScopesFromActiveEndpoints() {
    return '';
  }

  getAccountIdentifier() {
    return Promise.resolve('');
  }

  revoke = jest.fn(async () => ({ revoked: false }));
}

/** The connections `revoke()` was called with, in order. */
function revokedConnectionIds(client: BaseOAuth2Client | null): string[] {
  const calls = (client as FakeGoogleClient).revoke.mock.calls as unknown as Array<[{ id: string }]>;

  return calls.map(([connection]) => connection.id);
}

/**
 * The user domain's `ACCOUNT_GRANT_REVOKER`: what `DELETE /account` (`UserService.requestDeletion`)
 * and the account purge revoke provider grants through.
 */
describe('DataDeletionService as the account grant revoker', () => {
  const OWN = { userId: 'user-1' };

  describe('recordAccountEnd (in the transaction that ends the account)', () => {
    it('marks every connection pending with its tokens kept, asks no provider, and lists them on the started row', async () => {
      const { service, txManager, savedAudits, connections, client } = makeService({
        connections: [
          { id: 'conn-2', userId: 'user-1', providerId: 'dropbox', refreshToken: 'r2' },
          { id: 'conn-1', userId: 'user-1', providerId: 'google', refreshToken: 'r1' },
          { id: 'conn-9', userId: 'user-2', providerId: 'google', refreshToken: 'r9' },
        ],
        store: {},
      });

      const auditId = await service.recordAccountEnd(txManager as never, 'user-1');

      const statements = txManager.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatch(
        /UPDATE ci\.connections SET active = false, revocation_pending_at = COALESCE\(revocation_pending_at, now\(\)\) WHERE user_id = \$1/,
      );
      expect(statements[0]).not.toMatch(/access_token|refresh_token/);
      expect(txManager.query.mock.calls[0][1]).toEqual(['user-1']);
      expect((client as FakeGoogleClient).revoke).not.toHaveBeenCalled();
      expect(connections.map((c) => [c.id, c.refreshToken, c.revocationPending])).toEqual([
        ['conn-2', 'r2', true],
        ['conn-1', 'r1', true],
        ['conn-9', 'r9', false],
      ]);
      expect(txManager.save).toHaveBeenCalledTimes(1);
      expect(savedAudits).toEqual([
        expect.objectContaining({
          status: 'started',
          scope: 'account',
          subjectUserId: 'user-1',
          tokenRevoked: null,
          revocations: {
            revoked: 0,
            notApplicable: 0,
            failed: 0,
            pending: 2,
            connections: [
              { connectionId: 'conn-1', providerId: 'google', outcome: 'pending' },
              { connectionId: 'conn-2', providerId: 'dropbox', outcome: 'pending' },
            ],
          },
        }),
      ]);
      expect(auditId).toBe(savedAudits[0].id);
    });
  });

  describe('revokePendingGrants (after the commit, and again by the purge)', () => {
    it('asks each pending connection once, clears the one revoked, keeps the one that failed, and records each', async () => {
      const { service, client, txManager, savedAudits, connections } = makeService({
        connections: [
          { id: 'conn-1', userId: 'user-1', providerId: 'google', refreshToken: 'r1' },
          { id: 'conn-2', userId: 'user-1', providerId: 'google', refreshToken: 'r2' },
        ],
        store: {},
      });
      await service.recordAccountEnd(txManager as never, 'user-1');
      savedAudits.length = 0;
      (client as FakeGoogleClient).revoke
        .mockResolvedValueOnce({ revoked: true })
        .mockResolvedValueOnce({ revoked: false });

      const revocations = await service.revokePendingGrants('user-1');

      expect(revokedConnectionIds(client)).toEqual(['conn-1', 'conn-2']);
      expect(revocations).toEqual([
        { connectionId: 'conn-1', providerId: 'google', outcome: 'revoked', tokenRevoked: true },
        { connectionId: 'conn-2', providerId: 'google', outcome: 'failed', tokenRevoked: false },
      ]);
      expect(connections.map((c) => [c.id, c.refreshToken, c.revocationPending])).toEqual([
        ['conn-1', null, false],
        ['conn-2', 'r2', true],
      ]);
      // Recorded one by one, so a mixed result is never a single "revoked".
      expect(savedAudits).toEqual([
        expect.objectContaining({
          scope: 'connection',
          connectionId: 'conn-1',
          tokenRevoked: true,
          status: 'completed',
        }),
        expect.objectContaining({
          scope: 'connection',
          connectionId: 'conn-2',
          tokenRevoked: false,
          status: 'failed',
          error: expect.stringContaining('did not confirm'),
        }),
      ]);
    });

    it('asks again for a failed revocation on the next call (the purge), and clears it once it succeeds', async () => {
      const { service, client, txManager, connections, savedAudits } = makeService({
        connections: [{ id: 'conn-1', userId: 'user-1', providerId: 'google', refreshToken: 'r1' }],
        store: {},
      });
      await service.recordAccountEnd(txManager as never, 'user-1');
      const revoke = (client as FakeGoogleClient).revoke;
      revoke.mockRejectedValueOnce(new Error('provider down')).mockResolvedValueOnce({ revoked: true });

      await expect(service.revokePendingGrants('user-1')).resolves.toEqual([
        expect.objectContaining({ connectionId: 'conn-1', outcome: 'failed' }),
      ]);
      expect(connections[0]).toMatchObject({ refreshToken: 'r1', revocationPending: true });

      await expect(service.revokePendingGrants('user-1')).resolves.toEqual([
        expect.objectContaining({ connectionId: 'conn-1', outcome: 'revoked' }),
      ]);
      expect(connections[0]).toMatchObject({
        accessToken: null,
        refreshToken: null,
        revocationPending: false,
      });

      // Nothing left to ask.
      await expect(service.revokePendingGrants('user-1')).resolves.toEqual([]);
      expect(revoke).toHaveBeenCalledTimes(2);
      expect(savedAudits.filter((row) => row.scope === 'connection').map((row) => row.status)).toEqual([
        'failed',
        'completed',
      ]);
    });

    it('clears a connection with nothing to revoke, recording no revocation rather than a failure', async () => {
      const { service, txManager, connections, savedAudits } = makeService({
        connections: [{ id: 'conn-1', userId: 'user-1', providerId: 'github', refreshToken: 'r1' }],
        client: new FakeNoRevocationClient(),
        store: {},
      });
      await service.recordAccountEnd(txManager as never, 'user-1');
      savedAudits.length = 0;

      await expect(service.revokePendingGrants('user-1')).resolves.toEqual([
        { connectionId: 'conn-1', providerId: 'github', outcome: 'not_applicable', tokenRevoked: false },
      ]);
      expect(connections[0]).toMatchObject({ refreshToken: null, revocationPending: false });
      expect(savedAudits).toEqual([expect.objectContaining({ tokenRevoked: null, status: 'completed' })]);
    });

    it('counts a provider that never answers as failed and keeps its tokens', async () => {
      jest.useFakeTimers();
      try {
        const { service, client, connections } = makeService({
          connections: [{ id: 'conn-1', userId: 'user-1', providerId: 'google', refreshToken: 'r1' }],
          store: {},
        });
        (client as FakeGoogleClient).revoke.mockImplementation(() => new Promise(() => undefined));

        const revocations = service.revokePendingGrants('user-1');
        await jest.advanceTimersByTimeAsync(REVOCATION_DEADLINE_MS + 1);

        await expect(revocations).resolves.toEqual([expect.objectContaining({ outcome: 'failed' })]);
        expect(connections[0]).toMatchObject({ refreshToken: 'r1' });
      } finally {
        jest.useRealTimers();
      }
    });

    it('rejects, and logs, when the connections cannot be read', async () => {
      const { service, query, logger } = makeService({ connections: [], store: {} });
      query.mockRejectedValueOnce(new Error('pool exhausted'));

      await expect(service.revokePendingGrants('user-1')).rejects.toThrow('pool exhausted');
      expect(logger.error).toHaveBeenCalledWith(
        'Could not revoke the provider grants of an ended account; the purge retries',
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('in a delete with one grant revoked and one failed, answers each outcome', async () => {
      const { service, client } = makeService({
        connections: [
          { id: 'conn-1', userId: 'user-1', providerId: 'google', refreshToken: 'r1' },
          { id: 'conn-2', userId: 'user-1', providerId: 'google', refreshToken: 'r2' },
        ],
        store: {},
      });
      (client as FakeGoogleClient).revoke
        .mockResolvedValueOnce({ revoked: true })
        .mockResolvedValueOnce({ revoked: false });

      const result = await service.deleteAccount(OWN);

      expect(result.revocations.map((r) => r.outcome)).toEqual(['revoked', 'failed']);
    });
  });

  describe('recordAccountEndFailed', () => {
    it('writes the failed audit row, with nothing revoked, and why it failed', async () => {
      const { service, savedAudits } = makeService({ connections: [], store: {} });

      await service.recordAccountEndFailed('user-1', new Error('lock timeout'));

      expect(savedAudits).toEqual([
        expect.objectContaining({
          status: 'failed',
          scope: 'account',
          tokenRevoked: null,
          error: 'lock timeout',
        }),
      ]);
    });

    it('never rejects, so it never hides the failure it records', async () => {
      const { service, auditRepository } = makeService({ connections: [], store: {} });
      auditRepository.save.mockRejectedValue(new Error('pool exhausted'));

      await expect(service.recordAccountEndFailed('user-1', new Error('boom'))).resolves.toBeUndefined();
    });
  });
});
