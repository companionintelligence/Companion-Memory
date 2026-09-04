import { randomUUID } from 'node:crypto';

import { DataSource, type QueryRunner } from 'typeorm';

import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';
import { PythonFunctionCrons } from '../cron/PythonFunctionCrons';
import type { PythonFunctionService } from '../services/PythonFunctionService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DOSSIER FRESHNESS GATE, RANKED BY A REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `dossierRefresh` fans out hourly, and past its own `skipped:no_summaries`
 * exit `dossier_refresh` regenerates unconditionally — a full LLM pass over 30
 * days of daily plus 24 hours of hourly summaries. Its audience query is
 * therefore the only thing standing between a corpus that stopped moving and
 * 24 identical rebuilds a day per user.
 *
 * The unit suite can only assert that query's TEXT. A mocked DataSource returns
 * whatever the test handed it, so it cannot tell a comparison that ranks
 * correctly from one that is inverted, reads the wrong column, or compares a
 * naive UTC stamp against a session-local timestamptz. Every one of those bugs
 * passes a substring assertion. This suite executes the shipped query against
 * the real schema and reads the users Postgres actually returned.
 *
 * ── Why a rolled-back transaction is enough ────────────────────────────────
 *
 * `ci.summaries` is empty on the appliance this runs against and must stay
 * that way. Nothing here takes a connection of its own: the cron is handed a
 * DataSource whose `query` forwards to this file's single runner, so every
 * statement — fixtures and the audience query alike — is inside one
 * transaction that is always rolled back.
 */
const availability = databaseAvailability();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[python-functions/PythonFunctionCrons dossier gate] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

/** The six users the gate has to tell apart, by what it must decide for each. */
interface Fixture {
  /** No dossier row at all — the `'{}'` default. Must be dispatched. */
  noDossier: string;
  /** `lastUpdatedAt` older than the newest summary. Must be dispatched. */
  staleDossier: string;
  /** `lastUpdatedAt` newer than the newest summary. Must NOT be dispatched. */
  freshDossier: string;
  /** No summaries at all in the lookback. Must NOT be dispatched. */
  noSummaries: string;
  /** A `lastUpdatedAt` that will not parse. Fails open: must be dispatched. */
  unparseableStamp: string;
  /** No self entity to read a dossier from. Fails open: must be dispatched. */
  noEntity: string;
}

/** Naive-UTC ISO stamp, exactly the shape `store_dossier_activity` writes. */
function utcStamp(offsetHours: number): string {
  return new Date(Date.now() + offsetHours * 3_600_000).toISOString().replace('Z', '');
}

describeWithDb(`PythonFunctionCrons dossier freshness gate (${availability.target})`, () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    const connection = resolveConnection();

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
      synchronize: false,
      entities: [],
    });

    await dataSource.initialize();
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  async function seed(runner: QueryRunner): Promise<Fixture> {
    const fixture: Fixture = {
      noDossier: randomUUID(),
      staleDossier: randomUUID(),
      freshDossier: randomUUID(),
      noSummaries: randomUUID(),
      unparseableStamp: randomUUID(),
      noEntity: randomUUID(),
    };

    for (const [label, userId] of Object.entries(fixture)) {
      await runner.query(`INSERT INTO ci.users (id, email, name, onboarded) VALUES ($1, $2, $3, true)`, [
        userId,
        `dossier-gate.${userId}@example.test`,
        label,
      ]);
    }

    // The self entity is resolved through ci.users.entity_id, so `noEntity`
    // deliberately gets none: an appliance mid-onboarding has a user row before
    // it has a Person, and that user must still get a first dossier.
    const dossiers: Array<[string, string]> = [
      [fixture.noDossier, '{}'],
      [fixture.staleDossier, JSON.stringify({ lastUpdatedAt: utcStamp(-2) })],
      [fixture.freshDossier, JSON.stringify({ lastUpdatedAt: utcStamp(2) })],
      [fixture.noSummaries, '{}'],
      [fixture.unparseableStamp, JSON.stringify({ lastUpdatedAt: 'not-a-timestamp' })],
    ];

    for (const [userId, dossier] of dossiers) {
      const [{ entity_id: entityId }] = (await runner.query(
        `INSERT INTO ci.entities (entity_type, owner_user_id, dossier)
         VALUES ('Person', $1, $2::jsonb)
         RETURNING entity_id`,
        [userId, dossier],
      )) as Array<{ entity_id: string }>;

      await runner.query(`UPDATE ci.users SET entity_id = $1 WHERE id = $2`, [entityId, userId]);
    }

    const withSummaries = [
      fixture.noDossier,
      fixture.staleDossier,
      fixture.freshDossier,
      fixture.unparseableStamp,
      fixture.noEntity,
    ];

    for (const userId of withSummaries) {
      await runner.query(
        `INSERT INTO ci.summaries (user_id, period_start, period_end, period_type, source_types, created_at)
         VALUES ($1, now() - interval '1 hour', now(), 'hourly', '{}', now() - interval '1 hour')`,
        [userId],
      );
    }

    // Written by insights_generation into the same table, hourly. If the gate
    // counted it as dossier input, `freshDossier` would go stale every hour and
    // the rebuild loop would come back through the side door.
    await runner.query(
      `INSERT INTO ci.summaries (user_id, period_start, period_end, period_type, source_types, created_at)
       VALUES ($1, now() - interval '1 hour', now(), 'insight', '{}', now())`,
      [fixture.freshDossier],
    );

    return fixture;
  }

  /**
   * Runs the real cron against the real schema and reports which of the seeded
   * users it dispatched. Driving the cron rather than re-writing its SQL here
   * is the point: a test that hand-writes the query proves nothing about the
   * query that ships.
   */
  async function dispatchedUsers(): Promise<{ fixture: Fixture; dispatched: Set<string> }> {
    const runner = dataSource.createQueryRunner();

    await runner.connect();
    await runner.startTransaction();

    try {
      const fixture = await seed(runner);
      const dispatch = jest.fn().mockResolvedValue(true);
      const logger = {
        setContext: () => undefined,
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } as unknown as LoggerService;
      const crons = new PythonFunctionCrons(
        { query: (sql: string, params?: unknown[]) => runner.query(sql, params) } as unknown as DataSource,
        { dispatch } as unknown as PythonFunctionService,
        logger,
        { isFeatureEnabled: async () => false } as unknown as FeatureService,
      );

      await crons.dossierRefresh();

      const seeded = new Set(Object.values(fixture));
      const dispatched = new Set(
        (dispatch.mock.calls as Array<[string, string, string]>)
          .map(([, , userId]) => userId)
          .filter((userId) => seeded.has(userId)),
      );

      return { fixture, dispatched };
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  it('dispatches a user whose dossier has never been built', async () => {
    const { fixture, dispatched } = await dispatchedUsers();

    expect(dispatched.has(fixture.noDossier)).toBe(true);
  });

  it('dispatches a user whose newest summary postdates the stored dossier', async () => {
    const { fixture, dispatched } = await dispatchedUsers();

    expect(dispatched.has(fixture.staleDossier)).toBe(true);
  });

  // Finding 10, executed rather than asserted: this is the user the hourly
  // rebuild burned an LLM pass on 24 times a day. Note that the only summary
  // written after their dossier is an `insight` row, so a gate that counted
  // every period type would still dispatch here.
  it('withholds a user whose dossier is newer than every summary it reads', async () => {
    const { fixture, dispatched } = await dispatchedUsers();

    expect(dispatched.has(fixture.freshDossier)).toBe(false);
  });

  it('withholds a user with no dossier input in the lookback window', async () => {
    const { fixture, dispatched } = await dispatchedUsers();

    expect(dispatched.has(fixture.noSummaries)).toBe(false);
  });

  // Both fail-open cases. A stamp that will not parse must cost one extra LLM
  // pass, not a dossier that is never rebuilt again; the bare `::timestamp`
  // cast this replaces would have thrown and taken the whole fan-out with it.
  it('fails open for an unparseable stamp and for a user with no self entity', async () => {
    const { fixture, dispatched } = await dispatchedUsers();

    expect(dispatched.has(fixture.unparseableStamp)).toBe(true);
    expect(dispatched.has(fixture.noEntity)).toBe(true);
  });
});
