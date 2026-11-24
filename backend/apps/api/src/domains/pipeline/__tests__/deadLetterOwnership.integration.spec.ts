import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';

import { PipelineRunService } from '../services/PipelineRunService';
import { PipelineStateService } from '../services/PipelineStateService';
import type { StageRegistry } from '../services/StageRegistry';

import { databaseAvailability, resolveConnection } from './harness/pipelineHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A DEAD LETTER BELONGS TO ITS USER. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ci.pipeline_dead_letters` holds failed jobs' payloads verbatim: a graph
 * node the owner's agent wrote, a chat turn's context, a slice's entity ids.
 * Who may list and replay a letter is decided by one predicate on `user_id`,
 * and a NULL `user_id` used to mean "everyone". Three things have to hold
 * together for that to be safe, and each is a SQL statement whose semantics a
 * mock cannot check:
 *
 *  - the slice writer files its letter under the slice's user;
 *  - the backfill migration attributes the letters written before that, from
 *    `userId` then `ownerId`, and leaves everything else alone;
 *  - the list and both replay claims hand a member their own letters only, and
 *    the appliance admin their own plus the ones that name no user, and never
 *    anybody else's.
 *
 * Everything runs inside one transaction per test, ALWAYS rolled back, through
 * a `DataSource` double that funnels every statement into that transaction's
 * runner (the reaper spec's pattern). Nothing is committed, so the live
 * appliance's own letters can neither see these nor be changed by the
 * migration's global UPDATE. Assertions read the seeded ids only.
 *
 * Opt-in like its neighbours: `make test-db ARGS='src/domains/pipeline'`, or
 * `PIPELINE_TEST_DATABASE_URL` pointed at a migrated database of your own.
 */

const MIGRATION = '20261006065131_attribute_unowned_pipeline_dead_letters.sql';

/** The `-- migrate:up` half of the migration, as dbmate would run it. */
function migrationUpSql(): string {
  const file = path.resolve(__dirname, '../../../../db/postgres/migrations', MIGRATION);
  const sql = readFileSync(file, 'utf8');
  const down = sql.indexOf('-- migrate:down');

  if (down === -1) {
    throw new Error(`${file} has no migrate:down marker.`);
  }

  return sql.slice(0, down);
}

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[deadLetterOwnership.integration] SKIPPED — ${availability.reason}`);
}

const silentLogger = {
  setContext: () => undefined,
  log: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  verbose: () => undefined,
} as unknown as LoggerService;

describeWithDatabase('dead-letter ownership', () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let runService: PipelineRunService;
  let stateService: PipelineStateService;
  let send: jest.Mock;

  /** Two household accounts. No FK on `user_id`, so they need no `ci.users` rows. */
  const member = randomUUID();
  const otherMember = randomUUID();

  beforeAll(async () => {
    const connection = resolveConnection();

    if (connection == null) {
      throw new Error('databaseAvailability() said yes but no connection resolved');
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
      entities: [],
      synchronize: false,
      logging: false,
      extra: { max: 2 },
    });

    await dataSource.initialize();

    const [present] = await dataSource.query<Array<{ letters: string | null }>>(
      `SELECT to_regclass('ci.pipeline_dead_letters')::text AS letters`,
    );

    if (present.letters == null) {
      throw new Error(
        'ci.pipeline_dead_letters is missing — run `yarn workspace @ci/be-api migrate` and re-run this suite.',
      );
    }
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    const funnel = {
      query: (sql: string, params?: unknown[]) => runner.query(sql, params),
    } as unknown as DataSource;

    send = jest.fn(async () => ['job-1']);
    runService = new PipelineRunService(funnel, { send } as unknown as EventService, silentLogger, {
      has: () => false,
      get: () => undefined,
    } as unknown as StageRegistry);
    stateService = new PipelineStateService(funnel, silentLogger);
  });

  afterEach(async () => {
    // ALWAYS a rollback. Nothing this suite writes is ever committed.
    await runner.rollbackTransaction();
    await runner.release();
  });

  /**
   * A queue name no real job uses, fresh per test, so a list filtered by it
   * returns this test's letters and nothing the database already held. Replay
   * routes a queue that nothing listens on by listener registration, and the
   * bus is a mock, so the name costs nothing there.
   */
  let queue: string;

  beforeEach(() => {
    queue = `test-ownership-${randomUUID()}`;
  });

  /** One letter as a writer would leave it. `userId` undefined means SQL NULL. */
  async function seedLetter(fields: {
    userId?: string;
    payload?: unknown;
    eventName?: string;
  }): Promise<string> {
    const id = randomUUID();

    await runner.query(
      `INSERT INTO ci.pipeline_dead_letters (id, queue, event_name, user_id, payload, error, failed_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb, 'boom', '2000-01-01T00:00:00Z')`,
      [
        id,
        queue,
        fields.eventName ?? 'graph.node.upserted',
        fields.userId ?? null,
        JSON.stringify(fields.payload ?? {}),
      ],
    );

    return id;
  }

  async function ownerOf(id: string): Promise<string | null> {
    const rows = (await runner.query(`SELECT user_id FROM ci.pipeline_dead_letters WHERE id = $1::uuid`, [
      id,
    ])) as Array<{ user_id: string | null }>;

    return rows[0]?.user_id ?? null;
  }

  async function replayedAt(id: string): Promise<Date | null> {
    const rows = (await runner.query(`SELECT replayed_at FROM ci.pipeline_dead_letters WHERE id = $1::uuid`, [
      id,
    ])) as Array<{ replayed_at: Date | null }>;

    return rows[0]?.replayed_at ?? null;
  }

  describe('the slice writer', () => {
    it("files a failed slice under the slice's user", async () => {
      const marker = randomUUID();

      await stateService.recordDeadLetter({
        queue: 'pipeline-enrich',
        eventName: 'pipeline.slice',
        stage: 'enrich.geocode',
        entityType: 'event',
        userId: member,
        payload: { stage: 'enrich.geocode', userId: member, ids: [marker] },
        error: 'geocoder down',
      });

      const rows = (await runner.query(
        `SELECT user_id FROM ci.pipeline_dead_letters WHERE payload->'ids' ? $1`,
        [marker],
      )) as Array<{ user_id: string | null }>;

      expect(rows).toEqual([{ user_id: member }]);
    });
  });

  describe('the backfill migration', () => {
    it('attributes old letters from userId, then ownerId, and leaves the rest alone', async () => {
      const fromUserId = await seedLetter({ payload: { name: 'pipeline.slice', userId: member } });
      const fromOwnerId = await seedLetter({ payload: { name: 'graph.node.upserted', ownerId: member } });
      const userIdWins = await seedLetter({ payload: { userId: member, ownerId: otherMember } });
      const pastMalformed = await seedLetter({ payload: { userId: 'nope', ownerId: otherMember } });
      const namesNobody = await seedLetter({ payload: { name: 'content.created', contentId: randomUUID() } });
      const malformedOnly = await seedLetter({ payload: { ownerId: '../etc' } });
      const notAnObject = await seedLetter({ payload: ['an', 'array'] });
      // Already attributed: the migration must not move it, even when the
      // payload names somebody else.
      const alreadyOwned = await seedLetter({ userId: otherMember, payload: { userId: member } });

      await runner.query(migrationUpSql());

      expect(await ownerOf(fromUserId)).toBe(member);
      expect(await ownerOf(fromOwnerId)).toBe(member);
      expect(await ownerOf(userIdWins)).toBe(member);
      expect(await ownerOf(pastMalformed)).toBe(otherMember);
      expect(await ownerOf(namesNobody)).toBeNull();
      expect(await ownerOf(malformedOnly)).toBeNull();
      expect(await ownerOf(notAnObject)).toBeNull();
      expect(await ownerOf(alreadyOwned)).toBe(otherMember);
    });
  });

  describe('the Jobs page list', () => {
    let own: string;
    let others: string;
    let nobodys: string;

    beforeEach(async () => {
      own = await seedLetter({ userId: member, payload: { ownerId: member } });
      others = await seedLetter({ userId: otherMember, payload: { ownerId: otherMember } });
      nobodys = await seedLetter({ payload: { name: 'content.created' } });
    });

    /** The letters this caller was shown on this test's own queue. */
    async function listedFor(userId: string, includeUnattributed: boolean): Promise<string[]> {
      const letters = await runService.listDeadLetters({ userId }, { queue, includeUnattributed });

      return letters.map((letter) => letter.id);
    }

    it("shows a household member their own letters and nobody else's", async () => {
      expect(await listedFor(member, false)).toEqual([own]);
    });

    it('shows the appliance admin the letters that name no user, still not another member’s', async () => {
      expect((await listedFor(member, true)).sort()).toEqual([own, nobodys].sort());
      expect(await listedFor(otherMember, false)).toEqual([others]);
    });
  });

  describe('replay', () => {
    it('lets a member replay their own letter', async () => {
      const own = await seedLetter({
        userId: member,
        payload: { name: 'graph.node.upserted', ownerId: member },
      });

      await runService.replayDeadLetter({ userId: member }, own);

      expect(send).toHaveBeenCalledTimes(1);
      expect(await replayedAt(own)).not.toBeNull();
    });

    it("404s another member's letter and a letter that names no user, and leaves both unclaimed", async () => {
      const others = await seedLetter({ userId: otherMember, payload: { ownerId: otherMember } });
      const nobodys = await seedLetter({ payload: { name: 'content.created' } });

      await expect(runService.replayDeadLetter({ userId: member }, others)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(runService.replayDeadLetter({ userId: member }, nobodys)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(send).not.toHaveBeenCalled();
      expect(await replayedAt(others)).toBeNull();
      expect(await replayedAt(nobodys)).toBeNull();
    });

    it("lets the admin replay a letter that names no user, never another member's", async () => {
      const others = await seedLetter({ userId: otherMember, payload: { ownerId: otherMember } });
      const nobodys = await seedLetter({
        payload: { name: 'content.created' },
        eventName: 'content.created',
      });

      await runService.replayDeadLetter({ userId: member }, nobodys, { includeUnattributed: true });
      await expect(
        runService.replayDeadLetter({ userId: member }, others, { includeUnattributed: true }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(await replayedAt(nobodys)).not.toBeNull();
      expect(await replayedAt(others)).toBeNull();
    });

    it('claims only the caller’s letters in a bulk replay by event name', async () => {
      // The bulk form needs no ids, so its scope is the whole guard: an event
      // name alone used to claim every member's NULL-attributed letters.
      const eventName = `test.ownership.${randomUUID()}`;
      const own = await seedLetter({ userId: member, eventName, payload: { ownerId: member } });
      const others = await seedLetter({ userId: otherMember, eventName, payload: { ownerId: otherMember } });
      const nobodys = await seedLetter({ eventName, payload: {} });

      const asMember = await runService.replayDeadLetters({ userId: member }, { eventName });

      expect(asMember.replayed.map((letter) => letter.id)).toEqual([own]);
      expect(await replayedAt(others)).toBeNull();
      expect(await replayedAt(nobodys)).toBeNull();

      const asAdmin = await runService.replayDeadLetters(
        { userId: member },
        { eventName, includeUnattributed: true },
      );

      expect(asAdmin.replayed.map((letter) => letter.id)).toEqual([nobodys]);
      expect(await replayedAt(others)).toBeNull();
    });
  });
});
