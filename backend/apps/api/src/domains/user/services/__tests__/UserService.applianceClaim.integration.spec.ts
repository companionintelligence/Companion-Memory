import { DataSource, type DataSourceOptions } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER } from '@ci/common/context';

import { syntheticTestUserEmail } from '../../../__tests__/support/applianceUser';
import {
  assertScratchDatabase,
  ScratchDatabase,
  scratchDatabaseAvailability,
} from '../../../__tests__/support/scratchDatabase';
import { type User, UserEntity } from '../../entities/UserEntity';
import type { AccountGrantRevoker } from '../accountGrantRevoker';
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
 * ── In a database of its own ───────────────────────────────────────────────
 *
 * What this tests is APPLIANCE-WIDE: an account is promoted only when no other account exists
 * anywhere in `ci.users`. So the suite never runs in a database anything else uses. In the one
 * `make test-db` shares between suites it would find their accounts and refuse to run. A
 * developer's stack almost always has an owner already. An unclaimed one would get an admin
 * written into it.
 *
 * It creates a freshly migrated database for the run (`scratchDatabase.ts`) and drops it
 * afterwards, like the account purge suite. That needs the admin credential the other scratch
 * suites use: `PIPELINE_TEST_ADMIN_DATABASE_URL`, which `make test-db` sets, or
 * `DATABASE_ADMIN_PASSWORD`, which CI and `.env.default` set. Without one the suite SKIPS (or
 * fails, under `CI_REQUIRE_DB=1`). Every case checks first that `ci.users` is empty and refuses
 * to run if it is not.
 *
 *   make test-db ARGS='UserService.applianceClaim.integration'
 */

const availability = scratchDatabaseAvailability();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[user/UserService.applianceClaim.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

/**
 * Deleting an account needs a grant revoker (`ACCOUNT_GRANT_REVOKER`, bound by PrivacyModule). These
 * accounts hold no provider grants, so this one records nothing and finds nothing to revoke; the
 * revocations themselves are covered by the privacy domain's suites.
 */
const noGrantsToRevoke = {
  get: (): AccountGrantRevoker => ({
    recordAccountEnd: async () => 'no-audit-row',
    revokePendingGrants: async () => [],
    recordAccountEndFailed: async () => undefined,
  }),
} as never;
describeWithDb(`UserService — claiming an unowned appliance, in Postgres (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let dataSource: DataSource;
  let service: UserService;

  /** Every account a case creates, removed after it so the next case starts unowned again. */
  const created: string[] = [];

  const SYSTEM = { userId: SYSTEM_USER } as const;

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'UserService.applianceClaim.integration.spec' });

    // The scratch handle maps no entities. The service's repository needs UserEntity.
    dataSource = new DataSource({
      ...(scratch.dataSource.options as DataSourceOptions),
      entities: [UserEntity],
    } as DataSourceOptions);
    await dataSource.initialize();

    // The guard on this handle, since every statement below goes through it and not the scratch one.
    await assertScratchDatabase(dataSource, scratch);

    // Nothing observing UserCreated is under test, and no listener should run against this database.
    const eventService = { send: async () => [] };

    service = new UserService(dataSource.getRepository(UserEntity), eventService as never, noGrantsToRevoke);
  }, 300_000);

  beforeEach(async () => {
    // What makes an appliance claimed: any row in ci.users, live or awaiting its purge. The claim
    // promotes only the first account ever, so if anything is already here no assertion below can
    // mean anything.
    const existing = (await dataSource.query(
      `SELECT email FROM ci.users ORDER BY created_at LIMIT 5`,
    )) as Array<{ email: string }>;

    if (existing.length > 0) {
      throw new Error(
        `REFUSING TO RUN: ${scratch.name} already has accounts ` +
          `(${existing.map((row) => row.email).join(', ')}). The claim under test is appliance-wide, so ` +
          `every case needs an appliance nobody has claimed. It will not delete accounts it did not ` +
          `create. This database was created empty for this run, so most likely an earlier case failed ` +
          `to remove its own: fix that case first.`,
      );
    }
  });

  afterEach(async () => {
    // jest still runs this after a failed beforeAll. `service` is set only once the guard has passed,
    // so without it no case ran and there is nothing to remove. Skipping also keeps any statement off
    // a handle the guard refused. A second error on every case would only bury the setup failure.
    if (service == null) {
      return;
    }

    // Hard-deleted rather than soft: a soft-deleted admin no longer owns the appliance, but it would
    // still be this suite's litter in ci.users.
    await dataSource.query(`DELETE FROM ci.users WHERE id = ANY($1::uuid[])`, [created.splice(0)]);
  });

  afterAll(async () => {
    try {
      if (dataSource?.isInitialized) {
        await dataSource.destroy();
      }
    } finally {
      await scratch?.drop();
    }
  }, 60_000);

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

  // Whoever reaches a fresh appliance first can type somebody else's address; proven, it would
  // receive that person's later Portal or Hub sign-in. Only a vouching sign-in proves one.
  it("leaves the first account's typed address unproven, like every other account's", async () => {
    const owner = await createAccount('owner');
    const member = await createAccount('member');

    expect(owner.role).toBe('admin');
    expect(owner.emailProvenAt).toBeNull();
    expect(member.emailProvenAt).toBeNull();

    const [row] = await dataSource.query<Array<{ email_proven_at: Date | null }>>(
      'SELECT email_proven_at FROM ci.users WHERE id = $1',
      [owner.id],
    );
    expect(row.email_proven_at).toBeNull();
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
