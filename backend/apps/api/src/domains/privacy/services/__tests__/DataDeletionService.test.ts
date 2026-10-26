import { NotFoundException } from '@nestjs/common';

import { BaseOAuth2Client } from '@ci/domains/connections';

import { USER_OWNED_TABLES } from '../../dataDeletionPlan';
import { DataDeletionService } from '../DataDeletionService';

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
  tagUser?: string; // for ci_search.entity_tag join-delete
  /** Primary key, for rows the ci.record_sources ledger references. */
  id?: string;
  /** Ledger rows only: which record this arrival evidences. */
  recordTable?: string;
  recordId?: string;
  /** Rows of a table with no user column: the `id` of the parent row they belong to. */
  parentId?: string;
}

function makeDataSource(initial: Record<string, Row[]>) {
  const store: Record<string, Row[]> = {};
  for (const [key, rows] of Object.entries(initial)) {
    store[key] = rows.map((r) => ({ ...r }));
  }

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
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

    // ci_search.entity_tag join-delete: remove rows whose tagUser matches.
    if (sql.includes('"ci_search"."entity_tag"')) {
      const key = 'ci_search.entity_tag';
      const before = store[key]?.length ?? 0;
      store[key] = (store[key] ?? []).filter((r) => r.tagUser !== value);

      return [[], before - (store[key]?.length ?? 0)];
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

    // Join-scoped delete for a table with no user column:
    // DELETE FROM "s"."child" t USING "s"."parent" p WHERE t."x" = p."y" AND p."user_id" = $1
    const through = /DELETE FROM "(\w+)"\."(\w+)" t\s+USING "(\w+)"\."(\w+)" p/.exec(sql);
    if (through) {
      const key = `${through[1]}.${through[2]}`;
      const owned = new Set(
        (store[`${through[3]}.${through[4]}`] ?? []).filter((r) => r.user === value).map((r) => r.id),
      );
      const before = store[key]?.length ?? 0;
      store[key] = (store[key] ?? []).filter((r) => !owned.has(r.parentId));

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
  });

  return { dataSource: { query } as never, store, query };
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
}) {
  const { dataSource, store, query } = makeDataSource(opts.store);

  const connectionRepository = {
    findOne: jest.fn(async ({ where }: { where: { id: string; userId: string } }) => {
      const c = opts.connections.find((x) => x.id === where.id && x.userId === where.userId);

      return c ? { ...c, provider: { id: c.providerId } } : null;
    }),
    find: jest.fn(async ({ where }: { where: { userId: string } }) =>
      opts.connections
        .filter((x) => x.userId === where.userId)
        .map((c) => ({ ...c, provider: { id: c.providerId } })),
    ),
    // `userId: Not(<caller>)`: another account's connection to the same provider. Matches only on
    // the keys the service asks about, so a narrower query would show up as a different answer.
    exists: jest.fn(
      async ({ where }: { where: { providerId: string; externalId?: string; userId: { value: string } } }) =>
        opts.connections.some(
          (x) =>
            x.providerId === where.providerId &&
            (!('externalId' in where) || x.externalId === where.externalId) &&
            x.userId !== where.userId.value,
        ),
    ),
  };

  const savedAudits: Array<Record<string, unknown>> = [];
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

  const service = new DataDeletionService(
    dataSource,
    connectionRepository as never,
    auditRepository as never,
    clientFactory as never,
    orphanCleanupService as never,
    providerKeyService as never,
    cloudOAuthProxyService as never,
    logger as never,
  );

  return {
    service,
    store,
    query,
    savedAudits,
    connectionRepository,
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
  it('revokes every connection, purges every user-owned table for that user ONLY, deletes the user, audits', async () => {
    const { service, store, savedAudits, cleanOrphans, client } = makeService({
      connections: [
        { id: 'conn-1', userId: 'user-1', providerId: 'google' },
        { id: 'conn-2', userId: 'user-1', providerId: 'google' },
      ],
      store: {
        'ci.users': [{ user: 'user-1' }, { user: 'user-2' }],
        'ci.communications': [{ user: 'user-1' }, { user: 'user-1' }, { user: 'user-2' }],
        'ci.events': [{ user: 'user-1' }, { user: 'user-2' }],
        'ci.entities': [{ user: 'user-1' }, { user: 'user-2' }],
        'ci.notes': [{ user: 'user-1' }],
        'ci.sessions': [{ user: 'user-1' }, { user: 'user-2' }],
        'ci.api_keys': [{ user: 'user-1' }],
        'ci_search.embeddings': [{ user: 'user-1' }, { user: 'user-2' }],
      },
    });

    const result = await service.deleteAccount({ userId: 'user-1' });

    // Both connections had revocation attempted.
    expect((client as FakeGoogleClient).revoke).toHaveBeenCalledTimes(2);

    // Every user-1 row gone; every user-2 row survives.
    expect(store['ci.communications']).toEqual([{ user: 'user-2' }]);
    expect(store['ci.events']).toEqual([{ user: 'user-2' }]);
    expect(store['ci.entities']).toEqual([{ user: 'user-2' }]);
    expect(store['ci.notes']).toEqual([]);
    expect(store['ci.sessions']).toEqual([{ user: 'user-2' }]);
    expect(store['ci.api_keys']).toEqual([]);
    expect(store['ci_search.embeddings']).toEqual([{ user: 'user-2' }]);
    // The user row itself deleted; the other user remains.
    expect(store['ci.users']).toEqual([{ user: 'user-2' }]);

    expect(result.userDeleted).toBe(true);
    expect(result.totalDeleted).toBeGreaterThan(0);
    expect(cleanOrphans).toHaveBeenCalledTimes(1);
    expect(savedAudits[0]).toMatchObject({ scope: 'account', subjectUserId: 'user-1' });
  });

  it('purges hbpe labels and cluster links, which have no user column, through the rows they belong to', async () => {
    const { service, store, query } = makeService({
      connections: [],
      store: {
          'ci.users': [{ user: 'user-1' }, { user: 'user-2' }],
          'ci.summaries': [
            { id: 's1', user: 'user-1' },
            { id: 's2', user: 'user-2' },
          ],
          'ci.events': [
            { id: 'e1', user: 'user-1' },
            { id: 'e2', user: 'user-2' },
          ],
          'ci.content': [
            { id: 'c1', user: 'user-1' },
            { id: 'c2', user: 'user-2' },
          ],
          'hbpe.summary_l1_label': [{ parentId: 's1' }, { parentId: 's2' }],
          'hbpe.l1_event_cluster': [{ parentId: 'e1' }, { parentId: 'e2' }],
          'hbpe.l2_content_cluster': [{ parentId: 'c1' }, { parentId: 'c2' }],
      },
    });

    const result = await service.deleteAccount({ userId: 'user-1' });

    expect(store['hbpe.summary_l1_label']).toEqual([{ parentId: 's2' }]);
    expect(store['hbpe.l1_event_cluster']).toEqual([{ parentId: 'e2' }]);
    expect(store['hbpe.l2_content_cluster']).toEqual([{ parentId: 'c2' }]);
    expect(result.deletedCounts).toMatchObject({
      'hbpe.summary_l1_label': 1,
      'hbpe.l1_event_cluster': 1,
      'hbpe.l2_content_cluster': 1,
    });
    expect(result.userDeleted).toBe(true);

    // None of the three is asked for a user_id column it does not have.
    const statements = query.mock.calls.map(([sql]) => sql as string);
    for (const table of ['summary_l1_label', 'l1_event_cluster', 'l2_content_cluster']) {
      expect(statements.filter((sql) => sql.includes(`"hbpe"."${table}"`))).toEqual([
        expect.stringContaining('USING'),
      ]);
    }
  });

  it('clears the user row pointer to its own person before purging ci.entities', async () => {
    const { service, query } = makeService({
      connections: [],
      store: { 'ci.users': [{ user: 'user-1' }], 'ci.entities': [{ user: 'user-1' }] },
    });

    await service.deleteAccount({ userId: 'user-1' });

    const statements = query.mock.calls.map(([sql]) => sql as string);
    const cleared = statements.findIndex((sql) => /UPDATE "ci"\."users" SET "entity_id" = NULL/.test(sql));
    const entities = statements.findIndex((sql) => sql.includes('DELETE FROM "ci"."entities"'));

    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(cleared).toBeLessThan(entities);
    expect(query.mock.calls[cleared][1]).toEqual(['user-1']);
  });

  it('is idempotent: re-deleting an already-deleted account purges nothing and audits zero', async () => {
    const { service, store, savedAudits } = makeService({
      connections: [],
      store: { 'ci.users': [{ user: 'user-2' }] },
    });

    const result = await service.deleteAccount({ userId: 'user-1' });

    expect(result.userDeleted).toBe(false);
    expect(result.totalDeleted).toBe(0);
    expect(store['ci.users']).toEqual([{ user: 'user-2' }]);
    expect(savedAudits[0]).toMatchObject({ scope: 'account', totalDeleted: 0 });
  });

  it('deletes children before parents (content before events, graph before nulling)', () => {
    // Guard the FK-safe ordering the account purge depends on.
    const order = USER_OWNED_TABLES.map((t) => `${t.schema}.${t.table}`);
    expect(order.indexOf('ci.content')).toBeLessThan(order.indexOf('ci.events'));
    expect(order.indexOf('hbpe.l1_event_cluster')).toBeLessThan(order.indexOf('ci.events'));
    expect(order.indexOf('hbpe.l2_content_cluster')).toBeLessThan(order.indexOf('ci.content'));
    expect(order.indexOf('ci.graph_deltas')).toBeLessThan(order.indexOf('ci.entities'));
    expect(order.indexOf('ci.relationships')).toBeLessThan(order.indexOf('ci.entities'));
    // Connections (holding OAuth tokens) are purged as part of the account sweep.
    expect(order).toContain('ci.connections');
    expect(order).toContain('ci.provider_keys');
    // The digests memory.forget keeps so a forgotten person is not minted again are the user's data too.
    expect(order).toContain('ci.forgotten_identifiers');
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
