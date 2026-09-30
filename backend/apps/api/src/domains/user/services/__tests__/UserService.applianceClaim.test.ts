import bcryptModule from 'bcrypt';

import { SYSTEM_USER } from '@ci/common/context';

import { UserCreatedEvent } from '../../events';
import { UserService } from '../UserService';

jest.mock('bcrypt', () => ({ hash: jest.fn().mockResolvedValue('hashed'), compare: jest.fn() }));

const bcrypt = bcryptModule as unknown as { hash: jest.Mock };

const SYSTEM = { userId: SYSTEM_USER } as never;

/**
 * The command Postgres reports for `sql` — the OUTER statement's. Parenthesised spans (CTE bodies,
 * subqueries) are removed innermost-first, so `WITH p AS (UPDATE …) SELECT …` reads as SELECT and
 * `UPDATE … WHERE NOT EXISTS (SELECT …)` as UPDATE.
 */
function outerCommand(sql: string): string | undefined {
  let flattened = sql;

  while (/\([^()]*\)/.test(flattened)) {
    flattened = flattened.replace(/\([^()]*\)/g, ' ');
  }

  return /\b(SELECT|INSERT|UPDATE|DELETE)\b/i.exec(flattened)?.[1].toUpperCase();
}

/**
 * What TypeORM's `PostgresQueryRunner.query()` resolves to for a statement that produced `rows`.
 *
 * NOT always the rows: it switches on that outer command and hands back `[rows, rowCount]` for an
 * UPDATE or DELETE. This fake used to answer the bare `UPDATE ... RETURNING id` with plain rows — a
 * shape the driver never produces — so the claim reading the pair's length (always 2) as
 * "promoted" passed here while `create()` returned `role: 'admin'` for every account.
 */
function driverResult(sql: string, rows: unknown[]): unknown {
  const command = outerCommand(sql);

  return command === 'UPDATE' || command === 'DELETE' ? [rows, rows.length] : rows;
}

/**
 * A UserService whose transaction manager records every statement and answers the promoting
 * statement with `rows`, standing in for "this account was/was not promoted", in the shape the
 * real driver would give it.
 */
function makeService(promotedRows: Array<{ id: string }>) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  const transactionManager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      queries.push({ sql, params });

      // The advisory lock returns nothing anyone reads; only the promotion's rows matter.
      return Promise.resolve(driverResult(sql, sql.includes('pg_advisory_xact_lock') ? [] : promotedRows));
    }),
  };

  const userRepository = {
    create: jest.fn((data: object) => data),
    save: jest.fn((entity: object) => Promise.resolve({ ...entity, role: 'user' })),
    manager: {
      transaction: jest.fn((run: (m: unknown) => Promise<boolean>) => run(transactionManager)),
    },
  };

  const eventService = { send: jest.fn() };
  const service = new UserService(userRepository as never, eventService as never);

  return { service, userRepository, eventService, queries };
}

beforeEach(() => {
  jest.clearAllMocks();
  bcrypt.hash.mockResolvedValue('hashed');
});

const NEW_USER = { name: 'J Smith', email: 'jsmith@example.com', password: 'correct horse' };

/**
 * ═══ WHY THIS EXISTS ═══
 *
 * Nothing in application code ever wrote `ci.users.role = 'admin'`. The only path was migration
 * 20260825233952, which promotes the earliest EXISTING user and so matched nothing on a fresh
 * install — leaving those appliances permanently admin-less. Every route behind `AdminOnlyGuard`
 * therefore returned 403 to every real user: all MCP server configuration (including the outbound
 * per-tool approval UI the web app renders) and `GET /api/tools/invocations/system`, the only
 * reader of the tool ledger's `user_id IS NULL` rows.
 *
 * On a single-owner personal appliance the first account IS the owner, which
 * `SignupController`'s first-account signup-code exemption and `UserService.findAllOnboarded`
 * already assumed. This pins that rule where it is now enforced.
 */
describe('UserService — claiming an unowned appliance', () => {
  it('promotes the account that claims an unowned appliance', async () => {
    const { service } = makeService([{ id: 'user-1' }]);

    const user = await service.create(SYSTEM, NEW_USER);

    expect(user.role).toBe('admin');
  });

  it('leaves an account created on an owned appliance at its default role', async () => {
    // The UPDATE's own NOT EXISTS is what declines; an empty result means "not promoted".
    const { service } = makeService([]);

    const user = await service.create(SYSTEM, NEW_USER);

    expect(user.role).toBe('user');
  });

  it('reads the promotion from its rows, not from the pair a bare UPDATE resolves to', async () => {
    // `.length` of `[rows, rowCount]` is 2 whether or not a row matched, so the claim must be a
    // statement whose OUTER command is a SELECT. Pinned so it cannot be "simplified" back into a
    // bare UPDATE ... RETURNING, which is the exact shape that shipped every account as an admin.
    const { service, queries } = makeService([]);

    const user = await service.create(SYSTEM, NEW_USER);

    const update = queries.find((q) => q.sql.includes("SET role = 'admin'"));

    expect(outerCommand(update!.sql)).toBe('SELECT');
    expect(user.role).toBe('user');
  });

  it('asks the same "unowned" question ApplianceAdminGuard asks', async () => {
    // These two must agree. The guard admits EVERY signed-in user on an appliance with no live
    // admin; if this promotion applied a different test, that permissive branch could become the
    // steady state on a box this code considered already claimed.
    const { service, queries } = makeService([{ id: 'user-1' }]);

    await service.create(SYSTEM, NEW_USER);

    const update = queries.find((q) => q.sql.includes("SET role = 'admin'"));

    expect(update).toBeDefined();
    expect(update!.sql).toMatch(/NOT EXISTS/);
    expect(update!.sql).toMatch(/role = 'admin' AND deleted_at IS NULL/);
  });

  it('serializes the check against a concurrent signup', async () => {
    // The decision reads a table it is about to write, so two signups racing on a fresh appliance
    // would both observe "no admin" under READ COMMITTED and both promote.
    const { service, userRepository, queries } = makeService([{ id: 'user-1' }]);

    await service.create(SYSTEM, NEW_USER);

    expect(userRepository.manager.transaction).toHaveBeenCalledTimes(1);
    expect(queries[0].sql).toMatch(/pg_advisory_xact_lock/);
    // The lock has to be taken before the read, or it serializes nothing.
    expect(queries.findIndex((q) => q.sql.includes("SET role = 'admin'"))).toBeGreaterThan(0);
  });

  it('promotes the row it just created, never whichever row happens to be earliest', async () => {
    // The migrations resolve the owner with ORDER BY created_at because they run against rows that
    // already exist. Here the claiming account is known, and targeting it by id is what makes the
    // promotion agree with the migration rather than race it.
    const { service, queries } = makeService([{ id: 'user-1' }]);

    const user = await service.create(SYSTEM, { ...NEW_USER, id: 'user-1' });

    const update = queries.find((q) => q.sql.includes("SET role = 'admin'"));

    expect(update!.sql).toMatch(/WHERE id = \$1/);
    expect(update!.params).toEqual([user.id]);
  });

  it('claims the appliance before announcing the account', async () => {
    // Anything reacting to UserCreated should not be able to observe a half-claimed appliance.
    const { service, eventService, queries } = makeService([{ id: 'user-1' }]);

    let queriesWhenAnnounced = -1;
    eventService.send.mockImplementation(() => {
      queriesWhenAnnounced = queries.length;

      return Promise.resolve();
    });

    await service.create(SYSTEM, NEW_USER);

    expect(eventService.send).toHaveBeenCalledWith(UserCreatedEvent, expect.anything());
    expect(queriesWhenAnnounced).toBe(queries.length);
  });

  it('still refuses a caller that is not the system user, before touching the appliance', async () => {
    const { service, userRepository } = makeService([{ id: 'user-1' }]);

    await expect(service.create({ userId: 'user-9' } as never, NEW_USER)).rejects.toThrow('Unauthorized');
    expect(userRepository.manager.transaction).not.toHaveBeenCalled();
  });
});

/**
 * The fake above is only worth anything while it answers the way TypeORM's Postgres driver does. If
 * it drifts back to plain rows for an UPDATE, every case in this file loses the ability to see the
 * bug it exists to catch. The driver itself is exercised in
 * `UserService.applianceClaim.integration.spec.ts`.
 */
describe('the driver fake these cases run on', () => {
  it('answers an UPDATE ... RETURNING with [rows, rowCount], CTE prefix or not', () => {
    const bare = `UPDATE ci.users SET role = 'admin' WHERE NOT EXISTS (SELECT 1) RETURNING id`;
    const prefixed = `WITH admins AS (SELECT 1) UPDATE ci.users SET role = 'admin' RETURNING id`;

    expect(driverResult(bare, [])).toEqual([[], 0]);
    expect(driverResult(prefixed, [{ id: 'user-1' }])).toEqual([[{ id: 'user-1' }], 1]);
  });

  it('answers an UPDATE wrapped in a CTE with the rows, because its outer command is a SELECT', () => {
    const wrapped = `WITH promoted AS (UPDATE ci.users SET role = 'admin' RETURNING id) SELECT id FROM promoted`;

    expect(driverResult(wrapped, [])).toEqual([]);
    expect(driverResult(wrapped, [{ id: 'user-1' }])).toEqual([{ id: 'user-1' }]);
  });
});
