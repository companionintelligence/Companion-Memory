import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER } from '@ci/common/context';

import { syntheticTestUserEmail } from '../../../__tests__/support/applianceUser';
import {
  type DatabaseAvailability,
  databaseAvailability,
  resolveConnection,
} from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { type User, UserEntity } from '../../entities/UserEntity';
import { UserService } from '../UserService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Claiming an unowned appliance, against real Postgres.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `UserService.applianceClaim.test.ts` pins the rules with a stubbed manager. It cannot pin the
 * one fact this claim got wrong, because that fact belongs to the DRIVER: TypeORM's Postgres query
 * runner resolves a bare `UPDATE ... RETURNING` to the pair `[rows, rowCount]`, not to the rows.
 * The claim read that pair's length — 2, whether or not the UPDATE matched — as "promoted", so
 * `create()` returned `role: 'admin'` for EVERY account while the row correctly stayed 'user'.
 * `PortalTokenService.provisionUser` hands that object to the auth guards as `request.user`, and
 * `AdminOnlyGuard`/`ApplianceAdminGuard` read `.role` off it. The unit stub answered the UPDATE
 * with plain rows, a shape the driver never produces, and so passed. Only the driver can keep that
 * class of bug from coming back.
 *
 * Each case compares the User `create()` RETURNS with the row it WROTE. The row was always right.
 *
 * ── Opt-in, and deliberately with no `DATABASE_URL` fallback ──────────────
 *
 * Set `USER_TEST_DATABASE_URL` to a migrated database. Unlike most suites built on
 * `databaseConnection.ts`, this one does not fall back to `DATABASE_URL` or `.env`'s
 * `DATABASE_PASSWORD`, because what it tests is APPLIANCE-WIDE: an account is promoted only when
 * no live admin exists anywhere in `ci.users`. A developer's running stack almost always has one —
 * its owner — so the fallback would fail `yarn test` on every claimed dev stack, and on an unclaimed
 * one it would write an admin into somebody's database. Pointed at a database that already has a
 * live admin, the suite refuses to run rather than demote one it did not create.
 *
 * Once opted in it is still port-probed, so a URL with nothing listening SKIPS instead of failing.
 * A private container is the intended target:
 *
 *   docker run -d --name <worktree>-testdb -e PASSWORD=<admin pw> -p 127.0.0.1::5432 ci/database:latest
 *   # as postgres: CREATE ROLE companion LOGIN PASSWORD '<pw>'; CREATE DATABASE companion OWNER companion;
 *   # then, in companion, the extensions timescaledb postgis vector pg_stat_statements btree_gist
 *   DATABASE_URL=postgres://companion:<pw>@127.0.0.1:<port>/companion yarn workspace @ci/be-api migrate
 *   USER_TEST_DATABASE_URL=postgres://companion:<pw>@127.0.0.1:<port>/companion \
 *     yarn workspace @ci/be-api jest UserService.applianceClaim.integration
 */

const OPT_IN_VARIABLE = 'USER_TEST_DATABASE_URL';

const availability: DatabaseAvailability =
  (process.env[OPT_IN_VARIABLE] ?? '').trim().length > 0
    ? databaseAvailability({ urlEnvVar: OPT_IN_VARIABLE })
    : {
        available: false,
        reason: `${OPT_IN_VARIABLE} is not set. This suite has no DATABASE_URL fallback, on purpose — see its header.`,
        target: '(unset)',
      };
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[user/UserService.applianceClaim.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`UserService — claiming an unowned appliance, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: UserService;

  /** Every account a case creates, removed after it so the next case starts unowned again. */
  const created: string[] = [];

  const SYSTEM = { userId: SYSTEM_USER } as const;

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: OPT_IN_VARIABLE });

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
      entities: [UserEntity],
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'user/UserService.applianceClaim.integration');

    // Nothing observing UserCreated is under test, and no listener should run against this database.
    const eventService = { send: async () => [] };

    service = new UserService(dataSource.getRepository(UserEntity), eventService as never);
  });

  beforeEach(async () => {
    // What makes an appliance "owned", to the claim and to ApplianceAdminGuard alike. If something
    // else owns this one, no assertion below can mean anything.
    const admins = (await dataSource.query(
      `SELECT email FROM ci.users WHERE role = 'admin' AND deleted_at IS NULL ORDER BY created_at`,
    )) as Array<{ email: string }>;

    if (admins.length > 0) {
      throw new Error(
        `REFUSING TO RUN: ${availability.target} already has a live admin ` +
          `(${admins.map((admin) => admin.email).join(', ')}). The claim under test is appliance-wide, so ` +
          `this suite needs an unowned appliance, and it will not demote or delete an admin it did not ` +
          `create. Point ${OPT_IN_VARIABLE} at a freshly migrated database of its own.`,
      );
    }
  });

  afterEach(async () => {
    // Hard-deleted rather than soft: a soft-deleted admin no longer owns the appliance, but it would
    // still be this suite's litter in ci.users.
    await dataSource.query(`DELETE FROM ci.users WHERE id = ANY($1::uuid[])`, [created.splice(0)]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  /** An account through the real `create()`, named so a leaked row is recognisable as a fixture. */
  const createAccount = async (label: string): Promise<User> => {
    const id = uuidv7();

    // Recorded before the call: a create that fails after inserting still leaves a row to remove.
    created.push(id);

    return service.create(SYSTEM, {
      id,
      name: `Appliance claim spec ${label}`,
      email: syntheticTestUserEmail('userservice-appliance-claim', id),
      password: `appliance-claim-${id}`,
    });
  };

  const storedRole = async (id: string): Promise<string | undefined> => {
    const [row] = (await dataSource.query(`SELECT role FROM ci.users WHERE id = $1`, [id])) as Array<{
      role: string;
    }>;

    return row?.role;
  };

  it('promotes the first account — in the User it returns and in the row', async () => {
    const owner = await createAccount('owner');

    expect(owner.role).toBe('admin');
    expect(await storedRole(owner.id)).toBe('admin');
  });

  it('leaves the second account a user — in the User it returns, not only in the row', async () => {
    const owner = await createAccount('owner');
    const member = await createAccount('member');

    // The row was always 'user'. The returned User said 'admin', and that object is what
    // PortalTokenService.provisionUser puts on request.user for the admin guards to read.
    expect(member.role).toBe('user');
    expect(await storedRole(member.id)).toBe('user');

    expect(owner.role).toBe('admin');
    expect(await storedRole(owner.id)).toBe('admin');
  });

  it('lets exactly one of two racing accounts claim it, and tells each the truth', async () => {
    // The shape of the exposure: two first-time sign-ins on an unowned appliance, concurrently. The
    // advisory lock admits one promotion; the loser must not be handed an admin User.
    const racers = await Promise.all([createAccount('racer A'), createAccount('racer B')]);

    const stored = await Promise.all(racers.map((racer) => storedRole(racer.id)));

    expect(racers.map((racer) => racer.role).sort()).toEqual(['admin', 'user']);
    expect(racers.map((racer) => racer.role)).toEqual(stored);
  });
});
