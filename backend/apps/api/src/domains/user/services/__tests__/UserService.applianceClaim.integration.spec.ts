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
import { LastAdminDeletionRefused, UserService } from '../UserService';

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
    // What makes an appliance claimed: any row in ci.users, live or awaiting its purge. The claim
    // promotes only the first account ever, so if anything is already here no assertion below can
    // mean anything.
    const existing = (await dataSource.query(
      `SELECT email FROM ci.users ORDER BY created_at LIMIT 5`,
    )) as Array<{ email: string }>;

    if (existing.length > 0) {
      throw new Error(
        `REFUSING TO RUN: ${availability.target} already has accounts ` +
          `(${existing.map((row) => row.email).join(', ')}). The claim under test is appliance-wide, so ` +
          `this suite needs an appliance nobody has claimed, and it will not delete accounts it did not ` +
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

  it("marks the first account's address proven, and leaves the next one unproven", async () => {
    const owner = await createAccount('owner');
    const member = await createAccount('member');

    expect(owner.emailProvenAt).toBeInstanceOf(Date);
    expect(member.emailProvenAt).toBeNull();
  });

  it('does not promote the next account after the owner left while a member stayed', async () => {
    // Deleting the owner used to leave no LIVE admin, and the next account created was promoted.
    // With a member still on the box, that member could mint the invitation for it.
    const owner = await createAccount('owner');
    await createAccount('member');
    await dataSource.query(`UPDATE ci.users SET deleted_at = now() WHERE id = $1`, [owner.id]);

    const next = await createAccount('next');

    expect(next.role).toBe('user');
    expect(await storedRole(next.id)).toBe('user');
  });

  it('does not promote anyone while the only account is awaiting its purge', async () => {
    const owner = await createAccount('owner');
    await dataSource.query(`UPDATE ci.users SET deleted_at = now() WHERE id = $1`, [owner.id]);

    const next = await createAccount('next');

    expect(next.role).toBe('user');
  });

  it('refuses to delete the last admin while a member stays, and hands the role to a named successor', async () => {
    const owner = await createAccount('owner');
    const member = await createAccount('member');

    await expect(service.requestDeletion(SYSTEM, owner.id)).rejects.toBeInstanceOf(LastAdminDeletionRefused);
    expect(await storedRole(owner.id)).toBe('admin');

    await expect(
      service.requestDeletion(SYSTEM, owner.id, { successorEmail: member.email.toUpperCase() }),
    ).resolves.toBe(true);

    expect(await storedRole(member.id)).toBe('admin');
    const [row] = (await dataSource.query(`SELECT deleted_at FROM ci.users WHERE id = $1`, [
      owner.id,
    ])) as Array<{
      deleted_at: Date | null;
    }>;
    expect(row.deleted_at).toBeInstanceOf(Date);
  });

  it('never leaves members without an admin when two admins leave at once', async () => {
    // Each would otherwise count the other as the admin who stays. The deletion takes the lock
    // every account creation takes, so the second one to get it sees the truth.
    const first = await createAccount('first admin');
    const second = await createAccount('second admin');
    await createAccount('member');
    await dataSource.query(`UPDATE ci.users SET role = 'admin' WHERE id = $1`, [second.id]);

    const outcomes = await Promise.allSettled([
      service.requestDeletion(SYSTEM, first.id),
      service.requestDeletion(SYSTEM, second.id),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const admins = (await dataSource.query(
      `SELECT id FROM ci.users WHERE role = 'admin' AND deleted_at IS NULL`,
    )) as Array<{ id: string }>;
    expect(admins).toHaveLength(1);
  });
});
