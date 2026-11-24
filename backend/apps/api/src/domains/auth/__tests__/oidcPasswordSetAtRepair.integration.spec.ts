import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type DataSourceOptions } from 'typeorm';

import { SYSTEM_USER } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { UserEntity, UserService } from '@ci/domains/user';

import {
  assertScratchDatabase,
  ScratchDatabase,
  scratchDatabaseAvailability,
} from '../../__tests__/support/scratchDatabase';
import { FederatedIdentityEntity } from '../entities/FederatedIdentityEntity';
import { FederatedIdentityService } from '../services/FederatedIdentityService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The accounts #2743's missed flag stamped are un-stamped — and nothing else.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `OidcController.createOidcUser` created accounts with a random password but
 * without `passwordChosenByUser: false`, so `UserService.create` stamped
 * `users.password_set_at` and `AccountController.requireReauth` asked those
 * accounts for a password nobody had seen. {@link MIGRATION} clears those
 * stamps. Clearing one is not harmless: it moves an account from "present your
 * password" to "have signed in recently", so a stamp that recorded a password
 * somebody really chose must survive — and several populations of those look
 * like the broken rows by one timestamp or another.
 *
 * So this reproduces each population, applies the migration verbatim from disk
 * the way dbmate does, and checks which stamps it cleared. The broken row is
 * made by the real `UserService.create` and `FederatedIdentityService.bind`
 * with the DTO the callback used to build, because the migration's window is a
 * claim about when THAT code stamps relative to the row's `created_at`, and a
 * hand-written timestamp would only restate the claim.
 *
 * Skips (loudly) without an administrative connection; see
 * `domains/__tests__/support/scratchDatabase.ts`.
 */

const MIGRATION = '20260930164106_unstamp_oidc_provisioned_password_set_at.sql';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../db/postgres/migrations');

/** The `-- migrate:up` half of the migration, as dbmate would run it. */
function migrationUpSql(): string {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
  const down = sql.indexOf('-- migrate:down');

  return down === -1 ? sql : sql.slice(0, down);
}

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[oidcPasswordSetAtRepair.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(600_000);

const ISSUER = 'https://hub.ci.computer';

/**
 * How far the migration lets a creation stamp run past `created_at`. The stamp
 * is the API's clock and `created_at` the database's: one clock on an
 * appliance, but not in a Docker Desktop VM, which lags the Mac hosting it
 * (by ~100 ms when this was written).
 */
const FORWARD_ALLOWANCE_MS = 1_000;

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

type Row =
  | 'oidcBeforeFix'
  | 'slowInsert'
  | 'oidcUnbound'
  | 'signupNoIdentity'
  | 'signupEmailLinked'
  | 'backfilledEmailLinked'
  | 'lateSubBinding'
  | 'federatedSetOwnSoon'
  | 'federatedSetOwnLater';

describeWithDatabase(`OIDC-provisioned password_set_at repair (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  /** Same scratch database as `scratch.dataSource`, with the two entities mapped for the real services. */
  let dataSource: DataSource;
  let userService: UserService;
  let federatedIdentityService: FederatedIdentityService;

  const ids = {} as Record<Row, string>;
  let before: Map<string, Date | null>;
  let after: Map<string, Date | null>;
  /** The database's clock minus this process's, in ms. */
  let clockOffsetMs: number;

  /** An account through the real create path; `chosen: false` is what every OIDC path passes now. */
  async function createAccount(label: Row, dto: { passwordChosenByUser?: boolean } = {}): Promise<string> {
    const created = await userService.create(
      { userId: SYSTEM_USER },
      {
        name: label,
        email: `${label}@example.test`,
        password: randomBytes(32).toString('hex'),
        ...dto,
      },
    );

    ids[label] = created.id;

    return created.id;
  }

  /** An account with explicit timestamps, for the populations only time can make. */
  async function insertAccount(label: Row, createdAt: string, passwordSetAt: string | null): Promise<string> {
    const [{ id }] = (await scratch.dataSource.query(
      `INSERT INTO ci.users (id, name, email, created_at, password_set_at)
       VALUES (ci.gen_uuid_v7(), $1, $2, $3::timestamptz, $4::timestamptz)
       RETURNING id`,
      [label, `${label}@example.test`, createdAt, passwordSetAt],
    )) as Array<{ id: string }>;

    ids[label] = id;

    return id;
  }

  async function insertBinding(userId: string, bindMethod: 'sub' | 'email_link', createdAt: string) {
    await scratch.dataSource.query(
      `INSERT INTO ci.federated_identities (user_id, issuer, subject, bind_method, created_at)
       VALUES ($1::uuid, $2, $3, $4, $5::timestamptz)`,
      [userId, ISSUER, `sub-${userId}`, bindMethod, createdAt],
    );
  }

  async function seed(): Promise<void> {
    await scratch.assertOwn();

    // ── Stamps the migration must clear ─────────────────────────────────────

    // Exactly what the callback did before this fix, for a native or
    // Hub-invited sign-in: create without the flag, then bind by (iss, sub).
    const oidc = await createAccount('oidcBeforeFix');
    await federatedIdentityService.bind({ userId: oidc, issuer: ISSUER, subject: 'sub-oidc', email: null });

    // The same account on a busy appliance: the stamp was taken, then the
    // INSERT waited on the connection pool before its transaction began.
    const slow = await insertAccount('slowInsert', '2026-09-28T10:00:20Z', '2026-09-28T10:00:00Z');
    await insertBinding(slow, 'sub', '2026-09-28T10:00:22Z');

    // ── Stamps the migration must keep ──────────────────────────────────────

    // Created by the callback but never bound (a userinfo without `sub`). With
    // no federated identity nothing tells it apart from `signupNoIdentity`
    // below, whose stamp must stay, so it keeps its own.
    await createAccount('oidcUnbound');

    // A plain password account.
    await createAccount('signupNoIdentity', { passwordChosenByUser: true });

    // A password account that went on to sign in with a Portal identity for
    // the same address straight away: stamped at creation and bound within
    // the minute, like the broken row — only `email_link` tells them apart.
    const linked = await createAccount('signupEmailLinked', { passwordChosenByUser: true });
    await federatedIdentityService.bind({
      userId: linked,
      issuer: ISSUER,
      subject: 'sub-linked',
      email: 'signupEmailLinked@example.test',
      bindMethod: 'email_link',
    });

    // A password account older than #2743, which that migration backfilled to
    // exactly `created_at`, linked to a Portal identity since.
    const backfilled = await insertAccount(
      'backfilledEmailLinked',
      '2026-06-01T10:00:00Z',
      '2026-06-01T10:00:00Z',
    );
    await insertBinding(backfilled, 'email_link', '2026-09-27T09:00:00Z');

    // Stamped at creation and bound by `sub`, but an hour later — the account
    // was not made by that sign-in. No code binds `sub` to an existing account
    // today; this is what the proximity clause is for if one ever does.
    const late = await insertAccount('lateSubBinding', '2026-09-28T11:00:00Z', '2026-09-28T11:00:00Z');
    await insertBinding(late, 'sub', '2026-09-28T12:00:00Z');

    // A federated account created with no stamp (confirm-account, the Portal
    // bearer path) that set a password of its own five seconds later. A test
    // cannot wait the way a person does, so the moment `changePassword` would
    // have stamped is written directly.
    const soon = await createAccount('federatedSetOwnSoon', { passwordChosenByUser: false });
    await federatedIdentityService.bind({ userId: soon, issuer: ISSUER, subject: 'sub-soon', email: null });
    await scratch.dataSource.query(
      `UPDATE ci.users SET password_set_at = created_at + interval '5 seconds' WHERE id = $1::uuid`,
      [soon],
    );

    // An OIDC account older than #2743 (its backfill left it NULL) that set a
    // password of its own once that release let it.
    const later = await insertAccount('federatedSetOwnLater', '2026-08-10T10:00:00Z', '2026-09-27T15:30:00Z');
    await insertBinding(later, 'sub', '2026-08-10T10:00:00.040Z');
  }

  async function stamps(): Promise<Map<string, Date | null>> {
    const rows = (await scratch.dataSource.query(`SELECT id, password_set_at FROM ci.users`)) as Array<{
      id: string;
      password_set_at: Date | null;
    }>;

    return new Map(rows.map((row) => [row.id, row.password_set_at]));
  }

  /** Apply the migration the way dbmate does: the whole up half, one transaction. */
  async function applyMigration(): Promise<void> {
    await scratch.assertOwn();

    const runner = scratch.dataSource.createQueryRunner();

    await runner.connect();
    await runner.startTransaction();

    try {
      await runner.query(migrationUpSql());
      await runner.commitTransaction();
    } catch (err) {
      await runner.rollbackTransaction();

      throw err;
    } finally {
      await runner.release();
    }
  }

  async function measureClockOffset(): Promise<number> {
    const sentAt = Date.now();
    const [{ ms }] = (await dataSource.query(
      `SELECT extract(epoch FROM clock_timestamp()) * 1000 AS ms`,
    )) as Array<{ ms: string }>;
    const receivedAt = Date.now();

    return Number(ms) - (sentAt + receivedAt) / 2;
  }

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'oidc password_set_at repair' });

    dataSource = new DataSource({
      ...(scratch.dataSource.options as DataSourceOptions),
      entities: [UserEntity, FederatedIdentityEntity],
    } as DataSourceOptions);
    await dataSource.initialize();
    // The services write through this second connection, so it answers to the
    // same guard as the harness's own before anything is written.
    await assertScratchDatabase(dataSource, scratch);

    userService = new UserService(dataSource.getRepository(UserEntity), {
      send: jest.fn(),
    } as unknown as EventService);
    federatedIdentityService = new FederatedIdentityService(
      dataSource.getRepository(FederatedIdentityEntity),
      noopLogger,
    );

    clockOffsetMs = await measureClockOffset();

    await seed();
    before = await stamps();
    await applyMigration();
    after = await stamps();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }

    await scratch?.drop();
  });

  it('starts from the bug: the pre-fix callback stamped an account whose password nobody chose', () => {
    expect(before.get(ids.oidcBeforeFix)).toBeInstanceOf(Date);
  });

  it('clears the stamp the pre-fix callback put on the account it created and bound', () => {
    // The window compares this process's clock (standing in for the API's)
    // with the database's. If they disagree by more than it allows, this
    // machine cannot reproduce an appliance, and the assertion below would
    // fail for that reason rather than the migration's.
    if (Math.abs(clockOffsetMs) >= FORWARD_ALLOWANCE_MS) {
      throw new Error(
        `This process's clock and the database's disagree by ${Math.round(clockOffsetMs)} ms, more than the ` +
          `${FORWARD_ALLOWANCE_MS} ms the migration allows between a creation stamp and created_at. An ` +
          'appliance runs both on one clock; resync this machine (restarting Docker Desktop resets its VM clock).',
      );
    }

    expect(after.get(ids.oidcBeforeFix)).toBeNull();
  });

  it('clears a stamp taken well before a slow INSERT began', () => {
    expect(after.get(ids.slowInsert)).toBeNull();
  });

  it.each<[Row, string]>([
    ['oidcUnbound', 'an OIDC-created account with no federated identity'],
    ['signupNoIdentity', 'a password account'],
    ['signupEmailLinked', 'a password account email-linked to a Portal identity within the minute'],
    ['backfilledEmailLinked', 'a pre-#2743 password account, backfilled to created_at, email-linked since'],
    ['lateSubBinding', 'an account a `sub` binding reached an hour after it was created'],
    ['federatedSetOwnSoon', 'a federated account that set its own password five seconds in'],
    ['federatedSetOwnLater', 'a federated account that set its own password weeks later'],
  ])('keeps the stamp on %s (%s)', (row) => {
    expect(before.get(ids[row])).toBeInstanceOf(Date);
    expect(after.get(ids[row])).toEqual(before.get(ids[row]));
  });

  it('touches no row outside those two', () => {
    const cleared = [...before.keys()].filter((id) => before.get(id) != null && after.get(id) == null);

    expect(cleared.sort()).toEqual([ids.oidcBeforeFix, ids.slowInsert].sort());
  });

  it('changes nothing when run again', async () => {
    await applyMigration();

    expect(await stamps()).toEqual(after);
  });
});
