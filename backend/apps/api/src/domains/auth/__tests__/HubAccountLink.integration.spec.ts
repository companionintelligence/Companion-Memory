import type { Response } from 'express';
import { DataSource, type DataSourceOptions, type QueryRunner } from 'typeorm';

import { isUniqueViolation } from '@ci/common/constants';
import { SYSTEM_USER } from '@ci/common/context';
import { signForwardAuthUser, signForwardAuthUserId } from '@ci/common/crypto';
import config from '@ci/configuration';
import { UserEntity, UserService } from '@ci/domains/user';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../__tests__/support/scratchDatabase';
import { FederatedIdentityEntity } from '../entities/FederatedIdentityEntity';
import { FederatedIdentityService } from '../services/FederatedIdentityService';
import { HubForwardAuthBridgeService } from '../services/HubForwardAuthBridgeService';

/**
 * The Hub ↔ Memory account link, against real Postgres.
 *
 * What the unit tests cannot show: that the migration's partial unique index holds one person of a
 * Hub per account and leaves other Hubs and OIDC issuers alone; that `oidcOnly` really leaves the
 * Hub's links out (a TypeORM `Not(Like())`, so the SQL is TypeORM's); that a renamed person keeps
 * their account with real rows behind it; that two tabs arriving together for someone new make
 * one account; and that the operator's `move` / `unlink` change the rows they say they do.
 *
 * Run it with `make test-db ARGS=src/domains/auth/__tests__/HubAccountLink.integration.spec.ts`
 * (or with `PIPELINE_TEST_ADMIN_DATABASE_URL` set); it makes, migrates and drops its own database.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  // Printed once, so a skipped suite is never mistaken for a passing one.
  console.warn(`[auth/HubAccountLink.integration] SKIPPED — ${availability.reason}`);
}

// Creating the scratch database applies every migration, which takes minutes on a loaded machine.
jest.setTimeout(600_000);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const hubAccountLink = require('../../../../bin/hub-account-link.js') as {
  FOOTPRINT_TABLES: string[];
  list(client: PgClient): Promise<void>;
  move(client: PgClient, options: { from?: string; to?: string; apply: boolean }): Promise<void>;
  unlink(client: PgClient, options: { email?: string; apply: boolean }): Promise<void>;
};

interface PgClient {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const SECRET = 'hub-account-link-secret';
const DIRECTORY = 'urn:ci-hub:6f1c2a4e-2f3b-4c5d-8e9f-0a1b2c3d4e5f';
const FRESH_DIRECTORY = 'urn:ci-hub:00000000-0000-4000-8000-000000000000';
const PORTAL = 'https://hub.ci.computer';

const quietLogger = () => ({
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
});

let hubIds = 0;

/** A fresh Hub public id: a lower-case UUID, as the Hub mints them. */
function nextHubId(): string {
  hubIds += 1;

  return `0192a3b4-c5d6-7e8f-9a0b-${String(hubIds).padStart(12, '0')}`;
}

function hubRequest(username: string, hubId: string, issuer = DIRECTORY, sessionToken?: string) {
  const now = Date.now();

  return {
    headers: {
      'x-ci-hub-user': username,
      'x-ci-hub-user-timestamp': String(now),
      'x-ci-hub-user-signature': signForwardAuthUser(SECRET, username, now),
      'x-ci-hub-user-issuer': issuer,
      'x-ci-hub-user-id': hubId,
      'x-ci-hub-user-id-signature': signForwardAuthUserId(SECRET, issuer, hubId, username, now),
    },
    cookies: sessionToken ? { [config.auth.cookies.sessionTokenName]: sessionToken } : {},
    secure: false,
  } as never;
}

function response(): Response {
  return { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as Response;
}

describeWithDatabase(`Hub ↔ Memory account link, against real Postgres (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let dataSource: DataSource;
  let userService: UserService;
  let federatedIdentityService: FederatedIdentityService;
  let bridge: HubForwardAuthBridgeService;

  /** Which account each session token was minted for: `session:<userId>`. */
  const sessionUser = (token: string) => token.replace(/^session:/, '');

  const previous = { ...config.auth.hubForwardAuth };

  beforeAll(async () => {
    config.auth.hubForwardAuth.enabled = true;
    config.auth.hubForwardAuth.secret = SECRET;
    // The headers below are the unbound format; a .env that gives this app its own key would refuse them.
    config.auth.hubForwardAuth.identitySecret = '';
    config.auth.hubForwardAuth.audience = '';
    config.auth.hubForwardAuth.requireAudience = 'auto';
    config.auth.hubForwardAuth.maxSkewMs = 300_000;

    scratch = await ScratchDatabase.create({ createdBy: 'auth/HubAccountLink.integration.spec' });
    await scratch.assertOwn();

    dataSource = new DataSource({
      ...(scratch.dataSource.options as DataSourceOptions),
      entities: [UserEntity, FederatedIdentityEntity],
    } as DataSourceOptions);
    await dataSource.initialize();

    // Nothing observing UserCreated is under test, and no listener may run against this database.
    userService = new UserService(dataSource.getRepository(UserEntity), { send: async () => [] } as never);
    federatedIdentityService = new FederatedIdentityService(
      dataSource.getRepository(FederatedIdentityEntity),
      quietLogger() as never,
    );

    // Sessions are not under test: a token names the account it was issued for, and it is live.
    // The dead-session case is covered by the bridge unit tests.
    const authService = {
      validateSessionToken: (token: string) => ({ sub: sessionUser(token) }),
      resolveLiveSession: async (token: string) => ({
        userId: sessionUser(token),
        sessionId: `sid:${sessionUser(token)}`,
      }),
      invalidateSession: async () => undefined,
      issueSessionToken: async (userId: string) => ({
        sessionToken: `session:${userId}`,
        sessionId: `sid:${userId}`,
      }),
      issueAccessToken: (userId: string) => `access:${userId}`,
      getSessionMetadata: () => ({ ip: '127.0.0.1', userAgent: 'jest' }),
    };

    bridge = new HubForwardAuthBridgeService(
      userService,
      authService as never,
      { generateToken: () => 'csrf' } as never,
      federatedIdentityService,
      quietLogger() as never,
    );
  });

  afterEach(async () => {
    // The guard first: this empties ci.users, only ever acceptable in a database this run made.
    await scratch.assertOwn();
    await dataSource.query('DELETE FROM ci.federated_identities');
    await dataSource.query('DELETE FROM ci.users');
  });

  afterAll(async () => {
    Object.assign(config.auth.hubForwardAuth, previous);

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }

    await scratch?.drop();
  });

  const createAccount = (email: string) =>
    userService.create(
      { userId: SYSTEM_USER },
      { name: email.split('@')[0], email, password: 'irrelevant-1' },
    );

  const hubLinks = async () =>
    dataSource.query<Array<{ user_id: string; issuer: string; subject: string; bind_method: string }>>(
      `SELECT user_id::text, issuer, subject, bind_method FROM ci.federated_identities
        WHERE issuer LIKE 'urn:ci-hub:%' ORDER BY created_at`,
    );

  const accountCount = async () =>
    Number((await dataSource.query<Array<{ n: string }>>('SELECT count(*) AS n FROM ci.users'))[0].n);

  /** Sign a Hub person in through the bridge and return the account it chose, or the refusal. */
  const signIn = async (username: string, hubId: string, issuer = DIRECTORY, sessionToken?: string) => {
    const res = response();
    const result = await bridge.alignSession(hubRequest(username, hubId, issuer, sessionToken), res);
    const issued = (res.cookie as jest.Mock).mock.calls.find(
      ([name]: [string]) => name === config.auth.cookies.sessionTokenName,
    );

    return {
      result,
      accountId: issued ? sessionUser(issued[1] as string) : sessionToken ? sessionUser(sessionToken) : null,
    };
  };

  describe('the migration', () => {
    it('holds one person of a Hub per account', async () => {
      const user = await createAccount('one@example.com');

      await federatedIdentityService.bind({ userId: user.id, issuer: DIRECTORY, subject: nextHubId() });

      let error: unknown;
      try {
        await federatedIdentityService.bind({ userId: user.id, issuer: DIRECTORY, subject: nextHubId() });
      } catch (caught) {
        error = caught;
      }

      expect(isUniqueViolation(error)).toBe(true);
    });

    it('lets one account be linked from two Hub directories, and to any number of OIDC identities', async () => {
      const user = await createAccount('two@example.com');

      await federatedIdentityService.bind({ userId: user.id, issuer: DIRECTORY, subject: nextHubId() });
      await federatedIdentityService.bind({ userId: user.id, issuer: FRESH_DIRECTORY, subject: nextHubId() });
      await federatedIdentityService.bind({ userId: user.id, issuer: PORTAL, subject: 'portal-sub-1' });
      await federatedIdentityService.bind({
        userId: user.id,
        issuer: 'https://peer.example',
        subject: 'peer-sub',
      });

      expect(await federatedIdentityService.listForUser(user.id)).toHaveLength(4);
    });
  });

  it("leaves the Hub's links out of oidcOnly, so they never refuse a Portal email link", async () => {
    const user = await createAccount('three@example.com');
    await federatedIdentityService.bind({ userId: user.id, issuer: DIRECTORY, subject: nextHubId() });

    expect(await federatedIdentityService.listForUser(user.id, { oidcOnly: true })).toEqual([]);

    await federatedIdentityService.bind({ userId: user.id, issuer: PORTAL, subject: 'portal-sub-2' });

    expect(
      (await federatedIdentityService.listForUser(user.id, { oidcOnly: true })).map((link) => link.issuer),
    ).toEqual([PORTAL]);
  });

  it('stores addresses lower-cased and finds live accounts whatever case the lookup uses, not deleted ones', async () => {
    const live = await createAccount('Owner@Example.com');
    const gone = await createAccount('Gone@Example.com');
    await userService.requestDeletion({ userId: SYSTEM_USER }, gone.id);

    expect(live.email).toBe('owner@example.com');
    expect((await userService.findByEmailIgnoringCase('OWNER@example.com')).map((user) => user.id)).toEqual([
      live.id,
    ]);
    expect(await userService.findByEmailIgnoringCase('gone@example.com')).toEqual([]);
  });

  it('refuses a second account whose address differs only in case', async () => {
    await createAccount('owner@example.com');

    let error: unknown;
    try {
      await createAccount('OWNER@Example.com');
    } catch (caught) {
      error = caught;
    }

    expect(isUniqueViolation(error)).toBe(true);
    expect(await accountCount()).toBe(1);
  });

  describe('the bridge', () => {
    it('creates and links someone new in one go, with no password of their own', async () => {
      const hubId = nextHubId();

      const { result, accountId } = await signIn('new@example.com', hubId);

      expect(result).toMatchObject({ replaced: true });
      const [account] = await dataSource.query<
        Array<{ id: string; email: string; password_set_at: Date | null }>
      >('SELECT id::text, email, password_set_at FROM ci.users');
      expect(account).toMatchObject({ id: accountId, email: 'new@example.com', password_set_at: null });
      expect(await hubLinks()).toEqual([
        { user_id: accountId, issuer: DIRECTORY, subject: hubId, bind_method: 'sub' },
      ]);
    });

    it('keeps a person in their account after they rename themselves on the Hub', async () => {
      const hubId = nextHubId();
      const first = await signIn('before@example.com', hubId);

      // The old bridge would have JIT-created an empty account for after@ right here.
      const renamed = await signIn('after@example.com', hubId, DIRECTORY, `session:${first.accountId}`);

      expect(renamed.result).toEqual({ username: 'after@example.com', replaced: false });
      expect(renamed.accountId).toBe(first.accountId);
      expect(await accountCount()).toBe(1);

      // And from a browser with no session at all, the link still finds them.
      expect((await signIn('after@example.com', hubId)).accountId).toBe(first.accountId);
    });

    it('keeps them in their account after the address changes on the Memory side', async () => {
      const hubId = nextHubId();
      const first = await signIn('hub@example.com', hubId);
      await userService.changeEmail({ userId: SYSTEM_USER }, first.accountId as string, 'memory@example.com');

      expect((await signIn('hub@example.com', hubId)).accountId).toBe(first.accountId);
      expect(await accountCount()).toBe(1);
    });

    it("SECURITY: never hands a renamed person's account to whoever is given their old username", async () => {
      const a = nextHubId();
      const original = await signIn('x@example.com', a);
      await signIn('a-new-name@example.com', a);

      // The Hub gives x@ to someone else. Their username names A's account.
      const b = await signIn('x@example.com', nextHubId());

      expect(b.result).toMatchObject({ replaced: false, refused: 'account_linked_elsewhere' });
      expect(b.accountId).toBeNull();
      expect(await accountCount()).toBe(1);
      expect((await hubLinks()).map((link) => link.user_id)).toEqual([original.accountId]);
    });

    it('adopts by username for a fresh Hub that a Memory backup was restored onto', async () => {
      const original = await signIn('restored@example.com', nextHubId());

      // Same address, a person of another directory: the old Hub is gone.
      const again = await signIn('restored@example.com', nextHubId(), FRESH_DIRECTORY);

      expect(again.accountId).toBe(original.accountId);
      expect((await hubLinks()).map((link) => link.issuer)).toEqual([DIRECTORY, FRESH_DIRECTORY]);
    });

    it('SECURITY: will not adopt an account whose address someone typed in, and creates nothing', async () => {
      // The first account is the owner's. The second was signed up, or re-addressed, with the
      // address of a person who has not arrived yet.
      await createAccount('owner@example.com');
      const planted = await createAccount('arriving@example.com');

      const arriving = await signIn('arriving@example.com', nextHubId());

      expect(arriving.result).toMatchObject({ replaced: false, refused: 'account_unproven' });
      expect(arriving.accountId).toBeNull();
      expect(await hubLinks()).toEqual([]);
      expect(await accountCount()).toBe(2);
      const [row] = await dataSource.query<Array<{ email_proven_at: Date | null }>>(
        'SELECT email_proven_at FROM ci.users WHERE id = $1',
        [planted.id],
      );
      expect(row.email_proven_at).toBeNull();
    });

    it('adopts an account signed up in another case, instead of duplicating it', async () => {
      const signedUp = await createAccount('Mixed@Example.com');

      const { accountId } = await signIn('mixed@example.com', nextHubId());

      expect(accountId).toBe(signedUp.id);
      expect(await accountCount()).toBe(1);
      expect((await hubLinks())[0]).toMatchObject({ user_id: signedUp.id, bind_method: 'email_link' });
    });

    it('makes one account when two tabs arrive together for someone new', async () => {
      const hubId = nextHubId();

      const [first, second] = await Promise.all([
        signIn('racer@example.com', hubId),
        signIn('racer@example.com', hubId),
      ]);

      expect(first.accountId).toBeTruthy();
      expect(second.accountId).toBe(first.accountId);
      expect(await accountCount()).toBe(1);
      expect(await hubLinks()).toHaveLength(1);
    });
  });

  describe('the operator script', () => {
    let runner: QueryRunner;
    let client: PgClient;

    beforeEach(async () => {
      runner = dataSource.createQueryRunner();
      await runner.connect();
      // One connection, so the script's BEGIN and COMMIT reach the same session.
      client = { query: async (sql, parameters) => ({ rows: await runner.query(sql, parameters) }) };
      jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      await runner.release();
    });

    it('moves a stranded person from their duplicate back to their original account', async () => {
      // Stranded before the link existed: the original kept the old address, and the duplicate the
      // bridge made for the new one is where rollout links them.
      const original = await createAccount('old@example.com');
      const hubId = nextHubId();
      const stranded = await signIn('new@example.com', hubId);

      await hubAccountLink.move(client, { from: 'new@example.com', to: 'old@example.com', apply: false });
      expect((await hubLinks())[0].user_id).toBe(stranded.accountId);

      await hubAccountLink.move(client, { from: 'new@example.com', to: 'old@example.com', apply: true });

      expect(await hubLinks()).toEqual([
        { user_id: original.id, issuer: DIRECTORY, subject: hubId, bind_method: 'email_link' },
      ]);
      // Their next page load, from the duplicate's session, lands in the original.
      const next = await signIn('new@example.com', hubId, DIRECTORY, `session:${stranded.accountId}`);
      expect(next.accountId).toBe(original.id);
      // Nothing was merged or deleted.
      expect(await accountCount()).toBe(2);
    });

    it('lists every link and unlinked account with what each holds, on the real schema', async () => {
      const original = await createAccount('listed-original@example.com');
      await signIn('listed-hub@example.com', nextHubId());
      const lines: string[] = [];
      jest.spyOn(console, 'log').mockImplementation((line: string) => {
        lines.push(line);
      });

      await hubAccountLink.list(client);

      const output = lines.join('\n');
      expect(output).toContain(`→ listed-hub@example.com`);
      expect(output).toContain(`listed-original@example.com (${original.id})`);

      // The footprint is only worth reading if its tables exist as named: every one must, with an
      // owner column, or a renamed table would quietly drop out of the count.
      const owned = await dataSource.query<Array<{ table_name: string }>>(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'ci' AND column_name = 'user_id' AND table_name = ANY($1::text[])`,
        [hubAccountLink.FOOTPRINT_TABLES],
      );
      expect(owned.map((row) => row.table_name).sort()).toEqual([...hubAccountLink.FOOTPRINT_TABLES].sort());
    });

    it('refuses to move a person onto an account another person of that Hub holds', async () => {
      await signIn('held@example.com', nextHubId());
      await signIn('mover@example.com', nextHubId());

      await expect(
        hubAccountLink.move(client, { from: 'mover@example.com', to: 'held@example.com', apply: true }),
      ).rejects.toThrow(/already belongs to another person/);
    });

    it('unlinks an account so the next visit adopts by username again', async () => {
      const original = await signIn('stale@example.com', nextHubId());

      await hubAccountLink.unlink(client, { email: 'stale@example.com', apply: true });
      expect(await hubLinks()).toEqual([]);

      // The lockout it exists for: a person of the same Hub, now holding this username.
      const replacement = nextHubId();
      expect((await signIn('stale@example.com', replacement)).accountId).toBe(original.accountId);
    });
  });
});
