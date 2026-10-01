import { SOURCE_CHANGE_GRACE_SECONDS, TRANSIENT_FAILURE_REASONS } from '../../constants';
import { PipelineStateService } from '../PipelineStateService';

/**
 * Unit tests for the ledger service — the ONLY writer of `ci.pipeline_state`.
 *
 * Five methods, one job each:
 *
 *   selectStale(stage, userId, cursor, limit) -> string[]
 *   claim(stage, entityType, ids, userId)     -> void
 *   complete(stage, entityType, results)      -> void
 *   fail(stage, entityType, ids, reason, backoff) -> void
 *   coverage(stage) -> { done, skipped, failed, pending }
 *
 * THE ONE RULE (the semantics of `selectStale` under every ledger state) has its
 * own file — `src/domains/pipeline/__tests__/theOneRule.spec.ts`. What is
 * asserted HERE is the service's side of the contract: which parameters it
 * binds, what it writes for each outcome, and that the version it stamps is the
 * stage's CURRENT version — because a write that stamps the wrong version is a
 * row that either never comes back or never stops coming back.
 *
 * No Postgres. The `DataSource` double records every statement and answers with
 * scripted rows, in the style of SearchIndexBackfillService.spec.ts.
 */

const USER = '00000000-0000-4000-8000-00000000aaaa';
const ENTITY_TYPE = 'file';
const STAGE_ID = 'enrich.media_dimensions';

function srcId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** The Stage the service is handed. Mirrors the Stage contract structurally. */
function makeStage(version = 1) {
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

type Bucket = 'done' | 'skipped' | 'failed' | 'pending';

interface HarnessOptions {
  /** Rows the sweep answers with, oldest page first. */
  pages?: Array<Array<{ id: string }>>;
  /** Bucket counts the coverage query answers with. */
  counts?: Partial<Record<Bucket, number | string>>;
  /** Whether the `hasOverdueRetry` probe answers with a hit. */
  overdueRetry?: boolean;
  /** How many rows the quarantine-release UPDATE reports having moved. */
  released?: number;
}

function makeHarness(options: HarnessOptions = {}) {
  const pages = [...(options.pages ?? [])];
  const sweeps: Array<{ sql: string; params: unknown[] }> = [];
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const coverageQueries: Array<{ sql: string; params: unknown[] }> = [];
  const retryProbes: Array<{ sql: string; params: unknown[] }> = [];
  const releases: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    const bound = params ?? [];

    if (/not\s+exists[\s\S]*ci\.pipeline_state/i.test(sql)) {
      sweeps.push({ sql, params: bound });

      return pages.shift() ?? [];
    }

    // The quarantine release: an UPDATE, not an upsert, so it is recognised
    // before the catch-all `writes` bucket swallows it.
    if (/^update\s+ci\.pipeline_state/i.test(sql)) {
      releases.push({ sql, params: bound });

      // Emulate the REAL driver shape. TypeORM's Postgres driver special-cases
      // UPDATE/DELETE and resolves `[rows, rowCount]`, never the bare rows
      // array — returning a flat array here is a shape the driver cannot
      // produce, and it is exactly what let `released` sit at a constant 2 in
      // production while this spec stayed green.
      const releasedRows = Array.from({ length: options.released ?? 0 }, (_unused, index) => ({
        entity_id: srcId(index + 1),
      }));

      return [releasedRows, releasedRows.length];
    }

    // The retry probe: `SELECT entity_id FROM ci.pipeline_state WHERE ...
    // status = 'failed' ...`. Checked before the generic `count` branch below
    // (it is a plain SELECT, not an aggregate) and before the catch-all
    // `writes` bucket, which would otherwise silently swallow it.
    if (/select\s+entity_id\s+from\s+ci\.pipeline_state/i.test(sql) && /status\s*=\s*'failed'/i.test(sql)) {
      retryProbes.push({ sql, params: bound });

      return options.overdueRetry === true ? [{ entity_id: srcId(1) }] : [];
    }

    if (/^select/i.test(sql) && /count/i.test(sql)) {
      coverageQueries.push({ sql, params: bound });
      const counts = options.counts ?? {};

      // The coverage query has two equally reasonable shapes and the contract
      // fixes only its RESULT, so answer whichever one the service asked for:
      // a GROUP BY over status, or one row of four aggregates.
      if (/group\s+by/i.test(sql)) {
        return Object.entries(counts).map(([status, count]) => ({ status, count: String(count), stale: 0 }));
      }

      return [
        {
          done: String(counts.done ?? 0),
          skipped: String(counts.skipped ?? 0),
          failed: String(counts.failed ?? 0),
          pending: String(counts.pending ?? 0),
        },
      ];
    }

    writes.push({ sql, params: bound });

    return [];
  });

  // A write may be committed through the DataSource, its manager, a transaction
  // callback or a query runner — all of them funnel into the same recorder.
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

  /** Every bound value across every write, flattened one level (array binds). */
  function writtenParams(): unknown[] {
    return writes.flatMap((w) => w.params.flat());
  }

  /** Every write statement, whitespace-collapsed and lowercased. */
  function writtenSql(): string {
    return writes
      .map((w) => w.sql)
      .join(' ; ')
      .toLowerCase();
  }

  return {
    service,
    query,
    sweeps,
    writes,
    coverageQueries,
    retryProbes,
    releases,
    writtenParams,
    writtenSql,
    logger,
  };
}

describe('PipelineStateService.selectStale', () => {
  it('binds the six sweep parameters in the contract order', async () => {
    const h = makeHarness({ pages: [[{ id: srcId(1) }]] });

    await h.service.selectStale(makeStage(4) as never, USER, srcId(9), 250);

    expect(h.sweeps).toHaveLength(1);
    expect(h.sweeps[0].params).toEqual([
      ENTITY_TYPE, // $1 entity_type
      STAGE_ID, //    $2 stage
      USER, //        $3 user_id
      4, //           $4 stage_version — from the stage, not from a config
      srcId(9), //    $5 cursor
      250, //         $6 limit
    ]);
  });

  it('returns the ids as plain strings', async () => {
    const h = makeHarness({ pages: [[{ id: srcId(1) }, { id: srcId(2) }]] });

    const ids = await h.service.selectStale(makeStage() as never, USER, null, 10);

    expect(ids).toEqual([srcId(1), srcId(2)]);
  });

  it('returns an empty array when nothing is stale, and issues exactly one statement', async () => {
    const h = makeHarness({ pages: [[]] });

    const ids = await h.service.selectStale(makeStage() as never, USER, null, 10);

    expect(ids).toEqual([]);
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('binds an absent cursor as SQL NULL so the `$5::uuid IS NULL` guard fires', async () => {
    const h = makeHarness({ pages: [[]] });

    await h.service.selectStale(makeStage() as never, USER, null, 10);

    expect(h.sweeps[0].params[4]).toBeNull();
  });
});

describe('PipelineStateService.hasOverdueRetry', () => {
  it('binds stage, entity type and user in that order, and issues exactly one statement', async () => {
    const h = makeHarness({ overdueRetry: false });

    await h.service.hasOverdueRetry(makeStage() as never, ENTITY_TYPE, USER);

    expect(h.retryProbes).toHaveLength(1);
    expect(h.retryProbes[0].params).toEqual([STAGE_ID, ENTITY_TYPE, USER]);
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('is true when a failed row past its retry gate exists', async () => {
    const h = makeHarness({ overdueRetry: true });

    await expect(h.service.hasOverdueRetry(makeStage() as never, ENTITY_TYPE, USER)).resolves.toBe(true);
  });

  it('is false when there is nothing to retry', async () => {
    const h = makeHarness({ overdueRetry: false });

    await expect(h.service.hasOverdueRetry(makeStage() as never, ENTITY_TYPE, USER)).resolves.toBe(false);
  });

  it('probes with LIMIT 1 rather than counting', async () => {
    const h = makeHarness({ overdueRetry: true });

    await h.service.hasOverdueRetry(makeStage() as never, ENTITY_TYPE, USER);

    expect(h.retryProbes[0].sql.toLowerCase()).toContain('limit 1');
  });

  it("filters on status = 'failed' and next_attempt_at <= now(), the exact pipeline_state_retry_idx shape", async () => {
    const h = makeHarness({ overdueRetry: true });

    await h.service.hasOverdueRetry(makeStage() as never, ENTITY_TYPE, USER);

    const sql = h.retryProbes[0].sql.toLowerCase();

    expect(sql).toContain("status = 'failed'");
    expect(sql).toContain('next_attempt_at <= now()');
  });
});

describe('PipelineStateService.claim', () => {
  it('marks every id running, keyed on the natural PK, and charges an attempt', async () => {
    const h = makeHarness();

    await h.service.claim(makeStage(3) as never, ENTITY_TYPE, [srcId(1), srcId(2)], USER);

    expect(h.writes.length).toBeGreaterThan(0);
    const sql = h.writtenSql();
    expect(sql).toContain('ci.pipeline_state');
    // A claim collides with the row a previous run left behind, so it must be
    // an upsert on the natural key — never a blind INSERT.
    expect(sql).toMatch(/on conflict\s*\(\s*entity_type\s*,\s*entity_id\s*,\s*stage\s*\)/);
    // `attempts` is charged here and nowhere else, so it counts genuine starts
    // and a poison record can eventually exhaust its budget.
    expect(sql).toContain('attempts');

    const params = h.writtenParams();
    expect(params).toContain(srcId(1));
    expect(params).toContain(srcId(2));
    expect(params).toContain(ENTITY_TYPE);
    expect(params).toContain(STAGE_ID);
    // Denormalised so sweeps, dashboards and reapers can filter by user without
    // joining back to the entity's own table.
    expect(params).toContain(USER);
    expect(`${sql} ${JSON.stringify(params)}`).toContain('running');
  });

  it('deduplicates ids, because ON CONFLICT cannot touch a row twice in one statement', async () => {
    // Postgres aborts the whole statement with "cannot affect row a second
    // time", so a duplicated id would fail the entire claim rather than being
    // harmlessly idempotent.
    const h = makeHarness();

    await h.service.claim(makeStage() as never, ENTITY_TYPE, [srcId(1), srcId(1), srcId(2)], USER);

    const ids = h.writtenParams().filter((p) => p === srcId(1));
    expect(ids).toHaveLength(1);
  });

  it('is a no-op for an empty id list', async () => {
    const h = makeHarness();

    await h.service.claim(makeStage() as never, ENTITY_TYPE, [], USER);

    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('PipelineStateService.complete', () => {
  it('persists every result, with its outcome, at the stage current version', async () => {
    const h = makeHarness();

    await h.service.complete(
      makeStage(5) as never,
      ENTITY_TYPE,
      new Map([
        [srcId(1), { outcome: 'done' as const }],
        [srcId(2), { outcome: 'skipped' as const, reason: 'unsupported_codec' }],
        [srcId(3), { outcome: 'failed' as const, reason: 'minio_timeout' }],
      ]),
    );

    const params = h.writtenParams();
    const blob = `${h.writtenSql()} ${JSON.stringify(params)}`;

    for (const n of [1, 2, 3]) {
      expect(params).toContain(srcId(n));
    }

    for (const status of ['done', 'skipped', 'failed']) {
      expect(blob).toContain(status);
    }

    // The stamped version IS the re-processing mechanism: stamp the wrong one
    // and the row either never comes back or never stops coming back.
    expect(params).toContain(5);
  });

  it('keeps the reason for skipped and failed outcomes', async () => {
    const h = makeHarness();

    await h.service.complete(
      makeStage() as never,
      ENTITY_TYPE,
      new Map([
        [srcId(1), { outcome: 'skipped' as const, reason: 'virtual_location' }],
        [srcId(2), { outcome: 'failed' as const, reason: 'provider_5xx' }],
      ]),
    );

    const params = h.writtenParams();
    expect(params).toContain('virtual_location');
    expect(params).toContain('provider_5xx');
  });

  it('upserts on the natural key, so a completion overwrites the claim it replaces', async () => {
    const h = makeHarness();

    await h.service.complete(
      makeStage() as never,
      ENTITY_TYPE,
      new Map([[srcId(1), { outcome: 'done' as const }]]),
    );

    expect(h.writtenSql()).toMatch(/on conflict\s*\(\s*entity_type\s*,\s*entity_id\s*,\s*stage\s*\)/);
  });

  it('is a no-op for an empty result map', async () => {
    const h = makeHarness();

    await h.service.complete(makeStage() as never, ENTITY_TYPE, new Map());

    expect(h.query).not.toHaveBeenCalled();
  });

  it('never records a skipped row without a reason', async () => {
    // `reason` is REQUIRED by convention for skipped/failed — it is the fix for
    // the ~30 `catch { log; continue }` blocks that made silent loss look like
    // success. The SQL deliberately carries no CHECK (an error path must never
    // be blocked by a constraint), so the service is the enforcement point.
    //
    // Two readings are defensible and BOTH pass here: reject the call, or
    // substitute an explicit placeholder reason. What must not happen is a
    // skipped row landing with a NULL reason.
    const h = makeHarness();
    let rejected = false;

    await h.service
      .complete(
        makeStage() as never,
        ENTITY_TYPE,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new Map([[srcId(1), { outcome: 'skipped' } as any]]),
      )
      .catch(() => {
        rejected = true;
      });

    if (rejected) {
      expect(h.writes).toHaveLength(0);

      return;
    }

    const structural: unknown[] = [srcId(1), ENTITY_TYPE, STAGE_ID, USER, 'skipped', 1];
    const substituted = h
      .writtenParams()
      .some((p) => typeof p === 'string' && p.length > 0 && !structural.includes(p));
    expect(substituted).toBe(true);
  });
});

describe('PipelineStateService.fail', () => {
  it('records the failure with its reason and schedules the retry gate', async () => {
    const h = makeHarness();

    await h.service.fail(
      makeStage(2) as never,
      ENTITY_TYPE,
      [srcId(1), srcId(2)],
      'ollama_unreachable',
      30_000,
    );

    const sql = h.writtenSql();
    const params = h.writtenParams();

    expect(sql).toContain('ci.pipeline_state');
    expect(sql).toContain('next_attempt_at');
    expect(`${sql} ${JSON.stringify(params)}`).toContain('failed');
    expect(params).toContain('ollama_unreachable');
    expect(params).toContain(srcId(1));
    expect(params).toContain(srcId(2));
    // A dead Ollama must read as a rising failure count, not a flat counter,
    // so attempts is carried forward rather than reset.
    expect(sql).toContain('attempts');
  });

  it('lets the backoff argument reach the database', async () => {
    // The contract fixes the ARGUMENT, not the encoding — a bound timestamp, a
    // bound second count and a `now() + make_interval(...)` are all legitimate.
    // What is not legitimate is ignoring it: two calls that differ only in
    // backoff must produce two different statements.
    const short = makeHarness();
    await short.service.fail(makeStage() as never, ENTITY_TYPE, [srcId(1)], 'boom', 1_000);

    const long = makeHarness();
    await long.service.fail(makeStage() as never, ENTITY_TYPE, [srcId(1)], 'boom', 3_600_000);

    const render = (h: ReturnType<typeof makeHarness>) =>
      JSON.stringify(h.writes.map((w) => [w.sql, w.params]));

    expect(render(short)).not.toEqual(render(long));
  });

  it('refuses to record a failure with no reason', async () => {
    // A failure with no recorded reason is the defect the ledger exists to
    // remove: three months later it is indistinguishable from work that was
    // never attempted.
    const h = makeHarness();

    await expect(
      h.service.fail(makeStage() as never, ENTITY_TYPE, [srcId(1)], '   ', 1_000),
    ).rejects.toThrow();
    expect(h.writes).toHaveLength(0);
  });

  it('is a no-op for an empty id list', async () => {
    const h = makeHarness();

    await h.service.fail(makeStage() as never, ENTITY_TYPE, [], 'boom', 1_000);

    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('PipelineStateService.releaseQuarantined', () => {
  // The recovery half of the transient-failure fix. Quarantine's only other
  // exit is a stage-version bump, which re-opens the WHOLE corpus — on a
  // metered stage, a bill for every row in the table in order to retry a few
  // thousand. What the semantics of a release ARE (status, counters, gate) is
  // asserted against a real database in `pipeline.integration.spec.ts`; what
  // this file owns is the selector, the scoping and the defaults.

  it('defaults to the declared transient reasons — the set that can no longer quarantine', async () => {
    const h = makeHarness({ released: 12_237 });

    const result = await h.service.releaseQuarantined(USER);

    expect(result.released).toBe(12_237);
    expect([...result.reasons].sort()).toEqual([...TRANSIENT_FAILURE_REASONS].sort());
    expect(result.stage).toBeNull();

    expect(h.releases).toHaveLength(1);
    expect(h.releases[0].params[0]).toBe(USER);
    expect(h.releases[0].params[1]).toEqual([...TRANSIENT_FAILURE_REASONS]);
  });

  it('only ever touches quarantined rows', async () => {
    const h = makeHarness({ released: 1 });

    await h.service.releaseQuarantined(USER);

    // A release that could also re-open `done` or `skipped` rows would be a
    // corpus-wide re-run wearing a maintenance route's clothes.
    expect(h.releases[0].sql.toLowerCase()).toContain("status = 'quarantined'");
  });

  it('is scoped by user in SQL, not filtered afterwards', async () => {
    const h = makeHarness({ released: 3 });

    await h.service.releaseQuarantined(USER, { reasons: ['provider_unavailable'] });

    expect(h.releases[0].sql.toLowerCase()).toContain('user_id = $1::uuid');
  });

  it('restores the attempt budget, so the retry starts from a full five', async () => {
    const h = makeHarness({ released: 1 });

    await h.service.releaseQuarantined(USER);

    const sql = h.releases[0].sql.toLowerCase().replace(/\s+/g, ' ');

    // Releasing without resetting the counter hands the row back with its
    // budget already spent: the very next failure re-quarantines it, and the
    // operator concludes the route does not work.
    expect(sql).toContain('attempts = 0');
    expect(sql).toContain('transient_attempts = 0');
    expect(sql).toContain('next_attempt_at = now()');
  });

  it('passes an explicit reason list and stage filter through', async () => {
    const h = makeHarness({ released: 2 });

    const result = await h.service.releaseQuarantined(USER, {
      reasons: ['stage_threw: connect ECONNREFUSED 127.0.0.1:11434'],
      stage: 'index.embed',
    });

    expect(result.stage).toBe('index.embed');
    expect(h.releases[0].params[1]).toEqual(['stage_threw: connect ECONNREFUSED 127.0.0.1:11434']);
    expect(h.releases[0].params[2]).toBe('index.embed');
  });

  it('deduplicates reasons, because an ANY() array with repeats is just noise', async () => {
    const h = makeHarness({ released: 1 });

    await h.service.releaseQuarantined(USER, {
      reasons: ['provider_unavailable', 'provider_unavailable'],
    });

    expect(h.releases[0].params[1]).toEqual(['provider_unavailable']);
  });

  it('issues no statement at all for an empty selector, rather than releasing everything', async () => {
    // An empty list is the caller trying to name reasons and naming none. The
    // one thing it must never mean is "every quarantined row", which is the
    // operation that re-runs whatever is actually broken across the ledger.
    const h = makeHarness({ released: 999 });

    const result = await h.service.releaseQuarantined(USER, { reasons: [] });

    expect(result.released).toBe(0);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('ignores blank reasons instead of matching rows whose reason is whitespace', async () => {
    const h = makeHarness({ released: 0 });

    const result = await h.service.releaseQuarantined(USER, { reasons: ['   ', ''] });

    expect(result.released).toBe(0);
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('PipelineStateService.coverage', () => {
  // `coverage` is keyed by stage ID (it reads the version from STAGE_VERSIONS
  // itself), and reports more buckets than the four the contract fixes —
  // running, quarantined, stale and a derived ratio ride along. The assertions
  // below therefore check the contract's four are present and right, not that
  // nothing else is.
  it('returns the four contract buckets as numbers', async () => {
    const h = makeHarness({ counts: { done: 90, skipped: 4, failed: 2, pending: 8 } });

    const coverage = await h.service.coverage(STAGE_ID);

    expect(coverage).toEqual(expect.objectContaining({ done: 90, skipped: 4, failed: 2, pending: 8 }));
  });

  it('coerces Postgres counts, which may arrive as strings', async () => {
    const h = makeHarness({ counts: { done: '18800', skipped: '12', failed: '0', pending: '0' } });

    const coverage = await h.service.coverage(STAGE_ID);

    expect(coverage.done).toBe(18800);
    expect(coverage.skipped).toBe(12);
    expect(typeof coverage.done).toBe('number');
  });

  it('zero-fills buckets the query returned nothing for', async () => {
    // "Is my import finished?" must never be answered with `undefined` — the
    // absent bucket is a zero, and a zero is a fact.
    const h = makeHarness({ counts: { done: 5 } });

    const coverage = await h.service.coverage(STAGE_ID);

    expect(coverage).toEqual(expect.objectContaining({ done: 5, skipped: 0, failed: 0, pending: 0 }));
  });

  it('scopes the count to the stage', async () => {
    const h = makeHarness({ counts: { done: 1 } });

    await h.service.coverage(STAGE_ID);

    expect(h.coverageQueries).toHaveLength(1);
    const { sql, params } = h.coverageQueries[0];
    expect(sql.toLowerCase()).toContain('ci.pipeline_state');
    expect(`${sql} ${JSON.stringify(params)}`).toContain(STAGE_ID);
  });
});

describe('PipelineStateService.reopen', () => {
  /**
   * Answers the way TypeORM's Postgres driver does, not the way it is easy to
   * assume: a bare `UPDATE … RETURNING` resolves to `[rows, rowCount]`, and only
   * a statement whose OUTER command is a SELECT (a CTE-wrapped UPDATE) resolves
   * to the rows. The old mock returned rows for everything, which is how
   * `reopen()` returning a constant 2 went unnoticed — its one test happened to
   * re-open exactly two rows.
   */
  function make(returning: Array<{ entity_id: string }>) {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const query = jest.fn(async (raw: string, params: unknown[] = []) => {
      const sql = raw.replace(/\s+/g, ' ').trim();

      statements.push({ sql, params });

      return /^(UPDATE|DELETE)\b/i.test(sql) ? [returning, returning.length] : returning;
    });
    const logger = {
      setContext: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    return { service: new PipelineStateService({ query } as never, logger as never), statements };
  }

  it('sets terminal rows back to version 0 — the value a fresh claim carries — and reports how many moved', async () => {
    const { service, statements } = make([{ entity_id: srcId(1) }, { entity_id: srcId(2) }]);

    await expect(service.reopen(ENTITY_TYPE, STAGE_ID, [srcId(1), srcId(2), srcId(1)])).resolves.toBe(2);

    expect(statements).toHaveLength(1);
    const { sql, params } = statements[0];

    // Wrapped in a CTE with an outer SELECT: TypeORM resolves a bare UPDATE …
    // RETURNING to `[rows, rowCount]`, whose length is 2 however many rows
    // moved. A mock cannot see that; `sourceChangeReopen.integration.spec.ts`
    // is what caught it.
    expect(sql).toMatch(/^WITH reopened AS \( UPDATE/);
    expect(sql).toMatch(/SELECT entity_id FROM reopened$/);
    expect(sql).toMatch(/UPDATE ci\.pipeline_state ps SET stage_version = 0/);
    // Only decided rows: a running row is a live claim, a failed row has its own gate.
    expect(sql).toMatch(/ps\.status IN \('done', 'skipped'\)/);
    expect(sql).toMatch(/ps\.stage_version > 0/);
    // Deduplicated, in the contract order.
    expect(params).toEqual([ENTITY_TYPE, STAGE_ID, [srcId(1), srcId(2)]]);
  });

  it.each([0, 1, 3])(
    'reports %i when that many rows moved — the count, not the driver tuple',
    async (moved) => {
      const { service, statements } = make(
        Array.from({ length: moved }, (_, i) => ({ entity_id: srcId(i + 1) })),
      );

      await expect(service.reopen(ENTITY_TYPE, STAGE_ID, [srcId(1), srcId(2), srcId(3)])).resolves.toBe(
        moved,
      );

      // The outer command is a SELECT over the UPDATE's RETURNING, which is what
      // makes the driver hand back rows. A bare UPDATE here counts the tuple.
      expect(statements[0].sql).toMatch(/^WITH reopened AS \( UPDATE ci\.pipeline_state/);
      expect(statements[0].sql).toMatch(/\) SELECT entity_id FROM reopened$/);
    },
  );

  it('issues no statement for an empty id list', async () => {
    const { service, statements } = make([]);

    await expect(service.reopen(ENTITY_TYPE, STAGE_ID, [])).resolves.toBe(0);
    expect(statements).toHaveLength(0);
  });

  it("runs on the caller's transaction when handed one, and never on its own connection", async () => {
    // A linkage writer that is not a stage re-opens inside the transaction that
    // writes the link, so the two commit together or not at all.
    const { service, statements } = make([]);
    const managerQuery = jest.fn(async () => [{ entity_id: srcId(1) }]);

    await expect(
      service.reopen(ENTITY_TYPE, STAGE_ID, [srcId(1)], { query: managerQuery } as never),
    ).resolves.toBe(1);

    expect(managerQuery).toHaveBeenCalledTimes(1);
    expect(managerQuery.mock.calls[0]).toEqual([
      expect.stringContaining('WITH reopened AS'),
      [ENTITY_TYPE, STAGE_ID, [srcId(1)]],
    ]);
    expect(statements).toHaveLength(0);
  });
});

describe('PipelineStateService.reopenChangedSources', () => {
  /** The first statement answers `changed`; the re-open UPDATE answers what it moved. */
  function make(changed: string[]) {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const query = jest.fn(async (raw: string, params: unknown[] = []) => {
      const sql = raw.replace(/\s+/g, ' ').trim();

      statements.push({ sql, params });

      if (/UPDATE ci\.pipeline_state/.test(sql)) {
        return (params[2] as string[]).map((entity_id) => ({ entity_id }));
      }

      return changed.map((id) => ({ id }));
    });
    const logger = {
      setContext: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    return { service: new PipelineStateService({ query } as never, logger as never), statements };
  }

  function changingStage(changedAtColumn: string | undefined = 'updated_at') {
    const stage = makeStage(3);

    return { ...stage, source: { ...stage.source, changedAtColumn } };
  }

  it('does nothing — not even a query — for a stage that declares no change stamp', async () => {
    const { service, statements } = make([srcId(1)]);

    await expect(service.reopenChangedSources(makeStage(3), USER)).resolves.toBe(0);
    expect(statements).toHaveLength(0);
  });

  it('finds rows stamped after their decision, then re-opens them through reopen()', async () => {
    const { service, statements } = make([srcId(1), srcId(2)]);

    await expect(service.reopenChangedSources(changingStage(), USER)).resolves.toBe(2);

    expect(statements).toHaveLength(2);
    const [find, reopen] = statements;

    // The source, scoped to the user and the stage's own predicate …
    expect(find.sql).toMatch(/FROM "ci"\."files" s WHERE s\."user_id" = \$3/);
    expect(find.sql).toContain("AND (s.content_type LIKE 'image/%')");
    // … a decided row at the CURRENT version, done or skipped …
    expect(find.sql).toMatch(/p\.stage_version >= \$4/);
    expect(find.sql).toMatch(/p\.status IN \('done', 'skipped'\)/);
    // … whose decision predates the declared stamp, less the grace.
    expect(find.sql).toMatch(/p\.updated_at < s\."updated_at" \+ make_interval\(secs => \$5::float8\)/);
    expect(find.params).toEqual([ENTITY_TYPE, STAGE_ID, USER, 3, SOURCE_CHANGE_GRACE_SECONDS, 20_000]);

    // One definition of "re-open": the same statement reopen() issues.
    expect(reopen.sql).toMatch(/^WITH reopened AS \( UPDATE ci\.pipeline_state ps SET stage_version = 0/);
    expect(reopen.params).toEqual([ENTITY_TYPE, STAGE_ID, [srcId(1), srcId(2)]]);
  });

  it('issues no re-open when nothing changed', async () => {
    const { service, statements } = make([]);

    await expect(service.reopenChangedSources(changingStage(), USER)).resolves.toBe(0);
    expect(statements).toHaveLength(1);
  });

  it('honours an explicit limit and refuses a nonsensical one', async () => {
    const { service, statements } = make([]);

    await service.reopenChangedSources(changingStage(), USER, undefined, 7);
    expect(statements[0].params[5]).toBe(7);

    await expect(service.reopenChangedSources(changingStage(), USER, undefined, 0)).rejects.toThrow(/limit/);
  });

  it('refuses a change stamp that is not a plain identifier', async () => {
    const { service, statements } = make([]);

    await expect(service.reopenChangedSources(changingStage('updated_at; --'), USER)).rejects.toThrow(
      /changed-at column/,
    );
    expect(statements).toHaveLength(0);
  });
});
