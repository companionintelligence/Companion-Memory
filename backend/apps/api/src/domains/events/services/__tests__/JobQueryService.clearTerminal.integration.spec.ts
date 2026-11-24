import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { DataSource } from 'typeorm';
import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/context';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../../__tests__/support/scratchDatabase';
import { DeadLetterReaperListener } from '../../../pipeline';
import { DEAD_LETTER_QUEUE } from '../../constants';
import { JobCategoryMetricEntity } from '../../entities/JobCategoryMetricEntity';
import { JobMetricEntity } from '../../entities/JobMetricEntity';
import { PgBossJobEntity } from '../../entities/PgBossJobEntity';
import { JobQueryService } from '../JobQueryService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `POST /jobs/clear` MUST NOT DESTROY WHAT THE REAPER HAS NOT COPIED YET.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `clearTerminal('dead-letter')` shipped as an unqualified
 * `DELETE FROM pgboss.job WHERE name = 'dead-letter'`. The dead-letter queue is
 * not unconsumed: `DeadLetterReaperListener.reap()` copies at most 500 rows
 * every two minutes into `ci.pipeline_dead_letters`, which is what the Dead
 * letters card on the same page renders and replays from. So one click during a
 * 20,000-letter backlog deleted ~19,500 payloads and their failure output from
 * BOTH tables — worst when the worker is down, because then the reaper's cron is
 * not ticking either and NOTHING has been harvested.
 *
 * ── Why a database of its own, and not a transaction ────────────────────────
 *
 * Because the statement under test is an unqualified DELETE across
 * `pgboss.job`. There is no marker, no owner and no run id
 * to scope it to — deleting everything IS the behaviour. Running that against
 * the dev appliance behind a rollback would be the exact bet
 * `__tests__/support/scratchDatabase.ts` documents losing: a suite that believed
 * a transaction fenced it in and left ~599,000 rows in somebody's archive.
 * Isolation here is a property of the CONNECTION.
 *
 * ── Why pg-boss builds the tables here ─────────────────────────
 *
 * pg-boss's TABLES are created by pg-boss at boot, not by a migration —
 * `20251001000000_setup_pgboss_schema.sql` creates the empty schema and says so
 * — so a freshly migrated database has `ci.pipeline_dead_letters` and no
 * `pgboss.job` to join it to. Booting the real pg-boss gives this file the
 * partitioned table the running appliance has, which matters because the
 * predicate under test correlates a subquery to the DELETE target on it: a
 * shape a mocked QueryBuilder cannot check and a copied table goes stale on.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[events/JobQueryService.clearTerminal] SKIPPED — ${availability.reason}`);
}

// CREATE DATABASE plus every migration.
jest.setTimeout(300_000);

describeWithDatabase(`JobQueryService.clearTerminal — against real Postgres (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let dataSource: DataSource;
  let mapped: DataSource;
  let service: JobQueryService;
  let reaper: DeadLetterReaperListener;
  let boss: PgBoss;

  const CTX: RequestContext = { userId: uuidv7() } as RequestContext;

  /** Insert a job. `queue` must be one of the two queues created in `beforeAll`. */
  async function seedJob(overrides: {
    id?: string;
    queue?: string;
    eventName?: string;
    state?: string;
    output?: Record<string, unknown> | null;
  }): Promise<string> {
    const id = overrides.id ?? uuidv7();

    await dataSource.query(
      `INSERT INTO pgboss.job (id, name, data, state, output)
       VALUES ($1, $2, $3::jsonb, $4::pgboss.job_state, $5::jsonb)`,
      [
        id,
        overrides.queue ?? 'default',
        JSON.stringify({ name: overrides.eventName ?? 'test.event', userId: CTX.userId }),
        overrides.state ?? 'failed',
        overrides.output ? JSON.stringify(overrides.output) : null,
      ],
    );

    return id;
  }

  async function deadLetterIds(): Promise<string[]> {
    const rows = await dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM pgboss.job WHERE name = $1 ORDER BY id`,
      [DEAD_LETTER_QUEUE],
    );

    return rows.map((row) => row.id);
  }

  async function ledgerIds(): Promise<string[]> {
    const rows = await dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM ci.pipeline_dead_letters ORDER BY id`,
    );

    return rows.map((row) => row.id);
  }

  async function truncateAll(): Promise<void> {
    await dataSource.query('DELETE FROM pgboss.job');
    await dataSource.query('DELETE FROM ci.pipeline_dead_letters');
  }

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({
      createdBy: 'JobQueryService.clearTerminal.integration.spec',
    });

    await scratch.assertOwn();

    dataSource = scratch.dataSource;

    const { host, port, username, password, database } = scratch.dataSource
      .options as PostgresDataSourceOptions;

    boss = new PgBoss({ host, port, user: username, password, database, schema: 'pgboss', schedule: false });
    boss.on('error', (error: Error) => console.error(`pg-boss: ${error.message}`));

    await boss.start();
    await boss.createQueue(DEAD_LETTER_QUEUE);
    await boss.createQueue('default');

    // A second connection to the same scratch database, this one with the
    // entities mapped: `clearTerminal` builds its DELETE through the
    // repository's query builder, so it needs real entity metadata to emit the
    // real SQL. `synchronize` stays off: pg-boss owns the schema, and TypeORM
    // would otherwise "fix" the drift rather than report it.

    mapped = new DataSource({
      type: 'postgres',
      host,
      port,
      username,
      password,
      database,
      entities: [PgBossJobEntity, JobMetricEntity, JobCategoryMetricEntity],
      synchronize: false,
      extra: { max: 4 },
    });

    await mapped.initialize();

    service = new JobQueryService(
      mapped.getRepository(PgBossJobEntity),
      mapped.getRepository(JobMetricEntity),
      mapped.getRepository(JobCategoryMetricEntity),
    );

    // The real reaper, against the real tables — so "harvested" in these tests
    // means what the running appliance means by it, rather than what a fixture
    // asserts it means. If the two ever diverge (a changed idempotency key, say)
    // this file fails instead of passing on its own private definition.
    reaper = new DeadLetterReaperListener(dataSource, {
      setContext: () => undefined,
      log: () => undefined,
      debug: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never);
  });

  afterEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await mapped?.destroy();
    await scratch?.drop();
  });

  // -------------------------------------------------------------------------
  // The data-loss regression
  // -------------------------------------------------------------------------

  it('leaves every dead letter the reaper has not copied yet', async () => {
    // The shape of the incident: a backlog bigger than one reap batch, cleared
    // mid-drain. Three letters, one harvested.
    const harvested = await seedJob({ queue: DEAD_LETTER_QUEUE, state: 'created' });
    const pendingA = await seedJob({ queue: DEAD_LETTER_QUEUE, state: 'created' });
    const pendingB = await seedJob({ queue: DEAD_LETTER_QUEUE, state: 'created' });

    // Harvest exactly one, the way a partial drain leaves the queue.
    await dataSource.query(
      `INSERT INTO ci.pipeline_dead_letters (id, queue, event_name, payload, error)
       VALUES ($1, $2, 'test.event', '{}'::jsonb, 'boom')`,
      [harvested, DEAD_LETTER_QUEUE],
    );

    const result = await service.clearTerminal(CTX, 'dead-letter');

    expect(result).toEqual({ scope: 'dead-letter', deleted: 1, retained: 2 });
    // The unharvested payloads are still in pg-boss, still replayable.
    expect(await deadLetterIds()).toEqual([pendingA, pendingB].sort());
    // …and the ledger is untouched: this route never deletes from our table.
    expect(await ledgerIds()).toEqual([harvested]);
  });

  it('deletes NOTHING when the worker is down and nothing has been harvested', async () => {
    // The case the button is most tempting in, and the one the unqualified
    // DELETE destroyed 100% of: no reaper ticks means an empty ledger, so every
    // dead letter on the box is the only copy of its payload.
    const ids = [
      await seedJob({ queue: DEAD_LETTER_QUEUE, state: 'created' }),
      await seedJob({ queue: DEAD_LETTER_QUEUE, state: 'created' }),
    ].sort();

    const result = await service.clearTerminal(CTX, 'dead-letter');

    expect(result).toEqual({ scope: 'dead-letter', deleted: 0, retained: 2 });
    expect(await deadLetterIds()).toEqual(ids);
  });

  it('agrees with the reaper about what "harvested" means', async () => {
    // Not a re-statement of the test above: there the ledger row was written by
    // hand, so it only proved the predicate matches ITSELF. Here the real
    // reaper decides, which is what pins `ci.pipeline_dead_letters.id` being the
    // originating pg-boss job id — the fact the whole predicate rests on.
    await seedJob({ queue: DEAD_LETTER_QUEUE, state: 'created', output: { message: 'boom' } });
    await seedJob({ queue: DEAD_LETTER_QUEUE, state: 'created', output: { message: 'bang' } });
    const late = await seedJob({ queue: DEAD_LETTER_QUEUE, state: 'created' });

    // A bounded reap, exactly like the cron's batched one: two of the three.
    expect(await reaper.reap(2)).toBe(2);

    const result = await service.clearTerminal(CTX, 'dead-letter');

    expect(result).toEqual({ scope: 'dead-letter', deleted: 2, retained: 1 });
    expect(await deadLetterIds()).toEqual([late]);

    // And the payloads the reaper took are still readable afterwards — the
    // point of keeping the ledger, not merely of keeping a row count.
    const kept = await dataSource.query<Array<{ error: string }>>(
      `SELECT error FROM ci.pipeline_dead_letters ORDER BY error`,
    );

    expect(kept.map((row) => row.error)).toEqual(['bang', 'boom']);
  });

  it('clears the whole queue once the reaper has caught up', async () => {
    // The predicate must not be a permanent floor: after a full drain, Clear
    // still empties the queue. Otherwise "keep what is not copied" would read as
    // "never clear anything".
    await seedJob({ queue: DEAD_LETTER_QUEUE, state: 'created' });
    await seedJob({ queue: DEAD_LETTER_QUEUE, state: 'created' });

    await reaper.reap();

    const result = await service.clearTerminal(CTX, 'dead-letter');

    expect(result).toEqual({ scope: 'dead-letter', deleted: 2, retained: 0 });
    expect(await deadLetterIds()).toEqual([]);
    expect(await ledgerIds()).toHaveLength(2);
  });

  it('never touches live work, whatever the scope', async () => {
    const live = [
      await seedJob({ state: 'created' }),
      await seedJob({ state: 'active' }),
      await seedJob({ state: 'retry' }),
      await seedJob({ state: 'completed' }),
    ];

    await service.clearTerminal(CTX, 'dead-letter');
    await service.clearTerminal(CTX, 'failed');

    const survivors = await dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM pgboss.job WHERE name = 'default' ORDER BY id`,
    );

    expect(survivors.map((row) => row.id).sort()).toEqual([...live].sort());
  });

  it('refuses to clear at all when the ledger table is missing', async () => {
    // Fail CLOSED. Without `ci.pipeline_dead_letters` there is no way to tell a
    // harvested letter from an unharvested one, and the safe reading of "I
    // cannot tell" is not "delete them".
    await seedJob({ queue: DEAD_LETTER_QUEUE, state: 'created' });

    await dataSource.query('ALTER TABLE ci.pipeline_dead_letters RENAME TO pipeline_dead_letters_hidden');

    try {
      await expect(service.clearTerminal(CTX, 'dead-letter')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(await deadLetterIds()).toHaveLength(1);
    } finally {
      await dataSource.query('ALTER TABLE ci.pipeline_dead_letters_hidden RENAME TO pipeline_dead_letters');
    }
  });

  // -------------------------------------------------------------------------
  // The failed scope
  // -------------------------------------------------------------------------

  it('clears failed rows so the count can reach zero', async () => {
    // The Health card's number is `JobMonitorService.getSummary`'s `failed`,
    // which counts these rows.
    await seedJob({ state: 'failed' });
    await seedJob({ state: 'failed' });

    const result = await service.clearTerminal(CTX, 'failed');

    expect(result).toEqual({ scope: 'failed', deleted: 2, retained: 0 });

    const [{ live }] = await dataSource.query<Array<{ live: string }>>(
      `SELECT count(*)::text AS live FROM pgboss.job WHERE state = 'failed'`,
    );

    expect(live).toBe('0');
  });

  it('leaves rows that merely finished, and failed dead letters', async () => {
    // Two ways the delete could overreach, both pinned: `completed` history is
    // not this button's business, and a dead letter is the OTHER scope's, under
    // the other scope's predicate.
    const completed = await seedJob({ state: 'completed' });
    const failedDeadLetter = await seedJob({ queue: DEAD_LETTER_QUEUE, state: 'failed' });

    const result = await service.clearTerminal(CTX, 'failed');

    expect(result.deleted).toBe(0);

    const rows = await dataSource.query<Array<{ id: string }>>(`SELECT id FROM pgboss.job ORDER BY id`);

    expect(rows.map((row) => row.id).sort()).toEqual([completed, failedDeadLetter].sort());
  });

  it('refuses a request with no user context, before touching anything', async () => {
    await seedJob({ state: 'failed' });
    await seedJob({ queue: DEAD_LETTER_QUEUE, state: 'created' });

    await expect(service.clearTerminal({} as RequestContext, 'failed')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.clearTerminal({} as RequestContext, 'dead-letter')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    const [{ total }] = await dataSource.query<Array<{ total: string }>>(
      `SELECT count(*)::text AS total FROM pgboss.job`,
    );

    expect(total).toBe('2');
  });
});
