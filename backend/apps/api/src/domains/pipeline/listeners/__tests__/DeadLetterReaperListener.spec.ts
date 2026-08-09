import { randomUUID } from 'node:crypto';

import { DataSource, type QueryRunner } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../__tests__/harness/pipelineHarness';
import { DEAD_LETTER_QUEUE, DEAD_LETTER_REAP_BATCH, PIPELINE_CONTROL_QUEUE } from '../../constants';
import { PipelineDeadLetterReapEvent } from '../../events';
import { DeadLetterReaperListener } from '../DeadLetterReaperListener';

/**
 * The reaper is the FIRST consumer pg-boss's `dead-letter` queue has ever had.
 *
 * Until it existed, a job that burned its three retries was re-inserted onto
 * that queue and then sat there: no worker, no list endpoint, no UI, no replay
 * path. pg-boss's retention deleted it a month later and the payload went with
 * it — and for an appliance the payload is frequently the only surviving copy
 * of a record the source will not re-send. So the property under test is not
 * "the reaper runs", it is **evidence survives**: every dead letter becomes a
 * row, the payload is byte-for-byte replayable, and nothing about a weird job
 * (no event name, no provenance, a payload that is not even an object) can talk
 * the reaper out of recording it.
 *
 * ## Two halves, because the behaviour lives in two places
 *
 * **Against a fake `DataSource`** — the control flow: the `to_regclass` guard,
 * which queue name is read, how the batch is bounded, what the on-demand event
 * accepts, and what happens when the copy itself fails. Fast, hermetic, always
 * runs.
 *
 * **Against real Postgres** — the semantics, which are ENTIRELY in one SQL
 * statement. Whether the payload survives verbatim, whether `data->>'entityId'`
 * of `'not-a-uuid'` nulls one column or aborts the whole batch, what
 * `event_name` a job with no name gets, which of the three `error` fallbacks
 * fires, and that `replayed_at` starts NULL — none of that is observable from a
 * mock, because a mock agrees with whatever the statement asks it. Skipped, not
 * faked, when there is no database; see `__tests__/harness/README.md`.
 *
 * ## How the database half stays out of the dev data
 *
 * Differently from the integration harness next door, and more strictly: the
 * listener is handed a `DataSource` double that funnels every statement into a
 * single `QueryRunner` inside a transaction which is **always rolled back**.
 * Nothing is ever committed — not the synthetic `pgboss.job` rows, not the
 * `ci.pipeline_dead_letters` copies — so no other session can observe them
 * (including the live appliance's own reap cron), there is nothing to clean up,
 * and a `kill -9` mid-run leaves the database untouched because the aborted
 * transaction takes the lot with it.
 *
 * Synthetic jobs are dated in the year 2000 on purpose. The reaper harvests
 * `ORDER BY j.created_on LIMIT $2`, so rows this old always sort ahead of any
 * genuine dead letter (which carries `now()`), and a `limit` assertion cannot be
 * knocked over by whatever the appliance happened to fail at while the suite ran.
 */

// The database half must choose `describe` vs `describe.skip` at COLLECTION
// time — jest cannot skip a suite from inside an async `beforeAll`, and a suite
// that "passes" by returning early from every test reports green for work it
// never did. `databaseAvailability()` answers synchronously for exactly this.
const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  // Printed once per run so a skipped half is never mistaken for a passing one.
  console.warn(`[DeadLetterReaperListener.spec] SKIPPED (database half) — ${availability.reason}`);
}

// ---------------------------------------------------------------------------
// Half one: the control flow, against a fake DataSource
// ---------------------------------------------------------------------------

/** One statement the listener issued, whitespace-collapsed for matching. */
interface Statement {
  sql: string;
  params: unknown[];
}

interface ReaperOptions {
  /** Does `pgboss.job` exist? False models a deployment that never booted pg-boss. */
  pgboss?: boolean;
  /** Ids the `INSERT ... RETURNING id` answers with — i.e. what was harvested. */
  harvested?: string[];
  /** Make the copy fail, the way a missing table or a dead connection would. */
  insertError?: Error;
}

function makeReaper(options: ReaperOptions = {}) {
  const statements: Statement[] = [];

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    statements.push({ sql, params: params ?? [] });

    if (/to_regclass/i.test(sql)) {
      // Shaped like the real answer: one row, one boolean column. The listener
      // destructures it positionally.
      return [{ exists: options.pgboss ?? true }];
    }

    if (/insert into ci\.pipeline_dead_letters/i.test(sql)) {
      if (options.insertError != null) {
        throw options.insertError;
      }

      return (options.harvested ?? []).map((id) => ({ id }));
    }

    // Anything else is a statement this spec does not know the reaper makes.
    // Answering it with `[]` would let a future DELETE against `pgboss.job`
    // pass silently, and destroying the source copy is the one thing the
    // reaper must never do.
    throw new Error(`DeadLetterReaperListener issued an unexpected statement: ${sql}`);
  });

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn(),
  };

  const dataSource = { query, manager: { query } };
  const listener = new DeadLetterReaperListener(
    dataSource as unknown as DataSource,
    logger as unknown as LoggerService,
  );

  return {
    listener,
    logger,
    statements,
    /** Just the copy statements — the ones that write anything. */
    inserts: (): Statement[] =>
      statements.filter((s) => /insert into ci\.pipeline_dead_letters/i.test(s.sql)),
  };
}

describe('DeadLetterReaperListener', () => {
  describe('what it asks the database for', () => {
    it('reads the dead-letter queue by name and bounds the batch', async () => {
      const h = makeReaper();

      await h.listener.reap();

      const [insert] = h.inserts();
      expect(insert).toBeDefined();
      expect(insert.sql).toMatch(/from pgboss\.job/i);
      // $1 is the queue name and $2 the ceiling. The queue name is duplicated
      // from PGBossEventService's private constant; if these drift the reaper
      // silently harvests nothing forever, which is why it is asserted rather
      // than assumed.
      expect(insert.params).toEqual([DEAD_LETTER_QUEUE, DEAD_LETTER_REAP_BATCH]);
    });

    it('never deletes, completes or otherwise touches pg-boss’s own copy', async () => {
      // The dead letter in `pgboss.job` outlives the reap on purpose: it stays
      // inspectable for its full retention alongside ours, and a reaper that
      // consumed it would be one bug away from destroying the evidence it
      // exists to preserve.
      const h = makeReaper({ harvested: [randomUUID()] });

      await h.listener.reap();

      for (const { sql } of h.statements) {
        expect(sql).not.toMatch(/delete\s+from\s+pgboss/i);
        expect(sql).not.toMatch(/update\s+pgboss/i);
      }
    });

    it('skips the harvest entirely when the deployment has no pg-boss', async () => {
      // `pgboss` is created by pg-boss at boot, not by a migration, so it is
      // absent under LocalEventService and in some dev setups. The guard is why
      // a two-minute cron does not log an error forever on those.
      const h = makeReaper({ pgboss: false });

      await expect(h.listener.reap()).resolves.toBe(0);

      expect(h.inserts()).toHaveLength(0);
      expect(h.logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('what it reports', () => {
    it('returns the number of letters it copied', async () => {
      const h = makeReaper({ harvested: [randomUUID(), randomUUID(), randomUUID()] });

      await expect(h.listener.reap()).resolves.toBe(3);
    });

    it('warns with the count, because reaching this line means jobs died terminally', async () => {
      const h = makeReaper({ harvested: [randomUUID(), randomUUID()] });

      await h.listener.reap();

      expect(h.logger.warn).toHaveBeenCalledTimes(1);
      const [message, meta] = h.logger.warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toContain('2');
      expect(meta).toEqual(expect.objectContaining({ queue: DEAD_LETTER_QUEUE, harvested: 2 }));
    });

    it('flags a full batch, so an operator knows more is waiting', async () => {
      const h = makeReaper({ harvested: [randomUUID(), randomUUID()] });

      await h.listener.reap(2);

      const [, meta] = h.logger.warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(meta).toEqual(expect.objectContaining({ moreLikely: true }));
    });

    it('says nothing at all on the steady-state empty reap', async () => {
      // This runs every two minutes forever on a healthy appliance. A log line
      // per tick would be the whole log.
      const h = makeReaper({ harvested: [] });

      await expect(h.listener.reap()).resolves.toBe(0);
      expect(h.logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('the on-demand reap', () => {
    it('honours an explicit limit', async () => {
      const h = makeReaper();

      await h.listener.reapOnRequest({ limit: 7 });

      expect(h.inserts()[0].params).toEqual([DEAD_LETTER_QUEUE, 7]);
    });

    it.each([
      ['an empty payload', {}],
      ['no payload at all', undefined],
      ['a null payload', null],
    ])('falls back to the standing batch size given %s', async (_label, payload) => {
      const h = makeReaper();

      await h.listener.reapOnRequest(payload);

      expect(h.inserts()[0].params).toEqual([DEAD_LETTER_QUEUE, DEAD_LETTER_REAP_BATCH]);
    });

    it.each([
      ['zero', { limit: 0 }],
      ['negative', { limit: -1 }],
      ['fractional', { limit: 2.5 }],
      ['not a number', { limit: '500' }],
      ['absurd', { limit: 10_001 }],
    ])('refuses %s limit before issuing a single statement', async (_label, payload) => {
      const h = makeReaper();

      await expect(h.listener.reapOnRequest(payload)).rejects.toThrow();
      expect(h.statements).toHaveLength(0);
    });

    it('rides the pipeline control queue, never the dead-letter queue itself', () => {
      // A listener registered ON `dead-letter` would make it a discovered queue
      // and start a worker there — and that worker fetches EVERY dead letter,
      // finds no handler for the other forty event names, and completes them.
      // Subscribing would therefore destroy the dead letters of every other
      // event, and would additionally feed the reaper's own failures back into
      // the queue it reads. Polling avoids both; this pins the wiring that says
      // so.
      const listeners = Reflect.getMetadata(
        'EVENT_LISTENER_METADATA',
        DeadLetterReaperListener.prototype.reapOnRequest,
      ) as Array<{ event: string }> | undefined;

      expect(listeners).toBeDefined();
      expect(listeners?.map((entry) => entry.event)).toEqual([
        `${PipelineDeadLetterReapEvent}:${PIPELINE_CONTROL_QUEUE}`,
      ]);
      expect(PIPELINE_CONTROL_QUEUE).not.toBe(DEAD_LETTER_QUEUE);
    });
  });

  describe('the scheduled reap', () => {
    it('is the same reap, at the standing batch size', async () => {
      const h = makeReaper({ harvested: [randomUUID()] });

      await h.listener.reapOnSchedule();

      expect(h.inserts()[0].params).toEqual([DEAD_LETTER_QUEUE, DEAD_LETTER_REAP_BATCH]);
    });
  });

  describe('when the copy itself fails', () => {
    /**
     * ACTUAL behaviour, asserted rather than wished for: `reap()` has no
     * try/catch, so a failing INSERT rejects out of both entry points.
     *
     * On the EVENT path that is right, and it does not loop. The reap request
     * rides `pipeline-index` (see the wiring test above), so pg-boss retries it
     * and, if it keeps failing, dead-letters the request job like any other.
     * That job then sits in `dead-letter` until a LATER, working reap copies it
     * into the table — one terminal row, no cycle. The alternative, swallowing
     * the error, would report a successful reap that harvested nothing, which
     * is the exact class of silence this subsystem was rebuilt to delete.
     *
     * On the CRON path it must NOT propagate, and the two entry points diverge
     * here deliberately. `@Cron` is `@nestjs/schedule`, which builds
     * `CronJob.from({ onTick: target })` without `waitForCompletion`, and
     * `cron`'s `fireOnTick` only awaits — and therefore only catches — the
     * callback when that flag is set. An async tick that rejects is an
     * UNHANDLED REJECTION, and `application.ts` answers those with
     * `process.exit(1)`. On a two-minute timer that is a crash loop, taking down
     * the API because the component whose job is to observe failures failed.
     *
     * So `reapOnSchedule` catches and logs; the next tick retries, and the
     * un-harvested dead letter is still sitting safely in `pgboss.job`. Nothing
     * is silenced — the error reaches the log at error level.
     */
    it('propagates out of the on-demand reap so pg-boss can retry it', async () => {
      const h = makeReaper({ insertError: new Error('deadlock detected') });

      await expect(h.listener.reapOnRequest({})).rejects.toThrow('deadlock detected');
    });

    it('never rejects out of the scheduled reap — an unhandled tick would exit the process', async () => {
      const h = makeReaper({
        // The case that made this concrete: pg-boss exists and the
        // control-plane migration has not been applied yet.
        insertError: new Error('relation "ci.pipeline_dead_letters" does not exist'),
      });

      await expect(h.listener.reapOnSchedule()).resolves.toBeUndefined();
    });

    it('logs the failure it swallowed, so a broken reaper is still visible', async () => {
      const h = makeReaper({
        insertError: new Error('relation "ci.pipeline_dead_letters" does not exist'),
      });

      await h.listener.reapOnSchedule();

      expect(h.logger.error).toHaveBeenCalled();
    });

    it('reports zero harvested, never a count it did not write', async () => {
      const h = makeReaper({ insertError: new Error('connection terminated') });

      await h.listener.reap().catch(() => undefined);

      expect(h.logger.warn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Half two: the SQL, against real Postgres
  // -------------------------------------------------------------------------

  describeWithDatabase('persisting a dead letter (real Postgres)', () => {
    let dataSource: DataSource;
    let runner: QueryRunner;
    let listener: DeadLetterReaperListener;
    let clock = 0;

    beforeAll(async () => {
      const connection = resolveConnection();

      if (connection == null) {
        throw new Error('databaseAvailability() said yes but no connection resolved');
      }

      dataSource = new DataSource({
        type: 'postgres',
        // Discrete fields, never a URL assembled here: the dev password ends in
        // `!` and must not have to survive percent-encoding.
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

      // Three outcomes, deliberately different (harness README): no database →
      // skipped at collection time; a database missing the tables → FAIL here,
      // naming the fix, because that is a broken setup and skipping would turn
      // a migration mistake into a green run.
      const [present] = await dataSource.query<Array<{ job: string | null; letters: string | null }>>(
        `SELECT to_regclass('pgboss.job')::text AS job, to_regclass('ci.pipeline_dead_letters')::text AS letters`,
      );

      if (present.letters == null) {
        throw new Error(
          'ci.pipeline_dead_letters is missing — run `yarn workspace @ci/be-api migrate` and re-run this suite.',
        );
      }

      if (present.job == null) {
        throw new Error(
          'pgboss.job is missing — pg-boss creates it at boot, so start the API once against this database ' +
            '(or point PIPELINE_TEST_DATABASE_URL at the dev one) and re-run this suite.',
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

      listener = new DeadLetterReaperListener(
        {
          query: (sql: string, params?: unknown[]) => runner.query(sql, params),
        } as unknown as DataSource,
        {
          setContext: () => undefined,
          log: () => undefined,
          debug: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          verbose: () => undefined,
        } as unknown as LoggerService,
      );
    });

    afterEach(async () => {
      // ALWAYS a rollback. Nothing this suite writes is ever committed.
      await runner.rollbackTransaction();
      await runner.release();
    });

    /** `undefined` means SQL NULL; `null` means the JSON value `null`. */
    function toJsonb(value: unknown): string | null {
      return value === undefined ? null : JSON.stringify(value);
    }

    /**
     * One exhausted job on the dead-letter queue, as pg-boss re-inserts it:
     * original payload in `data`, the failure in `output`.
     */
    async function seedDeadLetter(fields: { data?: unknown; output?: unknown } = {}): Promise<string> {
      const id = randomUUID();
      // Year 2000 + a monotonic counter: older than every genuine dead letter,
      // so `ORDER BY created_on LIMIT` is deterministic no matter what the live
      // appliance is doing, and ordering between seeded rows is the seed order.
      const createdOn = new Date(Date.UTC(2000, 0, 1) + clock++ * 1_000).toISOString();

      await runner.query(
        `INSERT INTO pgboss.job (id, name, data, output, created_on, keep_until)
         VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5::timestamptz, $5::timestamptz + interval '30 days')`,
        [id, DEAD_LETTER_QUEUE, toJsonb(fields.data), toJsonb(fields.output), createdOn],
      );

      return id;
    }

    interface LetterRow {
      id: string;
      queue: string;
      event_name: string;
      stage: string | null;
      entity_type: string | null;
      entity_id: string | null;
      payload: unknown;
      error: string;
      failed_at: Date;
      replayed_at: Date | null;
    }

    /**
     * The harvested rows for exactly these jobs, oldest first.
     *
     * Selected BY ID rather than wholesale: the appliance under this test may
     * be failing jobs of its own while the suite runs, and a `SELECT *` would
     * make the assertions depend on that.
     *
     * `QueryRunner.query` is untyped (`Promise<any>`), so the row shape is
     * asserted here once instead of at every call site.
     */
    async function lettersFor(ids: string[]): Promise<LetterRow[]> {
      const rows: unknown = await runner.query(
        `SELECT * FROM ci.pipeline_dead_letters WHERE id = ANY($1::uuid[]) ORDER BY failed_at`,
        [ids],
      );

      return rows as LetterRow[];
    }

    it('persists an exhausted job with its queue, event name, payload and error intact', async () => {
      // Nested, unicode, quotes, backslashes, an empty array and an explicit
      // null: replay re-emits this object, so anything the copy normalises away
      // is data the appliance no longer has.
      const payload = {
        name: 'file.ingested',
        userId: '00000000-0000-4000-8000-00000000aaaa',
        source: { kind: 'gdrive', path: 'trips/Ísland "2019"\\raw', tags: [], parent: null },
        attempts: [1, 2, 3],
        flags: { retryable: false, size: 10_485_760 },
      };
      const id = await seedDeadLetter({
        data: payload,
        output: {
          message: 'ENOENT: no such file or directory',
          stack: 'Error: ENOENT\n    at open (fs.js:1:1)',
        },
      });

      await expect(listener.reap()).resolves.toBeGreaterThanOrEqual(1);

      const [letter] = await lettersFor([id]);
      expect(letter).toBeDefined();
      expect(letter.queue).toBe(DEAD_LETTER_QUEUE);
      expect(letter.event_name).toBe('file.ingested');
      // Verbatim: not wrapped in an envelope, not enriched, not pruned.
      expect(letter.payload).toEqual(payload);
      expect(letter.error).toContain('ENOENT: no such file or directory');
      expect(letter.error).toContain('at open (fs.js:1:1)');
    });

    it('starts every letter unreplayed', async () => {
      // `replayed_at IS NULL` is the replay queue's partial index and the
      // idempotency flag that makes "replay all" safe to run twice. A letter
      // born with a timestamp would never be replayed at all.
      const id = await seedDeadLetter({ data: { name: 'file.ingested' } });

      await listener.reap();

      const [letter] = await lettersFor([id]);
      expect(letter.replayed_at).toBeNull();
    });

    it('keeps the pipeline provenance, so "why did THIS record fail?" is answerable', async () => {
      const entityId = randomUUID();
      const id = await seedDeadLetter({
        data: {
          name: 'pipeline.slice',
          stage: 'enrich.media_dimensions',
          entityType: 'file',
          entityId,
          userId: '00000000-0000-4000-8000-00000000aaaa',
        },
        output: { message: 'sharp: unsupported image format' },
      });

      await listener.reap();

      const [letter] = await lettersFor([id]);
      expect(letter.stage).toBe('enrich.media_dimensions');
      expect(letter.entity_type).toBe('file');
      expect(letter.entity_id).toBe(entityId);
    });

    it('records a job with no pipeline provenance rather than dropping it', async () => {
      // Most of the bus is not the pipeline. An ordinary job that dies is still
      // a failure worth keeping, with three null columns and nothing else lost.
      const id = await seedDeadLetter({
        data: { name: 'geocode.place', placeId: 'ChIJ-not-a-uuid', attempt: 3 },
        output: { message: 'nominatim 429' },
      });

      await listener.reap();

      const [letter] = await lettersFor([id]);
      expect(letter).toBeDefined();
      expect(letter.event_name).toBe('geocode.place');
      expect(letter.stage).toBeNull();
      expect(letter.entity_type).toBeNull();
      expect(letter.entity_id).toBeNull();
      expect(letter.payload).toEqual({ name: 'geocode.place', placeId: 'ChIJ-not-a-uuid', attempt: 3 });
    });

    it.each([
      ['no name key', { queue: 'etl', rows: 12 }],
      ['an empty name', { name: '', rows: 12 }],
    ])('attributes a job with %s to "unknown" instead of skipping it', async (_label, data) => {
      // Jobs inserted by something other than EventService carry no name. An
      // unattributable failure is still a failure.
      const id = await seedDeadLetter({ data, output: { message: 'boom' } });

      await listener.reap();

      const [letter] = await lettersFor([id]);
      expect(letter).toBeDefined();
      expect(letter.event_name).toBe('unknown');
      expect(letter.payload).toEqual(data);
    });

    it.each([
      ['a bare string', 'this is not an object'],
      ['an array', [1, 2, 3]],
      ['a json null', null],
      ['a number', 42],
    ])('records a payload that is %s, because malformed evidence is still evidence', async (_label, data) => {
      const id = await seedDeadLetter({ data, output: { message: 'malformed job data' } });

      await listener.reap();

      const [letter] = await lettersFor([id]);
      expect(letter).toBeDefined();
      expect(letter.payload).toEqual(data);
      expect(letter.event_name).toBe('unknown');
      expect(letter.stage).toBeNull();
      expect(letter.entity_id).toBeNull();
    });

    it('records a job carrying no data at all', async () => {
      // `payload` is NOT NULL, so the copy COALESCEs to `{}`. Dropping the job
      // instead would lose the one thing left about it: that it existed and died.
      const id = await seedDeadLetter({ output: { message: 'no data on this job' } });

      await listener.reap();

      const [letter] = await lettersFor([id]);
      expect(letter).toBeDefined();
      expect(letter.payload).toEqual({});
      expect(letter.event_name).toBe('unknown');
    });

    it('nulls an unparseable entity id without aborting the rest of the batch', async () => {
      // THE failure mode this cast guards: an unconditional `::uuid` would
      // abort the whole statement over one malformed payload — and the
      // malformed payloads are the ones most worth keeping. The neighbours
      // must survive it.
      const before = await seedDeadLetter({
        data: { name: 'pipeline.slice', stage: 'enrich.media_dimensions', entityId: randomUUID() },
      });
      const malformed = await seedDeadLetter({
        data: {
          name: 'pipeline.slice',
          stage: 'enrich.media_dimensions',
          entityType: 'file',
          entityId: 'file_2f7a-NOT-a-uuid',
        },
      });
      const after = await seedDeadLetter({
        data: { name: 'pipeline.slice', stage: 'enrich.media_dimensions', entityId: randomUUID() },
      });

      await listener.reap();

      const letters = await lettersFor([before, malformed, after]);
      expect(letters).toHaveLength(3);

      const broken = letters.find((letter) => letter.id === malformed);
      expect(broken?.entity_id).toBeNull();
      // The provenance that WAS parseable is kept, and so is the raw value.
      expect(broken?.stage).toBe('enrich.media_dimensions');
      expect(broken?.entity_type).toBe('file');
      expect(broken?.payload).toEqual(expect.objectContaining({ entityId: 'file_2f7a-NOT-a-uuid' }));
    });

    it('falls back through the error shapes rather than losing the failure', async () => {
      const structured = await seedDeadLetter({ data: { name: 'a' }, output: { message: 'plain message' } });
      const unstructured = await seedDeadLetter({
        data: { name: 'b' },
        output: { code: 500, detail: 'gateway' },
      });
      const silent = await seedDeadLetter({ data: { name: 'c' } });

      await listener.reap();

      const [first, second, third] = await lettersFor([structured, unstructured, silent]);
      // A message with no stack must not gain a trailing newline: this string
      // is what an operator reads in the list.
      expect(first.error).toBe('plain message');
      // No `message` key: keep the raw output instead of inventing one.
      expect(second.error).toContain('500');
      expect(second.error).toContain('gateway');
      // Nothing recorded at all — still a row, still says why there is no why.
      expect(third.error).toBe('pg-boss job exhausted its retries with no recorded output');
    });

    it('stamps failed_at from the job’s own created_on, not from reap time', async () => {
      // The reap runs on a two-minute cron; using `now()` would date every
      // letter to the tick that noticed it and make "when did this start
      // failing?" unanswerable.
      const id = await seedDeadLetter({ data: { name: 'file.ingested' } });
      const seeded = (await runner.query(
        `SELECT created_on FROM pgboss.job WHERE id = $1::uuid AND name = $2`,
        [id, DEAD_LETTER_QUEUE],
      )) as Array<{ created_on: Date }>;
      const createdOn = seeded[0].created_on;

      await listener.reap();

      const [letter] = await lettersFor([id]);
      expect(new Date(letter.failed_at).toISOString()).toBe(new Date(createdOn).toISOString());
    });

    it('keys the letter by the originating job id, so a second reap copies nothing twice', async () => {
      const id = await seedDeadLetter({ data: { name: 'file.ingested' }, output: { message: 'first' } });

      const first = await listener.reap();
      // Bounded to one so the count is about THIS letter: the seeded row is the
      // oldest candidate there is, so a second copy of it would be the row this
      // reap returns.
      const second = await listener.reap(1);

      expect(first).toBeGreaterThanOrEqual(1);
      expect(second).toBe(0);
      // The id IS the pg-boss job id: the natural idempotency key (the anti-join
      // skips it, `ON CONFLICT (id) DO NOTHING` closes the race between two
      // concurrent reaps), and the handle that correlates back to `pgboss.job`.
      expect(await lettersFor([id])).toHaveLength(1);
    });

    it('takes the oldest first and stops at the limit, leaving the rest for the next tick', async () => {
      const oldest = await seedDeadLetter({ data: { name: 'first' } });
      const middle = await seedDeadLetter({ data: { name: 'second' } });
      const newest = await seedDeadLetter({ data: { name: 'third' } });

      await expect(listener.reap(2)).resolves.toBe(2);

      expect((await lettersFor([oldest, middle, newest])).map((letter) => letter.id)).toEqual([
        oldest,
        middle,
      ]);

      // The leftover is taken on the next tick. Bounded to one so the count
      // cannot be moved by a letter the live appliance produced mid-test —
      // those carry `now()` and always sort behind these.
      await expect(listener.reap(1)).resolves.toBe(1);
      expect((await lettersFor([oldest, middle, newest])).map((letter) => letter.id)).toEqual([
        oldest,
        middle,
        newest,
      ]);
    });

    it('leaves pg-boss’s own row exactly where it found it', async () => {
      const id = await seedDeadLetter({ data: { name: 'file.ingested' }, output: { message: 'boom' } });

      await listener.reap();

      const rows = (await runner.query(
        `SELECT state::text AS state, completed_on FROM pgboss.job WHERE id = $1::uuid AND name = $2`,
        [id, DEAD_LETTER_QUEUE],
      )) as Array<{ state: string; completed_on: Date | null }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('created');
      expect(rows[0].completed_on).toBeNull();
    });
  });
});
