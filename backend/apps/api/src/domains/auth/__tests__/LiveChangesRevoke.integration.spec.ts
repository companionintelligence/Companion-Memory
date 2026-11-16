import { JwtService } from '@nestjs/jwt';
import { Client } from 'pg';
import { DataSource, type DataSourceOptions } from 'typeorm';

import { SYSTEM_USER } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { LiveChangesService } from '@ci/domains/live-changes';
import { UserEntity, UserService } from '@ci/domains/user';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../__tests__/support/scratchDatabase';
import { ApiKeyEntity } from '../entities/ApiKeyEntity';
import { SessionEntity } from '../entities/SessionEntity';
import { ApiKeyService } from '../services/ApiKeyService';
import { AuthService } from '../services/AuthService';

// The service listens only in a process that serves web traffic; this one stands in for one.
jest.mock('@ci/common/roles', () => ({ ...jest.requireActual('@ci/common/roles'), serves: () => true }));

/**
 * What the live-update stream's revoke check reads, against real Postgres.
 *
 * The unit tests fake the database, so they cannot show that the SQL in `isCredentialLive` reads the
 * key and session rows the auth services write and delete, or that a revoke notice sent by those
 * services comes back on the LISTEN connection. Here every piece is real: the tables, the deletes,
 * `pg_notify` and the listening client.
 *
 * Run it with `make test-db ARGS=src/domains/auth/__tests__/LiveChangesRevoke.integration.spec.ts`
 * (or with `PIPELINE_TEST_ADMIN_DATABASE_URL` set); it makes, migrates and drops its own database.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  // Printed once, so a skipped suite is never mistaken for a passing one.
  console.warn(`[auth/LiveChangesRevoke.integration] SKIPPED - ${availability.reason}`);
}

// Creating the scratch database applies every migration, which takes minutes on a loaded machine.
jest.setTimeout(600_000);

const META = { ip: '127.0.0.1', userAgent: 'jest' };

const logger = {
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as LoggerService;

/** The service with its LISTEN connection pointed at the scratch database instead of the configured one. */
class ScratchLiveChangesService extends LiveChangesService {
  constructor(
    dataSource: DataSource,
    private readonly scratchOptions: { host: string; port: number; database: string; user: string; password: string },
  ) {
    super(dataSource, logger);
  }

  protected override createClient(): Client {
    return new Client({ ...this.scratchOptions, application_name: 'ci-live-changes-test' });
  }
}

/**
 * Resolves the first time a revoke notice for `userId` comes back on the LISTEN connection. Fails
 * after ten seconds, so a notice that is never sent fails its test instead of the suite's timeout.
 */
function nextRevoke(service: LiveChangesService, userId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`no revoke notice for ${userId} within 10 s`));
    }, 10_000);
    const unsubscribe = service.subscribeRevocations(userId, () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

describeWithDatabase(`Live-update stream revoke check, against real Postgres (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let dataSource: DataSource;
  let liveChanges: ScratchLiveChangesService;
  let authService: AuthService;
  let apiKeyService: ApiKeyService;
  let userService: UserService;
  let owner: string;
  let other: string;

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'auth/LiveChangesRevoke.integration.spec' });
    await scratch.assertOwn();

    const options = scratch.dataSource.options as DataSourceOptions & {
      host: string;
      port: number;
      database: string;
      username: string;
      password: string;
    };

    dataSource = new DataSource({
      ...options,
      entities: [UserEntity, SessionEntity, ApiKeyEntity],
    } as DataSourceOptions);
    await dataSource.initialize();

    liveChanges = new ScratchLiveChangesService(dataSource, {
      host: options.host,
      port: options.port,
      database: options.database,
      user: options.username,
      password: options.password,
    });
    await liveChanges.onModuleInit();

    authService = new AuthService(new JwtService({}), dataSource.getRepository(SessionEntity), liveChanges);
    apiKeyService = new ApiKeyService(dataSource.getRepository(ApiKeyEntity), logger, liveChanges);

    // Nothing observing UserCreated is under test. No listener may run against this database.
    userService = new UserService(dataSource.getRepository(UserEntity), { send: async () => [] } as never);
    owner = (
      await userService.create(
        { userId: SYSTEM_USER },
        { name: 'owner', email: 'owner@example.com', password: 'irrelevant-1' },
      )
    ).id;
    other = (
      await userService.create(
        { userId: SYSTEM_USER },
        { name: 'other', email: 'other@example.com', password: 'irrelevant-2' },
      )
    ).id;
  });

  afterEach(async () => {
    // The guard first: this empties ci.sessions and ci.api_keys, only ever acceptable in a database this run made.
    await scratch.assertOwn();
    await dataSource.query('DELETE FROM ci.sessions');
    await dataSource.query('DELETE FROM ci.api_keys');
    await dataSource.query('UPDATE ci.users SET deleted_at = NULL');
  });

  afterAll(async () => {
    await liveChanges?.onModuleDestroy();

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }

    await scratch?.drop();
  });

  it('holds a key until it is revoked and sends the notice for it', async () => {
    const key = await apiKeyService.create({ userId: owner }, { name: 'stream key' });
    const credential = { kind: 'apiKey', keyId: key.id } as const;

    expect(await liveChanges.isCredentialLive(owner, credential)).toBe(true);
    // A key is only ever checked against its own owner.
    expect(await liveChanges.isCredentialLive(other, credential)).toBe(false);

    const heard = nextRevoke(liveChanges, owner);
    await apiKeyService.remove({ userId: owner }, key.id);
    await heard;

    expect(await liveChanges.isCredentialLive(owner, credential)).toBe(false);
  });

  it('drops a key past its expiry', async () => {
    const key = await apiKeyService.create(
      { userId: owner },
      { name: 'short key', expires_at: new Date(Date.now() + 60_000).toISOString() },
    );
    const credential = { kind: 'apiKey', keyId: key.id } as const;

    expect(await liveChanges.isCredentialLive(owner, credential)).toBe(true);

    await dataSource.query(`UPDATE ci.api_keys SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      key.id,
    ]);

    expect(await liveChanges.isCredentialLive(owner, credential)).toBe(false);
  });

  it('holds a session until it signs out and sends the notice for it', async () => {
    const { sessionToken, sessionId } = await authService.issueSessionToken(owner, META);
    const credential = { kind: 'session', sessionId } as const;

    expect(await liveChanges.isCredentialLive(owner, credential)).toBe(true);
    expect(await liveChanges.isCredentialLive(other, credential)).toBe(false);

    const heard = nextRevoke(liveChanges, owner);
    await authService.invalidateSession(owner, sessionToken, META);
    await heard;

    expect(await liveChanges.isCredentialLive(owner, credential)).toBe(false);
  });

  it('keeps the session that pressed Sign out everywhere and drops the others', async () => {
    const kept = await authService.issueSessionToken(owner, META);
    const ended = await authService.issueSessionToken(owner, META);

    const heard = nextRevoke(liveChanges, owner);
    await authService.invalidateOtherSessions(owner, kept.sessionToken);
    await heard;

    expect(await liveChanges.isCredentialLive(owner, { kind: 'session', sessionId: kept.sessionId })).toBe(true);
    expect(await liveChanges.isCredentialLive(owner, { kind: 'session', sessionId: ended.sessionId })).toBe(
      false,
    );
  });

  it('drops a session past its expiry', async () => {
    const { sessionId } = await authService.issueSessionToken(owner, META);

    await dataSource.query(`UPDATE ci.sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      sessionId,
    ]);

    expect(await liveChanges.isCredentialLive(owner, { kind: 'session', sessionId })).toBe(false);
  });

  it("drops a deleted account's key and session, which stay in place until the purge", async () => {
    const key = await apiKeyService.create({ userId: owner }, { name: 'stream key' });
    const { sessionId } = await authService.issueSessionToken(owner, META);

    await dataSource.query('UPDATE ci.users SET deleted_at = now() WHERE id = $1', [owner]);

    expect(await liveChanges.isCredentialLive(owner, { kind: 'apiKey', keyId: key.id })).toBe(false);
    expect(await liveChanges.isCredentialLive(owner, { kind: 'session', sessionId })).toBe(false);
  });

  it("does not wake another user's streams", async () => {
    const key = await apiKeyService.create({ userId: owner }, { name: 'stream key' });
    const otherHeard = jest.fn();
    const unsubscribe = liveChanges.subscribeRevocations(other, otherHeard);

    try {
      const heard = nextRevoke(liveChanges, owner);
      await apiKeyService.remove({ userId: owner }, key.id);
      await heard;

      expect(otherHeard).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
