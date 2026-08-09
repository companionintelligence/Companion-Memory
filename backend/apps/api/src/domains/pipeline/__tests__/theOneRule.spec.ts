import { PipelineStateService } from '../services/PipelineStateService';

/**
 * THE ONE RULE — the single property this entire rebuild exists to deliver.
 *
 * Every stage in the old system encoded "has this run?" as a nullability
 * predicate on the column it writes: `location_coordinates IS NULL`,
 * `width IS NULL`, `LEFT JOIN ci_search.embeddings ... WHERE e.entity_id IS NULL`.
 * The predicate that FINDS work was the predicate that DECLARES it done, so the
 * first — worst — answer any enricher ever produced was permanent. Improving a
 * geocoder or an embedder could not repair history.
 *
 * The fix is one sweep, used everywhere, that asks the LEDGER instead:
 *
 *   SELECT s."<idCol>" AS id
 *     FROM "<schema>"."<table>" s
 *     LEFT JOIN ci.pipeline_state p
 *       ON p.entity_type = $1 AND p.entity_id = s."<idCol>" AND p.stage = $2
 *    WHERE s."<userCol>" = $3
 *      AND (<stage applicability predicate>)
 *      AND ( p.entity_id IS NULL
 *         OR p.stage_version < $4
 *         OR (p.status = 'failed' AND p.next_attempt_at <= now()) )
 *      AND ($5::uuid IS NULL OR s."<idCol>" > $5::uuid)
 *    ORDER BY s."<idCol>"
 *    LIMIT $6;
 *
 * These tests hold the sweep to that shape and to its consequences. They are
 * written against the CONTRACT, not against the implementation — if a test here
 * fails, the sweep changed meaning, and the bug the rebuild deletes is back.
 *
 * ## How the double is built
 *
 * There is no Postgres here. The fake `DataSource` recognises the sweep by its
 * `LEFT JOIN ci.pipeline_state` and evaluates THE ONE RULE in TypeScript
 * directly from the SIX bound parameters, in the contract's order. That is
 * deliberate: the assertions then cover the sweep's *semantics* (which rows come
 * back, for which ledger states) rather than a SQL string, while a separate
 * block of assertions covers the SQL text itself — specifically, that it never
 * mentions the stage's output column.
 *
 * The fixture stage is `enrich.media_dimensions` over `ci.files` (Phase 1's
 * first conversion). `SourceRow.width` is the stage's OUTPUT column, carried on
 * the fixture for exactly one reason: to prove that a row which already HAS a
 * width is still selected when the ledger says the stage has not run at the
 * current version. That is the repair the old `width IS NULL` predicate made
 * impossible.
 */

/* ===================================================================== *
 * Fixture data
 * ===================================================================== */

const USER = '00000000-0000-4000-8000-00000000aaaa';
const OTHER_USER = '00000000-0000-4000-8000-00000000bbbb';

const STAGE_ID = 'enrich.media_dimensions';
const ENTITY_TYPE = 'file';

/**
 * Ordered uuids. Canonical lowercase hex uuids compare byte-wise in Postgres and
 * lexically in JS in the SAME order, so the fake's keyset comparison (`>`) is a
 * faithful stand-in for `s."id" > $5::uuid`.
 */
function srcId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

interface SourceRow {
  id: string;
  user_id: string;
  content_type: string;
  /** The stage's OUTPUT column. Nothing in the sweep may ever read it. */
  width: number | null;
}

function imageRow(n: number, overrides: Partial<SourceRow> = {}): SourceRow {
  return { id: srcId(n), user_id: USER, content_type: 'image/jpeg', width: null, ...overrides };
}

type LedgerStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'quarantined';

interface LedgerRow {
  stageVersion: number;
  status: LedgerStatus;
  reason: string | null;
  nextAttemptAt: Date | null;
}

const LEDGER_STATUSES = new Set<string>(['pending', 'running', 'done', 'skipped', 'failed', 'quarantined']);

/**
 * The stage under sweep. `predicate` is the APPLICABILITY clause — what makes a
 * row a candidate at all (it is an image) — and is emphatically NOT a
 * done-ness check. The fake mirrors it in TypeScript below.
 */
function makeStage(version: number) {
  return {
    id: STAGE_ID,
    version,
    queue: 'pipeline-enrich-media',
    entityTypes: [ENTITY_TYPE],
    source: {
      schema: 'ci',
      table: 'files',
      idColumn: 'id',
      userColumn: 'user_id',
      predicate: "s.content_type LIKE 'image/%'",
    },
    run: jest.fn(async () => new Map()),
  };
}

/* ===================================================================== *
 * The fake DataSource: THE ONE RULE, evaluated
 * ===================================================================== */

function ledgerKey(entityType: string, entityId: string, stage: string): string {
  return `${entityType}|${entityId}|${stage}`;
}

/**
 * Evaluates the sweep from its six bound parameters, in the contract's order.
 * Any other arity is a contract violation and is reported as one — a silent
 * re-ordering of these parameters is precisely the kind of change that would
 * make the sweep quietly wrong.
 */
function evaluateOneRule(
  rows: SourceRow[],
  ledger: Map<string, LedgerRow>,
  params: unknown[],
): Array<{ id: string }> {
  if (params.length !== 6) {
    throw new Error(
      `THE ONE RULE binds exactly six parameters ` +
        `($1 entity_type, $2 stage, $3 user_id, $4 stage_version, $5 cursor, $6 limit); ` +
        `got ${params.length}: ${JSON.stringify(params)}`,
    );
  }

  const [entityType, stage, userId, stageVersion, cursor, limit] = params as [
    string,
    string,
    string,
    number,
    string | null,
    number,
  ];

  const now = Date.now();

  return (
    rows
      .filter((row) => row.user_id === userId)
      // The stage applicability predicate, mirrored: `s.content_type LIKE 'image/%'`.
      .filter((row) => row.content_type.startsWith('image/'))
      .filter((row) => {
        const entry = ledger.get(ledgerKey(entityType, row.id, stage));

        // p.entity_id IS NULL — never processed.
        if (entry === undefined) {
          return true;
        }

        // p.stage_version < $4 — the enricher improved since this row was done.
        if (entry.stageVersion < stageVersion) {
          return true;
        }

        // (p.status = 'failed' AND p.next_attempt_at <= now()) — retry is due.
        // A NULL next_attempt_at makes the comparison NULL, i.e. NOT selected.
        return (
          entry.status === 'failed' && entry.nextAttemptAt !== null && entry.nextAttemptAt.getTime() <= now
        );
      })
      .filter((row) => cursor == null || row.id > cursor)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit)
      .map((row) => ({ id: row.id }))
  );
}

/**
 * Applies a ledger WRITE to the simulated ledger without parsing SQL.
 *
 * Every plausible shape of the upsert binds, per row, an entity id and a status;
 * whether they arrive row-major (`VALUES (...), (...)`) or column-major
 * (`unnest($1::uuid[], $2::text[])`), zipping ids to statuses positionally gives
 * the same pairing. When a statement carries a single INLINE status literal
 * instead (as a uniform `claim()` naturally would) it applies to every id.
 *
 * The version is supplied by the caller rather than guessed, because a real
 * upsert binds several integers (backoff base, backoff cap, attempt budget)
 * and only one of them is the stage version. It is still an assertion: the
 * expected version must actually appear among the bound parameters, or the
 * write did not stamp the version the sweep is about to test against.
 *
 * This exists so ONE test can drive the round trip through the real
 * `complete()` rather than hand-seeding its result. Everything else seeds the
 * ledger directly, so a change in the write statement's shape cannot take the
 * whole file down with it.
 */
function applyWrite(
  ledger: Map<string, LedgerRow>,
  sql: string,
  params: unknown[],
  sourceIds: Set<string>,
  expectedVersion: number,
) {
  const flat = params.flat();

  const ids = flat.filter((p): p is string => typeof p === 'string' && sourceIds.has(p));
  if (ids.length === 0) {
    return;
  }

  let statuses = flat.filter((p): p is string => typeof p === 'string' && LEDGER_STATUSES.has(p));
  if (statuses.length === 0) {
    const inline = [...sql.matchAll(/'(pending|running|done|skipped|failed|quarantined)'/gi)].map((m) =>
      m[1].toLowerCase(),
    );
    const distinct = [...new Set(inline)];
    if (distinct.length !== 1) {
      throw new Error(
        `Ledger write simulator could not determine a status for ${ids.length} id(s). ` +
          `Statuses must be bound per row, or inlined as one literal. SQL: ${sql}`,
      );
    }

    statuses = ids.map(() => distinct[0]);
  }

  if (!flat.includes(expectedVersion)) {
    throw new Error(
      `The ledger write did not bind the stage version (${expectedVersion}); a row stamped with any ` +
        `other version either never comes back or never stops coming back. Bound: ${JSON.stringify(flat)}`,
    );
  }

  ids.forEach((entityId, index) => {
    ledger.set(ledgerKey(ENTITY_TYPE, entityId, STAGE_ID), {
      stageVersion: expectedVersion,
      status: (statuses[index] ?? statuses[0]) as LedgerStatus,
      reason: null,
      // The simulator cannot know the retry gate the service computed; the
      // round-trip test therefore only asserts over done/skipped outcomes.
      nextAttemptAt: null,
    });
  });
}

function makeHarness(rows: SourceRow[]) {
  const ledger = new Map<string, LedgerRow>();
  const sourceIds = new Set(rows.map((row) => row.id));
  const sweeps: Array<{ sql: string; params: unknown[] }> = [];
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  /** The version the next ledger write is expected to stamp. */
  let writeVersion = 1;

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();

    // The sweep is the only statement that LEFT JOINs the ledger onto a source.
    if (/left\s+join\s+ci\.pipeline_state/i.test(sql)) {
      sweeps.push({ sql, params: params ?? [] });

      return evaluateOneRule(rows, ledger, params ?? []);
    }

    if (/ci\.pipeline_state/i.test(sql) && !/^select/i.test(sql)) {
      writes.push({ sql, params: params ?? [] });
      applyWrite(ledger, sql, params ?? [], sourceIds, writeVersion);

      return [];
    }

    return [];
  });

  // A ledger write may be committed through the DataSource, its manager, a
  // transaction callback or a query runner; all of them land on the same `query`.
  const manager = { query };
  const dataSource = {
    query,
    manager,
    getRepository: jest.fn(() => ({ manager })),
    transaction: jest.fn(async (a: unknown, b?: unknown) =>
      typeof a === 'function'
        ? (a as (m: typeof manager) => Promise<unknown>)(manager)
        : (b as (m: typeof manager) => Promise<unknown>)(manager),
    ),
    createQueryRunner: jest.fn(() => ({
      connect: jest.fn(async () => undefined),
      startTransaction: jest.fn(async () => undefined),
      commitTransaction: jest.fn(async () => undefined),
      rollbackTransaction: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
      query,
      manager,
    })),
  };

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const service = new PipelineStateService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dataSource as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  /** Seed a ledger cell — the observable result of a previous run of the stage. */
  function seed(entityId: string, row: LedgerRow) {
    ledger.set(ledgerKey(ENTITY_TYPE, entityId, STAGE_ID), row);
  }

  return {
    service,
    ledger,
    sweeps,
    writes,
    query,
    seed,
    /** Tell the write simulator which stage version the next write must stamp. */
    expectWriteVersion: (version: number) => {
      writeVersion = version;
    },
    markDone: (entityId: string, stageVersion: number) =>
      seed(entityId, { stageVersion, status: 'done', reason: null, nextAttemptAt: null }),
    markSkipped: (entityId: string, stageVersion: number, reason: string) =>
      seed(entityId, { stageVersion, status: 'skipped', reason, nextAttemptAt: null }),
    markFailed: (entityId: string, stageVersion: number, nextAttemptAt: Date | null) =>
      seed(entityId, { stageVersion, status: 'failed', reason: 'probe_failed', nextAttemptAt }),
    markRunning: (entityId: string, stageVersion: number) =>
      seed(entityId, { stageVersion, status: 'running', reason: null, nextAttemptAt: null }),
    markQuarantined: (entityId: string, stageVersion: number) =>
      seed(entityId, { stageVersion, status: 'quarantined', reason: 'out_of_attempts', nextAttemptAt: null }),
  };
}

/** Table references in a statement, normalised (`"ci"."files"` → `ci.files`). */
function tablesIn(sql: string): string[] {
  return [...sql.matchAll(/\b(?:from|join)\s+("?\w+"?\."?\w+"?)/gi)].map((m) =>
    m[1].replace(/"/g, '').toLowerCase(),
  );
}

const V1 = 1;
const V2 = 2;
const NO_CURSOR = null;

describe('THE ONE RULE', () => {
  describe('1 — a row with no ledger entry is selected', () => {
    it('selects an entity the stage has never touched', async () => {
      const h = makeHarness([imageRow(1), imageRow(2)]);

      const ids = await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([srcId(1), srcId(2)]);
    });

    it('selects a row whose OUTPUT column is already populated — the repair the old ratchet blocked', async () => {
      // Under `width IS NULL` this row was invisible forever, so a better probe
      // could never revisit it. Under the ledger it is a candidate like any other.
      const h = makeHarness([imageRow(1, { width: 1024 })]);

      const ids = await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([srcId(1)]);
    });

    it('does not cross the user boundary', async () => {
      const h = makeHarness([imageRow(1), imageRow(2, { user_id: OTHER_USER })]);

      const ids = await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([srcId(1)]);
    });

    it('honours the stage applicability predicate, which is not a done-ness check', async () => {
      const h = makeHarness([imageRow(1), imageRow(2, { content_type: 'application/pdf' })]);

      const ids = await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([srcId(1)]);
    });
  });

  describe('2 — a row completed at version N is not selected at version N', () => {
    it('excludes a done row at the same version', async () => {
      const h = makeHarness([imageRow(1), imageRow(2)]);
      h.markDone(srcId(1), V1);

      const ids = await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([srcId(2)]);
    });

    it('excludes a row a worker has claimed (status running), so two workers cannot both take it', async () => {
      const h = makeHarness([imageRow(1), imageRow(2)]);
      h.markRunning(srcId(1), V1);

      const ids = await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([srcId(2)]);
    });

    it('still selects a row left running at an OLDER version — a killed worker cannot strand it', async () => {
      // The corollary of the rule above, and the reason a claim must not stamp
      // the current version: a worker that is SIGKILLed between claim and
      // complete leaves a `running` row behind. If that row sat at the current
      // version it would match none of the three arms — not missing, not
      // stale, not failed — and no sweep would ever return it again.
      const h = makeHarness([imageRow(1)]);
      h.markRunning(srcId(1), 0);

      const ids = await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([srcId(1)]);
    });

    it('a second full sweep after everything is done selects nothing — the idempotent re-run', async () => {
      const h = makeHarness([imageRow(1), imageRow(2), imageRow(3)]);
      for (const n of [1, 2, 3]) {
        h.markDone(srcId(n), V1);
      }

      const ids = await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([]);
    });
  });

  describe('3 — bumping the stage version re-selects the row (THE REGRESSION TEST)', () => {
    /**
     * This is the defect the rebuild exists to delete: "improving an enricher
     * cannot repair history". Bumping STAGE_VERSIONS is the ONLY re-processing
     * lever, and it must reach rows that already succeeded.
     */
    it('re-selects a done row once the stage version is bumped to N+1', async () => {
      const h = makeHarness([imageRow(1)]);
      h.markDone(srcId(1), V1);

      await expect(h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10)).resolves.toEqual([]);
      await expect(h.service.selectStale(makeStage(V2) as never, USER, NO_CURSOR, 10)).resolves.toEqual([
        srcId(1),
      ]);
    });

    it('re-selects skipped rows on a bump too — a wrong skip is as repairable as a wrong answer', async () => {
      const h = makeHarness([imageRow(1)]);
      h.markSkipped(srcId(1), V1, 'probe_unsupported_codec');

      await expect(h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10)).resolves.toEqual([]);
      await expect(h.service.selectStale(makeStage(V2) as never, USER, NO_CURSOR, 10)).resolves.toEqual([
        srcId(1),
      ]);
    });

    it('re-selects the WHOLE eligible corpus on a bump, exactly once each', async () => {
      const h = makeHarness([imageRow(1), imageRow(2), imageRow(3)]);
      for (const n of [1, 2, 3]) {
        h.markDone(srcId(n), V1);
      }

      const ids = await h.service.selectStale(makeStage(V2) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([srcId(1), srcId(2), srcId(3)]);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('binds the stage version from the stage itself, so the bump is the whole mechanism', async () => {
      const h = makeHarness([imageRow(1)]);

      await h.service.selectStale(makeStage(7) as never, USER, NO_CURSOR, 10);

      expect(h.sweeps).toHaveLength(1);
      expect(h.sweeps[0].params[3]).toBe(7);
    });

    it('a row already at the NEW version is not re-selected — one bump, one pass', async () => {
      const h = makeHarness([imageRow(1)]);
      h.markDone(srcId(1), V2);

      const ids = await h.service.selectStale(makeStage(V2) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([]);
    });
  });

  describe('4 — a skipped row with a reason is not re-selected at the same version', () => {
    it('excludes a skipped row', async () => {
      // The bug this deletes: a permanently unresolvable row (ZERO_RESULTS, an
      // unsupported codec) re-qualified on EVERY run and burned a slot in the
      // budget forever, because "skipped" had nowhere to live.
      const h = makeHarness([imageRow(1), imageRow(2)]);
      h.markSkipped(srcId(1), V1, 'probe_failed');

      const ids = await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([srcId(2)]);
    });

    it('excludes a quarantined row at the same version — it needs a human, not a sweep', async () => {
      const h = makeHarness([imageRow(1), imageRow(2)]);
      h.markQuarantined(srcId(1), V1);

      const ids = await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([srcId(2)]);
    });
  });

  describe('5 — a failed row returns only once its retry is due', () => {
    it('does not re-select a failed row whose next_attempt_at is in the future', async () => {
      const h = makeHarness([imageRow(1)]);
      h.markFailed(srcId(1), V1, new Date(Date.now() + 60_000));

      const ids = await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([]);
    });

    it('re-selects a failed row once next_attempt_at has passed', async () => {
      const h = makeHarness([imageRow(1)]);
      h.markFailed(srcId(1), V1, new Date(Date.now() - 1_000));

      const ids = await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([srcId(1)]);
    });

    it('leaves a failed row with no retry gate alone — NULL <= now() is NULL, not true', async () => {
      const h = makeHarness([imageRow(1)]);
      h.markFailed(srcId(1), V1, null);

      const ids = await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([]);
    });

    it('spells the retry clause out in SQL: status = failed AND next_attempt_at <= now()', async () => {
      const h = makeHarness([imageRow(1)]);

      await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      const sql = h.sweeps[0].sql.toLowerCase();
      expect(sql).toContain("p.status = 'failed'");
      expect(sql).toMatch(/p\.next_attempt_at\s*<=\s*now\(\)/);
      // The retry gate is read from the row, not from an in-process timer, so
      // backoff survives a restart.
      expect(sql).not.toMatch(/next_attempt_at\s*<=\s*\$/);
    });
  });

  describe('6 — selection never consults the target column', () => {
    /**
     * The whole bug in one assertion. If the sweep ever mentions the column the
     * stage WRITES, the ratchet is back: the first answer becomes permanent and
     * a version bump repairs nothing.
     */
    it('emits no IS NULL predicate other than the ledger anti-join and the cursor guard', async () => {
      const h = makeHarness([imageRow(1)]);

      await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      const sql = h.sweeps[0].sql;
      const isNullPredicates = [...sql.matchAll(/([\w."$:]+)\s+is\s+null/gi)].map((m) =>
        m[1].replace(/"/g, '').toLowerCase(),
      );

      expect(isNullPredicates.length).toBeGreaterThan(0);
      for (const subject of isNullPredicates) {
        // p.entity_id IS NULL  = "never processed" (the ledger anti-join)
        // $5::uuid IS NULL     = "no cursor yet"   (the keyset guard)
        expect(['p.entity_id', '$5::uuid', '$5']).toContain(subject);
      }
    });

    it('never names the stage output columns at all', async () => {
      const h = makeHarness([imageRow(1)]);

      await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      const sql = h.sweeps[0].sql.toLowerCase();
      expect(sql).not.toMatch(/\bwidth\b/);
      expect(sql).not.toMatch(/\bheight\b/);
    });

    it('reads exactly two tables: the source and the ledger', async () => {
      const h = makeHarness([imageRow(1)]);

      await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      // No anti-join against an output table either (the search-index sweep's
      // `LEFT JOIN ci_search.embeddings ... WHERE e.entity_id IS NULL` was the
      // same ratchet wearing a different hat).
      expect(new Set(tablesIn(h.sweeps[0].sql))).toEqual(new Set(['ci.files', 'ci.pipeline_state']));
    });

    it('joins the ledger on the full key and tests staleness against the version', async () => {
      const h = makeHarness([imageRow(1)]);

      await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      const sql = h.sweeps[0].sql.toLowerCase();
      expect(sql).toContain('p.entity_type = $1');
      expect(sql).toContain('p.stage = $2');
      expect(sql).toMatch(/p\.stage_version\s*<\s*\$4/);
      expect(sql).toContain(makeStage(V1).source.predicate.toLowerCase());
    });
  });

  describe('7 — keyset pagination', () => {
    it('returns strictly greater ids when the last id is passed back as the cursor', async () => {
      const h = makeHarness([imageRow(1), imageRow(2), imageRow(3), imageRow(4)]);

      const page = await h.service.selectStale(makeStage(V1) as never, USER, srcId(2), 10);

      expect(page).toEqual([srcId(3), srcId(4)]);
      for (const id of page) {
        expect(id > srcId(2)).toBe(true);
      }
    });

    it('orders by the id so a cursor can advance monotonically', async () => {
      const h = makeHarness([imageRow(3), imageRow(1), imageRow(2)]);

      const ids = await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      expect(ids).toEqual([srcId(1), srcId(2), srcId(3)]);
      expect(h.sweeps[0].sql.toLowerCase()).toMatch(/order by\s+s\."?id"?/);
    });

    it('respects the limit as the page size', async () => {
      const h = makeHarness([imageRow(1), imageRow(2), imageRow(3)]);

      const ids = await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 2);

      expect(ids).toEqual([srcId(1), srcId(2)]);
      expect(h.sweeps[0].params[5]).toBe(2);
    });

    it('pages through the whole candidate set exactly once, with no repeats and no gaps', async () => {
      const rows = Array.from({ length: 7 }, (_, i) => imageRow(i + 1));
      // One non-candidate and one other user's row, to prove paging cannot drag
      // them in and cannot lose its place stepping over them.
      rows.push(imageRow(8, { content_type: 'application/pdf' }), imageRow(9, { user_id: OTHER_USER }));
      const h = makeHarness(rows);
      const stage = makeStage(V1);

      const seen: string[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page: string[] = await h.service.selectStale(stage as never, USER, cursor, 3);
        seen.push(...page);
        if (page.length < 3) {
          break;
        }

        cursor = page[page.length - 1];
      }

      expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7].map(srcId));
      expect(new Set(seen).size).toBe(seen.length);
      // page(3) + page(3) + page(1) — the short page ends the loop.
      expect(h.sweeps.map((s) => s.params[4])).toEqual([null, srcId(3), srcId(6)]);
    });

    it('binds a null cursor as SQL NULL, never undefined', async () => {
      const h = makeHarness([imageRow(1)]);

      await h.service.selectStale(makeStage(V1) as never, USER, NO_CURSOR, 10);

      expect(h.sweeps[0].params[4]).toBeNull();
    });
  });

  describe('round trip: complete() then sweep', () => {
    /**
     * The only test that drives a ledger WRITE through the service instead of
     * seeding the cell. It closes the loop the other tests assume: what
     * `complete()` persists is exactly what the sweep then excludes, and a
     * version bump gets it back.
     */
    it('completing at version N excludes the row at N and re-includes it at N+1', async () => {
      const h = makeHarness([imageRow(1), imageRow(2), imageRow(3)]);
      // Deliberately not version 1: a service that stamps a frozen version
      // rather than the stage's own would still pass at 1 by coincidence.
      const stage = makeStage(6);
      h.expectWriteVersion(6);

      const ids = await h.service.selectStale(stage as never, USER, NO_CURSOR, 10);
      expect(ids).toEqual([srcId(1), srcId(2), srcId(3)]);

      await h.service.complete(
        stage as never,
        ENTITY_TYPE,
        new Map([
          [srcId(1), { outcome: 'done' as const }],
          [srcId(2), { outcome: 'skipped' as const, reason: 'not_an_image_after_probe' }],
        ]),
      );

      // Only the row nothing was recorded for is still outstanding.
      await expect(h.service.selectStale(stage as never, USER, NO_CURSOR, 10)).resolves.toEqual([srcId(3)]);

      // Bump: the completed AND the skipped row are candidates again.
      await expect(h.service.selectStale(makeStage(7) as never, USER, NO_CURSOR, 10)).resolves.toEqual([
        srcId(1),
        srcId(2),
        srcId(3),
      ]);
    });
  });
});
