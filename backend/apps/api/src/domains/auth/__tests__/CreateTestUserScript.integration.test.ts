import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { UserEntity, UserService } from '@ci/domains/user';

import {
  databaseAvailability,
  dataSourceConnection,
  resolveConnection,
} from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import { ApiKeyEntity } from '../entities/ApiKeyEntity';
import { ApiKeyService } from '../services/ApiKeyService';
import { ApiKeyStrategy } from '../services/ApiKeyStrategy';

/**
 * `scripts/create-test-user.ts` (`make testuser`) exists so a human or an agent can
 * stand up a working local user without hand-rolling signup+onboarding — and its own
 * docstring promises the printed credential set works. Every existing test that
 * touches this auth path (`ApiKeyStrategy.test.ts`, `ApiKeyService.test.ts`,
 * `SessionController.test.ts`) mocks `ApiKeyService`/`UserService` outright, so a
 * regression where the script writes a hash/column shape the real guards don't
 * verify against — the wrong hash algorithm, a migration that changes how keys or
 * passwords are stored, a required column the script forgets — would pass every one
 * of those mocked suites and still leave the script's own promise broken. This is
 * the one test that actually runs the CLI script against a real, migrated Postgres
 * and then authenticates with ONLY what it printed, using the real
 * `ApiKeyService`/`ApiKeyStrategy`/`UserService` classes — not a mock of them.
 *
 * Needs a database with the migrations applied: `AUTH_TEST_DATABASE_URL`, else
 * `DATABASE_URL`, else `.env`'s `DATABASE_*` values. `databaseAvailability()`
 * decides whether that means run, skip or fail.
 *
 *   AUTH_TEST_DATABASE_URL=postgres://companion:pw@localhost:5432/companion \
 *     yarn workspace @ci/be-api test src/domains/auth/__tests__/CreateTestUserScript.integration.test.ts
 *
 * The script resolves its own connection through `@ci/configuration`, so it is
 * handed the one this suite resolved: host, port, user and password as the
 * `DATABASE_*` variables `config/custom-environment-variables.json` maps, and the
 * database NAME through `NODE_CONFIG`, because `db.database` has no environment
 * variable. Without that the script would write to `companion` whatever database
 * this suite reads back from — which used to mean this suite could only ever be
 * pointed at a database literally named `companion`.
 *
 * No scratch database: this suite runs no migration DDL, only INSERTs/DELETEs
 * under a user it creates and removes itself, like the other house-pattern specs.
 */

const DATABASE_ENV = {
  urlEnvVar: 'AUTH_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'AUTH_TEST_PROBE_TIMEOUT_MS',
};
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[auth/CreateTestUserScript.integration] SKIPPED — ${availability.reason}`);
}

/** Minimal express-like request — mirrors ApiKeyStrategy.test.ts's helper. */
function requestWith(headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

  return { get: (name: string) => lower[name.toLowerCase()], headers: lower } as never;
}

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

describeWithDb('create-test-user.ts — the printed credentials, against the real auth path', () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let userService: UserService;
  let apiKeyService: ApiKeyService;
  let apiKeyStrategy: ApiKeyStrategy;

  const runId = uuidv7();
  const email = `create-test-user-script-${runId}@example.invalid`;
  const keyName = `test-client-${runId}`;
  const password = `regression-pw-${runId}`;

  let printedApiKey = '';
  let createdUserId = '';

  const apiRoot = path.resolve(__dirname, '../../../../');

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [UserEntity, ApiKeyEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    // SHARED: this suite commits rows in ci.users / ci.api_keys, which a migration
    // suite may be altering inside its own transaction.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'CreateTestUserScript.integration');

    // Run the REAL, unmodified CLI script exactly as `make testuser` does —
    // `yarn run exec -- scripts/create-test-user.ts` from `backend/apps/api` — so
    // this suite proves the actual write path, not a re-implementation of it.
    // Explicit DATABASE_* env vars win over any repo-root `.env` the "exec" yarn
    // script tries to load (dotenv never overrides an already-set variable).
    // NODE_CONFIG carries the database name, which has no variable of its own —
    // see the header.
    const connection = resolveConnection(DATABASE_ENV);

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    const stdout = execFileSync('yarn', ['run', 'exec', '--', 'scripts/create-test-user.ts'], {
      cwd: apiRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DOTENV_CONFIG_PATH: '/dev/null',
        DATABASE_HOST: connection.host,
        DATABASE_PORT: String(connection.port),
        DATABASE_USERNAME: connection.username,
        DATABASE_PASSWORD: connection.password,
        NODE_CONFIG: JSON.stringify({ db: { database: connection.database } }),
        TEST_USER_EMAIL: email,
        TEST_USER_PASSWORD: password,
        TEST_KEY_NAME: keyName,
      },
    });

    const keyMatch = stdout.match(/^API key\s+(\S+)$/m);
    const idMatch = stdout.match(/^User id\s+(\S+)$/m);

    if (!keyMatch || !idMatch) {
      throw new Error(`create-test-user.ts did not print the expected fields. Output:\n${stdout}`);
    }

    printedApiKey = keyMatch[1];
    createdUserId = idMatch[1];

    userService = new UserService(dataSource.getRepository(UserEntity), {} as EventService);
    apiKeyService = new ApiKeyService(dataSource.getRepository(ApiKeyEntity), noopLogger);
    apiKeyStrategy = new ApiKeyStrategy(apiKeyService, userService);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // ci.api_keys.user_id -> ci.users(id) ON DELETE CASCADE, but delete it
      // explicitly anyway rather than lean on the cascade.
      await dataSource.query('DELETE FROM ci.api_keys WHERE user_id = $1', [createdUserId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [createdUserId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('writes a real, freshly-created user row the script reports as "(created)"', async () => {
    const user = await dataSource.getRepository(UserEntity).findOneBy({ id: createdUserId });

    expect(user).not.toBeNull();
    expect(user?.email).toBe(email);
  });

  it('authenticates with the printed password, via the real UserService.validatePassword', async () => {
    const user = await userService.validatePassword(email, password);

    expect(user).not.toBeNull();
    expect(user?.id).toBe(createdUserId);
  });

  it('rejects a wrong password for the same user (sanity — the check above is not vacuous)', async () => {
    const user = await userService.validatePassword(email, 'definitely-not-the-password');

    expect(user).toBeNull();
  });

  it('authenticates with the printed API key, via the real ApiKeyStrategy/ApiKeyService', async () => {
    const user = await apiKeyStrategy.validate(requestWith({ 'x-api-key': printedApiKey }));

    expect(user).not.toBeNull();
    expect((user as { id: string }).id).toBe(createdUserId);
  });

  it('authenticates the printed API key sent as Authorization: Bearer too', async () => {
    const user = await apiKeyStrategy.validate(requestWith({ authorization: `Bearer ${printedApiKey}` }));

    expect(user).not.toBeNull();
    expect((user as { id: string }).id).toBe(createdUserId);
  });

  it('rejects a tampered key of the same shape (sanity — the check above is not vacuous)', async () => {
    const tampered =
      `0${printedApiKey.slice(1)}` === printedApiKey
        ? `1${printedApiKey.slice(1)}`
        : `0${printedApiKey.slice(1)}`;

    const user = await apiKeyStrategy.validate(requestWith({ 'x-api-key': tampered }));

    expect(user).toBeNull();
  });
});
