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

/** The statement that asks whether the appliance has ever had an account. */
const isAccountCheck = (sql: string) => /SELECT EXISTS \(SELECT 1 FROM ci\.users\)/.test(sql);

/** What the fake appliance looks like to each statement. */
interface Appliance {
  /** What the unlocked check (`hasNoUsers`) sees: does any account exist? */
  accountsBefore: boolean;
  /** What the same check sees under the lock — different when another creation committed in between. */
  accountsUnderLock: boolean;
  /** The promoting statement's rows: `[{ id }]` promoted, `[]` not. */
  promotedRows: Array<{ id: string }>;
}

/**
 * A UserService over a fake repository that records, in `journal`, every step of an account
 * creation in the order it happened — the unlocked check, the hash, the lock, the locked check, the
 * INSERT, the promotion, the caller's `alongside` work, the commit and the announcement — and
 * answers every statement in the shape the real driver would give it.
 */
function makeService(appliance: Partial<Appliance> = {}) {
  const { accountsBefore = false, promotedRows = [{ id: 'user-1' }] } = appliance;
  const accountsUnderLock = appliance.accountsUnderLock ?? accountsBefore;

  const journal: string[] = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  bcrypt.hash.mockImplementation(async () => {
    journal.push('hash');

    return 'hashed';
  });

  const transactionManager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      queries.push({ sql, params });

      if (sql.includes('pg_advisory_xact_lock')) {
        journal.push('lock');

        return Promise.resolve(driverResult(sql, []));
      }

      if (isAccountCheck(sql)) {
        journal.push('locked-check');

        return Promise.resolve(driverResult(sql, [{ present: accountsUnderLock }]));
      }

      if (sql.includes("SET role = 'admin'")) {
        journal.push('promote');

        return Promise.resolve(driverResult(sql, promotedRows));
      }

      return Promise.reject(new Error(`unexpected statement in the claiming transaction: ${sql}`));
    }),
    save: jest.fn((entity: object) => {
      journal.push('insert');

      return Promise.resolve({ ...entity, role: 'user' });
    }),
  };

  const userRepository = {
    create: jest.fn((data: object) => data),
    // Never the way in: an account written outside the transaction is outside the lock.
    save: jest.fn(() =>
      Promise.reject(new Error('the account must be written inside the claiming transaction')),
    ),
    manager: {
      query: jest.fn((sql: string, params: unknown[]) => {
        queries.push({ sql, params });

        if (isAccountCheck(sql)) {
          journal.push('unlocked-check');

          return Promise.resolve(driverResult(sql, [{ present: accountsBefore }]));
        }

        return Promise.reject(new Error(`unexpected unlocked statement: ${sql}`));
      }),
      transaction: jest.fn(async (run: (m: unknown) => Promise<unknown>) => {
        const result = await run(transactionManager);

        journal.push('commit');

        return result;
      }),
    },
  };

  const eventService = {
    send: jest.fn(() => {
      journal.push('event');

      return Promise.resolve();
    }),
  };
  const service = new UserService(userRepository as never, eventService as never);

  return { service, userRepository, transactionManager, eventService, queries, journal };
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
    const { service } = makeService({ promotedRows: [{ id: 'user-1' }] });

    const user = await service.create(SYSTEM, NEW_USER);

    expect(user.role).toBe('admin');
  });

  it('leaves an account created on an owned appliance at its default role', async () => {
    // The UPDATE's own NOT EXISTS is what declines; an empty result means "not promoted".
    const { service } = makeService({ promotedRows: [] });

    const user = await service.create(SYSTEM, NEW_USER);

    expect(user.role).toBe('user');
  });

  it('reads the promotion from its rows, not from the pair a bare UPDATE resolves to', async () => {
    // `.length` of `[rows, rowCount]` is 2 whether or not a row matched, so the claim must be a
    // statement whose OUTER command is a SELECT. Pinned so it cannot be "simplified" back into a
    // bare UPDATE ... RETURNING, which is the exact shape that shipped every account as an admin.
    const { service, queries } = makeService({ promotedRows: [] });

    const user = await service.create(SYSTEM, NEW_USER);

    const update = queries.find((q) => q.sql.includes("SET role = 'admin'"));

    expect(outerCommand(update!.sql)).toBe('SELECT');
    expect(user.role).toBe('user');
  });

  it('asks the same "unowned" question ApplianceAdminGuard asks', async () => {
    // These two must agree. The guard admits EVERY signed-in user on an appliance with no live
    // admin; if this promotion applied a different test, that permissive branch could become the
    // steady state on a box this code considered already claimed.
    const { service, queries } = makeService();

    await service.create(SYSTEM, NEW_USER);

    const update = queries.find((q) => q.sql.includes("SET role = 'admin'"));

    expect(update).toBeDefined();
    expect(update!.sql).toMatch(/NOT EXISTS/);
    expect(update!.sql).toMatch(/role = 'admin' AND deleted_at IS NULL/);
  });

  it('writes the account and settles its role in one transaction, under the lock', async () => {
    // Both reads here are of the table about to be written, so two signups racing on a fresh
    // appliance would otherwise both observe "no admin" under READ COMMITTED and both promote. The
    // INSERT is inside too: a lock that covers the decision but not the write serializes nothing.
    const { service, userRepository, journal } = makeService();

    await service.create(SYSTEM, NEW_USER);

    expect(userRepository.manager.transaction).toHaveBeenCalledTimes(1);
    expect(journal).toEqual(['hash', 'lock', 'insert', 'promote', 'commit', 'event']);
  });

  it('does not ask whether an ordinary account is the first', async () => {
    // create() is every door that needs no such answer — an invitation, open signup, the Hub. Only
    // createFirstAccount declines; this must never quietly start refusing the second person.
    const { service, journal } = makeService({ accountsBefore: true });

    await service.create(SYSTEM, NEW_USER);

    expect(journal).not.toContain('unlocked-check');
    expect(journal).not.toContain('locked-check');
  });

  it('promotes the row it just created, never whichever row happens to be earliest', async () => {
    // The migrations resolve the owner with ORDER BY created_at because they run against rows that
    // already exist. Here the claiming account is known, and targeting it by id is what makes the
    // promotion agree with the migration rather than race it.
    const { service, queries } = makeService();

    const user = await service.create(SYSTEM, { ...NEW_USER, id: 'user-1' });

    const update = queries.find((q) => q.sql.includes("SET role = 'admin'"));

    expect(update!.sql).toMatch(/WHERE id = \$1/);
    expect(update!.params).toEqual([user.id]);
  });

  it('claims the appliance before announcing the account', async () => {
    // Anything reacting to UserCreated should not be able to observe a half-claimed appliance —
    // nor one whose claim has not committed yet.
    const { service, eventService, journal } = makeService();

    await service.create(SYSTEM, NEW_USER);

    expect(eventService.send).toHaveBeenCalledWith(UserCreatedEvent, expect.anything());
    expect(journal.indexOf('event')).toBeGreaterThan(journal.indexOf('commit'));
  });

  it('still refuses a caller that is not the system user, before touching the appliance', async () => {
    const { service, userRepository } = makeService();

    await expect(service.create({ userId: 'user-9' } as never, NEW_USER)).rejects.toThrow('Unauthorized');
    expect(userRepository.manager.transaction).not.toHaveBeenCalled();
  });
});

/**
 * ═══ THE FIRST ACCOUNT ═══
 *
 * Three doors admit someone without an invitation, and only as the appliance's first account:
 * `PortalTokenService`'s path 3, the signup-code exemption in `SignupController`, and an uninvited
 * OIDC sign-in in `OidcController`. They asked `hasNoUsers()` and then called `create()`, so two
 * sign-ins racing on an empty appliance both got in. `createFirstAccount` is the one step that
 * replaces that pair; these pin its order of operations. That it holds against a real race is
 * `auth/__tests__/FirstAccountGates.integration.spec.ts`.
 */
describe('UserService.createFirstAccount', () => {
  it('creates, and promotes, the first account on an appliance that has never had one', async () => {
    const { service, journal } = makeService({ accountsBefore: false });

    const user = await service.createFirstAccount(SYSTEM, NEW_USER);

    expect(user?.role).toBe('admin');
    expect(journal).toEqual([
      'unlocked-check',
      'hash',
      'lock',
      'locked-check',
      'insert',
      'promote',
      'commit',
      'event',
    ]);
  });

  it('declines on a claimed appliance before hashing a password, taking the lock or writing', async () => {
    // Every Portal token nobody here has bound reaches this. It has to stay one cheap query.
    const { service, userRepository, eventService, journal } = makeService({ accountsBefore: true });

    expect(await service.createFirstAccount(SYSTEM, NEW_USER)).toBeNull();

    expect(journal).toEqual(['unlocked-check']);
    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(userRepository.manager.transaction).not.toHaveBeenCalled();
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('asks again under the lock, and writes nothing when another account got there first', async () => {
    // The race itself: the appliance looked empty, and by the time the lock was granted another
    // creation had committed. The unlocked answer is never the one acted on.
    const { service, transactionManager, eventService, journal } = makeService({
      accountsBefore: false,
      accountsUnderLock: true,
    });

    expect(await service.createFirstAccount(SYSTEM, NEW_USER)).toBeNull();

    expect(journal).toEqual(['unlocked-check', 'hash', 'lock', 'locked-check', 'commit']);
    expect(transactionManager.save).not.toHaveBeenCalled();
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('counts soft-deleted accounts: "first" means no row at all, the same question hasNoUsers asks', async () => {
    // Deliberately NOT the admin claim's "no live admin". An account awaiting its purge still means
    // someone claimed this box; reopening uninvited signup while its data is on disk is a way back
    // in. And the unlocked and locked answers must come from ONE definition, or they can drift.
    const { service, queries } = makeService();

    await service.createFirstAccount(SYSTEM, NEW_USER);

    const [unlocked, locked] = queries.filter((q) => isAccountCheck(q.sql));

    expect(locked.sql).toBe(unlocked.sql);
    expect(locked.sql).not.toMatch(/deleted_at|role/);
  });

  it('writes the caller’s record of the claim in the same transaction, after the promotion and before the commit', async () => {
    const { service, transactionManager, journal } = makeService();

    const alongside = jest.fn(async () => {
      journal.push('alongside');
    });

    const user = await service.createFirstAccount(SYSTEM, NEW_USER, alongside);

    // The transaction's own manager, so the write rolls back with the account; and the user as
    // promoted, so a binding written here describes the owner.
    expect(alongside).toHaveBeenCalledWith(
      transactionManager,
      expect.objectContaining({ id: user!.id, role: 'admin' }),
    );
    expect(journal.slice(journal.indexOf('insert'))).toEqual([
      'insert',
      'promote',
      'alongside',
      'commit',
      'event',
    ]);
  });

  it('announces nothing when the alongside work fails', async () => {
    // The transaction rolls the account back with it; that part is Postgres's, and is proven
    // against a real one in the integration spec.
    const { service, eventService } = makeService();

    await expect(
      service.createFirstAccount(SYSTEM, NEW_USER, () => Promise.reject(new Error('bind failed'))),
    ).rejects.toThrow('bind failed');
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('refuses a caller that is not the system user, before asking anything', async () => {
    const { service, journal } = makeService();

    await expect(service.createFirstAccount({ userId: 'user-9' } as never, NEW_USER)).rejects.toThrow(
      'Unauthorized',
    );
    expect(journal).toEqual([]);
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
