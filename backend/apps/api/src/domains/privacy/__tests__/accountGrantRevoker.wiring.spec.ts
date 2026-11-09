import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import {
  BaseOAuth2Client,
  ClientFactory,
  CloudOAuthProxyService,
  ConnectionEntity,
  ProviderKeyService,
} from '@ci/domains/connections';
import { EventService } from '@ci/domains/events';
import { ACCOUNT_GRANT_REVOKER, UserEntity, UserService } from '@ci/domains/user';

import { STUBBED_MODULES, createQuietLogger } from '../../../../scripts/support/admin-testing-module';
import { App } from '../../../application';
import { DataDeletionAuditEntity } from '../entities/DataDeletionAuditEntity';
import { DataDeletionService } from '../services/DataDeletionService';

/**
 * `UserService.requestDeletion` (the Profile page's "Delete account") finds the grant revoker by its
 * token at call time, from a module that cannot import the one that binds it. Every unit test hands
 * it a revoker by hand, so nothing there shows the real binding exists. This builds the application
 * module graph, as `make seed` and `ChatTurnService.di.test.ts` do (with the real PrivacyModule and
 * UserModule), and deletes an account through it: the token must resolve to the privacy domain's
 * DataDeletionService, and the provider must be asked.
 *
 * No Postgres: `compile()` constructs providers without running lifecycle hooks, the repositories
 * and the DataSource are fakes that answer the statements this path runs, and the provider client
 * is a fake whose `revoke()` is the assertion.
 */
class FakeProviderClient extends BaseOAuth2Client {
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

const USER = 'user-1';

/** What the account's one connection looks like as the table holds it. */
const connection = {
  id: 'conn-1',
  userId: USER,
  providerId: 'provider-1',
  accessToken: 'access-1' as string | null,
  refreshToken: 'refresh-1' as string | null,
  externalId: null,
  pending: false,
};

const statements: string[] = [];

/** Every statement the delete runs, answered the way Postgres would for one member account. */
async function answer(sql: string, params: unknown[] = []): Promise<unknown> {
  statements.push(sql.replace(/\s+/g, ' ').trim());

  if (sql.includes('FOR UPDATE')) {
    return [{ id: USER, role: 'user' }];
  }

  if (/WITH marked AS \(\s*UPDATE ci\.connections/.test(sql)) {
    connection.pending = true;

    return [{ id: connection.id, provider_id: connection.providerId }];
  }

  if (sql.includes('SELECT id FROM ci.connections')) {
    return connection.pending || connection.accessToken || connection.refreshToken
      ? [{ id: connection.id }]
      : [];
  }

  if (sql.includes('UPDATE ci.connections') && params[0] === connection.id) {
    connection.accessToken = null;
    connection.refreshToken = null;
    connection.pending = false;
  }

  return [[], 0];
}

const manager = {
  query: jest.fn(answer),
  update: jest.fn(async () => ({ affected: 1 })),
  save: jest.fn(async (record: unknown) => record),
};

// A Proxy repository for every entity this test does not override. `then` stays undefined: Nest
// awaits provider instances, and a thenable that never calls back hangs it.
const fakeRepository = new Proxy(
  {},
  { get: (_target, property) => (property === 'then' ? undefined : () => undefined) },
);

const dataSource = {
  entityMetadatas: [],
  options: { type: 'postgres' },
  manager: {},
  getRepository: () => fakeRepository,
  isInitialized: true,
  destroy: async () => undefined,
  query: jest.fn(answer),
  transaction: jest.fn(async (run: (m: typeof manager) => Promise<unknown>) => run(manager)),
};

describe('ACCOUNT_GRANT_REVOKER through the real modules', () => {
  let module: TestingModule;
  const client = new FakeProviderClient();
  const audits: unknown[] = [];

  beforeAll(async () => {
    let builder = Test.createTestingModule({ imports: [App] })
      .overrideProvider(LoggerService)
      .useFactory({ factory: createQuietLogger })
      .overrideProvider(DataSource)
      .useValue(dataSource as unknown as DataSource)
      .overrideProvider(EventService)
      .useValue({ send: jest.fn(async () => undefined) })
      .overrideProvider(getRepositoryToken(UserEntity))
      .useValue({ manager: { query: manager.query, transaction: dataSource.transaction } })
      .overrideProvider(getRepositoryToken(ConnectionEntity))
      .useValue({
        find: jest.fn(async () => [{ ...connection, provider: { id: connection.providerId } }]),
        exists: jest.fn(async () => false),
      })
      .overrideProvider(getRepositoryToken(DataDeletionAuditEntity))
      .useValue({
        create: (record: unknown) => record,
        save: jest.fn(async (record: unknown) => {
          audits.push(record);

          return record;
        }),
      })
      .overrideProvider(ClientFactory)
      .useValue({ getClientByProviderId: () => client })
      .overrideProvider(CloudOAuthProxyService)
      .useValue({ isPortalConfigured: () => false, getProviderNameForId: () => undefined })
      .overrideProvider(ProviderKeyService)
      .useValue({ findByProviderId: async () => null });

    // PrivacyModule and UserModule are real; the modules the admin scripts stub stay stubbed.
    for (const { real, stub } of STUBBED_MODULES) {
      builder = builder.overrideModule(real).useModule(stub);
    }

    module = await builder.compile();
  });

  afterAll(async () => {
    await module?.close();
  });

  it('binds the token to the privacy domain’s DataDeletionService', () => {
    expect(module.get(ACCOUNT_GRANT_REVOKER, { strict: false })).toBe(
      module.get(DataDeletionService, { strict: false }),
    );
  });

  it('revokes the grant when the account is deleted from the Profile page', async () => {
    const userService = module.get(UserService, { strict: false });

    await expect(userService.requestDeletion({ userId: USER }, USER)).resolves.toBe(true);

    expect(client.revoke).toHaveBeenCalledTimes(1);
    expect(client.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-1', refreshToken: 'refresh-1' }),
    );
    expect(connection).toMatchObject({ accessToken: null, refreshToken: null, pending: false });

    // The pending mark was written under the lock, before the provider was asked.
    const lock = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
    const marked = statements.findIndex((sql) => sql.startsWith('WITH marked AS'));
    const cleared = statements.findIndex((sql) => sql.includes('revocation_pending_at = NULL'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(marked).toBeGreaterThan(lock);
    expect(cleared).toBeGreaterThan(marked);
    expect(audits).toEqual([]);
  });
});
