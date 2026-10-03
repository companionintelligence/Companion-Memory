import { randomUUID } from 'node:crypto';

import { DataSource, type EntityManager } from 'typeorm';

import { DEAD_EVENT_STATUSES, LIVE_EVENT_SQL } from '@ci/domains/memory';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { databaseAvailability, resolveConnection } from '../../__tests__/harness/pipelineHarness';
import { PipelineStateService } from '../../services/PipelineStateService';
import type { StageResult } from '../../types';
import {
  ENRICH_ESTIMATE_LOCATION_STAGE_ID,
  ESTIMATE_LOCATION_VERSION,
  ESTIMATE_MAX_GAP_HOURS,
  ESTIMATE_RULE_GENERATION,
  ESTIMATE_SOURCE_SYSTEMS,
  ESTIMATED_CONFIDENCE,
  EstimateLocationStage,
  estimateLocationStageVersion,
  eventHappenedSql,
  liveEventStatusSql,
  RESERVATION_CANCELED_KEY,
  withdrawEstimates,
} from '../enrich/EstimateLocationStage';
import { FORWARD_GEOCODE_PROVIDER_GENERATION } from '../enrich/GeocodeStage';

/**
 * `enrich.estimate_location` — `LocationEstimateService`'s temporal
 * nearest-neighbour fill, on the ledger.
 *
 * The conversion turns on ONE predicate doing TWO jobs. The service selects with
 * `location_coordinates IS NULL` (plus `location_source <> 'estimated'`), and
 * that single clause is simultaneously:
 *
 *  1. **candidate selection** — the ratchet, relaxed only by a `forced` request
 *     flag that nothing records, and
 *  2. **"never overwrite a real coordinate"** — a genuine correctness rule.
 *
 * Job (1) is deleted and replaced by `ci.pipeline_state`; job (2) survives as an
 * explicit, recorded per-row decision. These tests pin both halves separately,
 * because losing (2) along with (1) would silently overwrite measured GPS and
 * geocoded coordinates with 0.4-confidence guesses across the whole corpus.
 *
 * The third property under test is the invariant the service documents and
 * enforces on the donor side — **an estimate is never seeded from another
 * estimate** — which is NOT part of the ratchet and is kept verbatim.
 *
 * Most of this needs no Postgres: the fake `DataSource` recognises the sweep by its
 * `LEFT JOIN ci.pipeline_state` and evaluates THE ONE RULE in TypeScript from the
 * six bound parameters, so the assertions cover which rows come back for which
 * ledger states rather than a SQL string.
 *
 * The last block DOES need one. This stage's write is a single statement with a
 * correlated `LATERAL` over two tables and a `RETURNING` the caller reads, and a
 * fake `DataSource` will agree with any of it — including, as it turns out, a
 * return shape that inverted every outcome. It runs against the dev database
 * inside a transaction that is always rolled back, and SKIPS — never silently
 * passes — when no database is reachable.
 */

/* ===================================================================== *
 * Fixtures
 * ===================================================================== */

const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';
const ENTITY_TYPE = 'event';

/** Ordered uuids — Postgres byte order and JS lexical order agree on these. */
function eventId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

interface SourceRow {
  id: string;
  user_id: string;
  source_system: string;
  is_deleted: boolean | null;
  is_predicted: boolean | null;
  status: string | null;
  metadata: Record<string, unknown>;
  /** The stage's OUTPUT columns. Nothing in selection may ever read these. */
  has_coordinates: boolean;
  location_source: string | null;
}

function eventRow(n: number, overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: eventId(n),
    user_id: USER,
    source_system: 'calendar',
    is_deleted: false,
    is_predicted: false,
    status: 'confirmed',
    metadata: {},
    has_coordinates: false,
    location_source: null,
    ...overrides,
  };
}

type LedgerStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'quarantined';

interface LedgerRow {
  stageVersion: number;
  status: LedgerStatus;
  reason: string | null;
  nextAttemptAt: Date | null;
}

/* ===================================================================== *
 * Stage construction
 * ===================================================================== */

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/** A row as {@link EstimateLocationStage.loadRows} projects it. */
interface LoadedRow {
  id: string;
  has_coordinates: boolean;
  location_source: string | null;
  has_location_name: boolean;
  is_deleted: boolean | null;
  is_predicted: boolean | null;
  did_not_happen: boolean;
}

function loadedRow(n: number, overrides: Partial<LoadedRow> = {}): LoadedRow {
  return {
    id: eventId(n),
    has_coordinates: false,
    location_source: null,
    has_location_name: false,
    is_deleted: false,
    is_predicted: false,
    did_not_happen: false,
    ...overrides,
  };
}

/** One row the write reports back through RETURNING. */
function filledRow(n: number, donor = 'position', deltaSeconds = 42) {
  return {
    event_id: eventId(n),
    donor,
    donor_id: `donor-${n}`,
    delta_seconds: deltaSeconds,
  };
}

interface StageHarness {
  stage: EstimateLocationStage;
  /** Every statement the stage issued, in order. */
  statements: Array<{ sql: string; params: unknown[] }>;
  /**
   * The single set-based write, if one was issued.
   *
   * Matched on `WITH … SELECT` rather than on `UPDATE`, which is not cosmetic —
   * see the regression test below on why the UPDATE has to be wrapped in a CTE.
   */
  update(): { sql: string; params: unknown[] } | undefined;
}

/**
 * The stage with its only collaborator — the `DataSource` — stubbed. `filled` is
 * what the UPDATE's `RETURNING` hands back, i.e. exactly the candidates that
 * found a donor; everything else the stage asked for had none.
 */
function makeStage(
  rows: LoadedRow[] = [],
  opts: { filled?: Array<ReturnType<typeof filledRow>>; writeError?: Error } = {},
): StageHarness {
  const statements: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    statements.push({ sql, params: params ?? [] });

    if (/^select/i.test(sql)) {
      const [ids, userId] = (params ?? []) as [string[], string];

      return rows.filter((row) => ids.includes(row.id) && userId === USER);
    }

    if (opts.writeError != null) {
      throw opts.writeError;
    }

    // Default: every candidate found a donor. A test that cares supplies its own.
    if (opts.filled != null) {
      return opts.filled;
    }

    const [ids] = (params ?? []) as [string[]];

    return ids.map((id, index) => filledRow(Number(id.slice(-12)) || index + 1));
  });

  const stage = new EstimateLocationStage({ query } as never, makeLogger() as never);

  return {
    stage,
    statements,
    update: () => statements.find((statement) => /^with estimated as/i.test(statement.sql)),
  };
}

/* ===================================================================== *
 * The fake DataSource: THE ONE RULE, evaluated
 * ===================================================================== */

function ledgerKey(entityType: string, entityId: string, stage: string): string {
  return `${entityType}|${entityId}|${stage}`;
}

/**
 * The stage's applicability predicate, mirrored in TypeScript.
 *
 * Kept faithful to `ESTIMATE_LOCATION_SOURCE.predicate`: a physical-presence
 * event that happened — not deleted, not predicted, not called off. Note what
 * it does NOT consult — `location_coordinates` or
 * `metadata->>'location_source'`, the two columns the service's predicate is
 * built out of. Postgres evaluates the real one in
 * `EstimateLocationDidNotHappen.integration.spec.ts`.
 */
function isApplicable(row: SourceRow): boolean {
  return (
    (row.is_deleted ?? false) === false &&
    (row.is_predicted ?? false) === false &&
    !(DEAD_EVENT_STATUSES as readonly string[]).includes(row.status ?? 'confirmed') &&
    String(row.metadata[RESERVATION_CANCELED_KEY] ?? '') !== 'true' &&
    ESTIMATE_SOURCE_SYSTEMS.includes(row.source_system)
  );
}

function evaluateOneRule(
  rows: SourceRow[],
  ledger: Map<string, LedgerRow>,
  params: unknown[],
): Array<{ id: string }> {
  if (params.length !== 6) {
    throw new Error(
      `THE ONE RULE binds exactly six parameters ` +
        `($1 entity_type, $2 stage, $3 user_id, $4 stage_version, $5 cursor, $6 limit); got ${params.length}`,
    );
  }

  const [entityType, stageId, userId, version, cursor, limit] = params as [
    string,
    string,
    string,
    number,
    string | null,
    number,
  ];

  const now = Date.now();

  return rows
    .filter((row) => row.user_id === userId)
    .filter(isApplicable)
    .filter((row) => {
      const entry = ledger.get(ledgerKey(entityType, row.id, stageId));

      // p.entity_id IS NULL — never processed.
      if (entry === undefined) {
        return true;
      }

      // p.stage_version < $4 — the rule (or the geocoder feeding its donors)
      // improved since this row was answered.
      if (entry.stageVersion < version) {
        return true;
      }

      // (p.status = 'failed' AND p.next_attempt_at <= now()) — retry is due.
      return entry.status === 'failed' && entry.nextAttemptAt != null && entry.nextAttemptAt.getTime() <= now;
    })
    .filter((row) => cursor == null || row.id > cursor)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit)
    .map((row) => ({ id: row.id }));
}

function makeLedgerHarness(rows: SourceRow[]) {
  const ledger = new Map<string, LedgerRow>();
  const sweeps: Array<{ sql: string; params: unknown[] }> = [];
  const writes: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();

    if (/not\s+exists[\s\S]*ci\.pipeline_state/i.test(sql)) {
      sweeps.push({ sql, params: params ?? [] });

      return evaluateOneRule(rows, ledger, params ?? []);
    }

    if (/ci\.pipeline_state/i.test(sql) && !/^select/i.test(sql)) {
      writes.push({ sql, params: params ?? [] });

      return [];
    }

    return [];
  });

  const service = new PipelineStateService({ query } as never, makeLogger() as never);

  return {
    service,
    sweeps,
    writes,
    seed: (entityId: string, row: LedgerRow, stageId: string) =>
      ledger.set(ledgerKey(ENTITY_TYPE, entityId, stageId), row),
  };
}

/**
 * The real stage, at a different version — what incrementing
 * `ESTIMATE_RULE_GENERATION` (or the geocode provider generation it also derives
 * from) does to the value the sweep binds as `$4`.
 */
function atVersion(stage: EstimateLocationStage, version: number) {
  return {
    id: stage.id,
    version,
    queue: stage.queue,
    entityTypes: stage.entityTypes,
    source: stage.source,
    run: stage.run.bind(stage),
  };
}

/* ===================================================================== *
 * Tests
 * ===================================================================== */

describe('EstimateLocationStage — candidate selection asks the LEDGER, not location_coordinates', () => {
  it('selects a row that ALREADY carries an estimate — what `forced` used to be', async () => {
    // `LocationEstimateService` needs a request-scoped `forced: true` to consider
    // this row at all, and records nothing about the run that used it. Here the
    // row is an ordinary candidate whose last outcome is in the ledger.
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1, { has_coordinates: true, location_source: 'estimated' })]);

    const ids = await h.service.selectStale(stage as never, USER, null, 10);

    expect(ids).toEqual([eventId(1)]);
  });

  it('never names the output columns in the sweep', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    const sql = h.sweeps[0].sql.toLowerCase();
    expect(sql).not.toMatch(/location_coordinates/);
    expect(sql).not.toMatch(/location_source/);
    expect(sql).not.toMatch(/is_inferred/);
  });

  it('splices the stage applicability predicate verbatim, and it says what a row IS', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    expect(h.sweeps[0].sql).toContain(stage.source.predicate);
    expect(stage.source.predicate).not.toMatch(
      /location_coordinates|location_source|is_inferred|pipeline_state/i,
    );
    // The physical-presence allowlist, which IS applicability: it says what kind
    // of row this is, not whether anything has happened to it.
    expect(stage.source.predicate).toContain("'calendar'");
    // Messages carry no inherent "where I was" — 309,689 of the 324,044 events on
    // the appliance this was written against are `google_voice`, and a 3am text
    // must never snap to yesterday's restaurant.
    expect(stage.source.predicate).not.toContain('google_voice');
  });

  it('excludes non-presence systems, deleted rows, predictions and another user', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([
      eventRow(1),
      eventRow(2, { source_system: 'google_voice' }),
      eventRow(3, { is_deleted: true }),
      // `ci.events` CHECKs NOT (is_predicted AND is_inferred), and the write sets
      // is_inferred — one predicted row would abort the whole statement.
      eventRow(4, { is_predicted: true }),
      eventRow(5, { user_id: OTHER_USER }),
      eventRow(6),
    ]);

    const ids = await h.service.selectStale(stage as never, USER, null, 10);

    expect(ids).toEqual([eventId(1), eventId(6)]);
  });

  it('excludes events that did not happen, and keeps the near misses (v3)', async () => {
    const { stage } = makeStage();
    const reservation = { Kind: 'reservation', Source: 'Google' };
    const h = makeLedgerHarness([
      eventRow(1, { status: 'cancelled' }),
      eventRow(2, { status: 'no_show' }),
      eventRow(3, { status: 'skipped' }),
      eventRow(4, { source_system: 'google_purchases', metadata: { ...reservation, Canceled: true } }),
      // Still live on the calendar, so still estimable.
      eventRow(5, { status: 'tentative' }),
      eventRow(6, { status: 'rescheduled' }),
      eventRow(7, { is_predicted: null }),
      eventRow(8, { source_system: 'google_purchases', metadata: { ...reservation, Canceled: false } }),
    ]);

    const ids = await h.service.selectStale(stage as never, USER, null, 10);

    expect(ids).toEqual([eventId(5), eventId(6), eventId(7), eventId(8)]);
  });

  it('stops re-selecting a row with no donor, and re-opens it on a bump', async () => {
    // The service has no way to express this: a candidate with no donor is simply
    // not filled, so it is counted again on every single run forever.
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1), eventRow(2)]);
    h.seed(
      eventId(1),
      {
        stageVersion: stage.version,
        status: 'skipped',
        reason: 'no_donor_in_window',
        nextAttemptAt: null,
      },
      stage.id,
    );

    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([eventId(2)]);
    await expect(
      h.service.selectStale(atVersion(stage, stage.version + 1) as never, USER, null, 10),
    ).resolves.toEqual([eventId(1), eventId(2)]);
  });

  it('leaves an estimated row alone at the current version and re-selects it after a bump', async () => {
    // The headline property, and the exact thing `forced` was invented for: when
    // better donors land, or the window widens, every previous estimate is
    // re-computed. Here it is one integer instead of a request flag.
    const { stage } = makeStage();
    const h = makeLedgerHarness([
      eventRow(1, { has_coordinates: true, location_source: 'estimated' }),
      eventRow(2),
    ]);
    h.seed(
      eventId(1),
      { stageVersion: stage.version, status: 'done', reason: null, nextAttemptAt: null },
      stage.id,
    );
    h.seed(
      eventId(2),
      {
        stageVersion: stage.version,
        status: 'skipped',
        reason: 'no_donor_in_window',
        nextAttemptAt: null,
      },
      stage.id,
    );

    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([]);
    await expect(
      h.service.selectStale(atVersion(stage, stage.version + 1) as never, USER, null, 10),
    ).resolves.toEqual([eventId(1), eventId(2)]);
  });

  it('binds the version off the stage, and records under entity_type "event"', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    expect(h.sweeps[0].params[0]).toBe(ENTITY_TYPE);
    expect(h.sweeps[0].params[1]).toBe(ENRICH_ESTIMATE_LOCATION_STAGE_ID);
    expect(h.sweeps[0].params[3]).toBe(stage.version);
  });
});

describe('EstimateLocationStage — the version derives from the geocoder its donors come from', () => {
  it('derives from the estimation rule AND the forward-geocode provider generation', () => {
    // An estimate is a COPY of a donor coordinate, and on a calendar-heavy corpus
    // the donors are overwhelmingly rows `enrich.geocode` resolved. Improving the
    // geocoder therefore makes every estimate stale, and this is what makes that
    // automatic rather than a fact living in someone's head.
    expect(ESTIMATE_LOCATION_VERSION).toBe(
      ESTIMATE_RULE_GENERATION + FORWARD_GEOCODE_PROVIDER_GENERATION - 1,
    );
    expect(Number.isInteger(ESTIMATE_LOCATION_VERSION)).toBe(true);
    expect(ESTIMATE_LOCATION_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('reports the derived version rather than hardcoding one', () => {
    const { stage } = makeStage();

    expect(stage.version).toBe(ESTIMATE_LOCATION_VERSION);
    expect(estimateLocationStageVersion({})).toBe(ESTIMATE_LOCATION_VERSION);
  });

  it('throws when STAGE_VERSIONS disagrees with the derivation', () => {
    expect(() =>
      estimateLocationStageVersion({
        [ENRICH_ESTIMATE_LOCATION_STAGE_ID]: ESTIMATE_LOCATION_VERSION + 1,
      }),
    ).toThrow(/derives/i);
  });

  it('accepts a STAGE_VERSIONS entry that agrees, and ignores a thunk', () => {
    expect(
      estimateLocationStageVersion({ [ENRICH_ESTIMATE_LOCATION_STAGE_ID]: ESTIMATE_LOCATION_VERSION }),
    ).toBe(ESTIMATE_LOCATION_VERSION);
    expect(estimateLocationStageVersion({ [ENRICH_ESTIMATE_LOCATION_STAGE_ID]: () => 99 })).toBe(
      ESTIMATE_LOCATION_VERSION,
    );
  });
});

describe('EstimateLocationStage — an event that did not happen neither lends nor receives (v3)', () => {
  // Proven against Postgres, case by case, in
  // EstimateLocationDidNotHappen.integration.spec.ts. These pin the text, which
  // is what catches an equivalent mutant: dropping a COALESCE from a column
  // that is NOT NULL today changes nothing Postgres can show.
  const ctx = { userId: USER };

  /**
   * The rule for a donor aliased `n`, as both estimators must interpolate it.
   * `LocationEstimateService.spec.ts` pins its copy to this same text.
   */
  const HAPPENED_N =
    'COALESCE(n.is_deleted, false) = false ' +
    'AND COALESCE(n.is_predicted, false) = false ' +
    `AND ${LIVE_EVENT_SQL.replace('event.status', 'n.status')} ` +
    "AND COALESCE(n.metadata->>'Canceled', '') <> 'true'";

  it("reads status through the calendar's own LIVE_EVENT_SQL, re-aliased and nothing else", () => {
    expect(liveEventStatusSql('event')).toBe(LIVE_EVENT_SQL);
  });

  it('states the rule in the text the legacy service states it in', () => {
    expect(eventHappenedSql('n')).toBe(HAPPENED_N);
    expect(RESERVATION_CANCELED_KEY).toBe('Canceled');
  });

  it('applies the one rule to the sweep, the donor branch, the write and the load', async () => {
    const h = makeStage([loadedRow(1)]);

    await h.stage.run(ctx, [eventId(1)]);

    expect(h.stage.source.predicate).toContain(eventHappenedSql('s'));
    expect(h.update()!.sql).toContain(`AND ${eventHappenedSql('n')} AND`);
    // The write re-checks its own target, so a slice already running cannot put
    // back an estimate the writer of a cancellation has just taken back.
    expect(h.update()!.sql).toContain(`WHERE tgt.event_id = c.event_id AND ${eventHappenedSql('tgt')}`);
    expect(h.statements[0].sql).toContain(`NOT (${eventHappenedSql('e')}) AS did_not_happen`);
  });

  it('SKIPS a row called off between the sweep and the slice, and writes nothing', async () => {
    const h = makeStage([loadedRow(1, { did_not_happen: true })]);

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toEqual({ outcome: 'skipped', reason: 'event_did_not_happen' });
    expect(h.update()).toBeUndefined();
  });

  it('keeps the more specific reason for a deleted or predicted row', async () => {
    // `did_not_happen` covers both, since it is NOT eventHappenedSql.
    const h = makeStage([
      loadedRow(1, { is_deleted: true, did_not_happen: true }),
      loadedRow(2, { is_predicted: true, did_not_happen: true }),
    ]);

    const results = await h.stage.run(ctx, [eventId(1), eventId(2)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'skipped', reason: 'event_deleted' });
    expect(results.get(eventId(2))).toMatchObject({ outcome: 'skipped', reason: 'predicted_event' });
  });

  it('refuses to interpolate an alias that is not a plain token', () => {
    expect(() => eventHappenedSql('n; DROP TABLE ci.events')).toThrow(/plain/);
    expect(() => liveEventStatusSql('n.status')).toThrow(/plain/);
  });

  it('is rule generation 3 or later, so the sweep re-offers every row decided before the rule', () => {
    // Generations 1 and 2 took any undeleted located event as a donor.
    expect(ESTIMATE_RULE_GENERATION).toBeGreaterThanOrEqual(3);
  });
});

describe('withdrawEstimates — an estimate on an event called off is taken back by the writer of its status', () => {
  // Proven against Postgres, through the real service, ledger and stage, in
  // EventWritesSettlePipeline.integration.spec.ts. These pin the text, which
  // is what catches an equivalent mutant: a guard dropped from a clause that
  // only an inconsistent row could show.
  const ids = [eventId(1), eventId(2)];

  function run(rows: Array<{ event_id: string }> = [{ event_id: eventId(1) }]) {
    const query = jest.fn(async (..._args: unknown[]) => rows);

    return { query, done: withdrawEstimates({ query } as unknown as Pick<EntityManager, 'query'>, ids) };
  }

  /** The statement it ran, on one line: these pin its clauses, not how they are laid out. */
  const statement = (query: jest.Mock): string =>
    (query.mock.calls[0] as unknown as [string])[0].replace(/\s+/g, ' ').trim();

  it("is one statement on the caller's manager, and counts the events it took an estimate from", async () => {
    const { query, done } = run([{ event_id: eventId(1) }, { event_id: eventId(2) }]);

    await expect(done).resolves.toBe(2);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toEqual([expect.any(String), [ids, ESTIMATED_CONFIDENCE, 'estimated']]);
  });

  it('is wrapped in a CTE, so the rows come back as rows and not as [rows, rowCount]', async () => {
    const { query, done } = run();
    await done;

    const sql = statement(query);
    expect(sql).toMatch(/^WITH withdrawn AS \( UPDATE ci\.events e /);
    expect(sql).toMatch(/ SELECT event_id FROM withdrawn$/);
  });

  it('acts only on an event whose stored status says it did not happen', async () => {
    const { query, done } = run();
    await done;

    const sql = statement(query);
    // The status clause alone: deletion and prediction are not asked about.
    expect(sql).toContain(`AND NOT (${liveEventStatusSql('e')})`);
    expect(sql).not.toContain('is_deleted');
    expect(sql).not.toContain('is_predicted');
  });

  it('acts only on a coordinate the estimator owns, that nothing hangs on', async () => {
    const { query, done } = run();
    await done;

    const sql = statement(query);
    expect(sql).toContain("AND e.metadata->>'location_source' = $3::text");
    expect(sql).toContain('AND e.location_coordinates IS NOT NULL');
    // The test the write applies to its own target, and the geocoder to its candidates.
    expect(sql).toContain("AND (e.location_name IS NULL OR btrim(e.location_name) = '')");
  });

  it('is the inverse of what the estimator writes, as far as the row still proves it', async () => {
    const { query, done } = run();
    await done;

    const sql = statement(query);
    expect(sql).toContain('location_coordinates = NULL');
    expect(sql).toContain("metadata = COALESCE(e.metadata, '{}'::jsonb) - 'location_source'");
    // The inference and the confidence go back only while they are still the estimate's.
    expect(sql).toContain(
      "is_inferred = CASE WHEN e.inference_sources->>'method' = 'temporal_nn' THEN false ELSE e.is_inferred END",
    );
    expect(sql).toContain(
      "inference_sources = CASE WHEN e.inference_sources->>'method' = 'temporal_nn' THEN '{}'::jsonb ELSE e.inference_sources END",
    );
    expect(sql).toContain(
      'confidence_score = CASE WHEN e.confidence_score = $2::float8 THEN 1.0 ELSE e.confidence_score END',
    );
    expect(sql).toContain('updated_at = now()');
  });

  it("spells the estimator's method the way the estimator writes it", async () => {
    const h = makeStage([loadedRow(1)]);
    await h.stage.run({ userId: USER }, [eventId(1)]);
    const { query, done } = run();
    await done;

    const withdrawal = statement(query);
    expect(h.update()!.sql).toContain("'method', 'temporal_nn'");
    expect(withdrawal).toContain("e.inference_sources->>'method' = 'temporal_nn'");
    // And the marker and confidence it keys on are the ones the write is given.
    expect((h.update()!.params as unknown[]).slice(3, 5)).toEqual([ESTIMATED_CONFIDENCE, 'estimated']);
  });

  it('touches nothing for no events', async () => {
    const query = jest.fn();

    await expect(withdrawEstimates({ query } as unknown as Pick<EntityManager, 'query'>, [])).resolves.toBe(
      0,
    );
    expect(query).not.toHaveBeenCalled();
  });
});

describe('EstimateLocationStage.run — the donor query keeps every rule the service had', () => {
  const ctx = { userId: USER };

  it('fills a candidate from its donor and reports the donor back', async () => {
    const h = makeStage([loadedRow(1)], { filled: [filledRow(1, 'position', 90)] });

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'done',
      confidence: ESTIMATED_CONFIDENCE,
      detail: { donor: 'position', donorId: 'donor-1', deltaSeconds: 90 },
    });

    const update = h.update();
    expect(update).toBeDefined();

    const [ids, userId, gapSeconds, confidence, locationSource, gapHours] = update!.params as [
      string[],
      string,
      number,
      number,
      string,
      number,
    ];

    expect(ids).toEqual([eventId(1)]);
    expect(userId).toBe(USER);
    expect(gapSeconds).toBe(ESTIMATE_MAX_GAP_HOURS * 3600);
    expect(confidence).toBe(ESTIMATED_CONFIDENCE);
    expect(locationSource).toBe('estimated');
    expect(gapHours).toBe(ESTIMATE_MAX_GAP_HOURS);
  });

  it('NEVER seeds an estimate from another estimate — the invariant, on the DONOR side only', async () => {
    const h = makeStage([loadedRow(1)]);

    await h.stage.run(ctx, [eventId(1)]);

    const sql = h.update()!.sql;

    // The donor branch over ci.events excludes rows this stage itself wrote.
    // Without it an estimate can be copied from an estimate copied from an
    // estimate: error compounds, confidence stays pinned at 0.4 the whole way
    // down, and the result depends on slice order — so the same corpus swept
    // twice produces two different maps.
    expect(sql).toMatch(/coalesce\(n\.metadata->>'location_source',\s*''\)\s*<>\s*\$5::text/i);
    expect((h.update()!.params as unknown[])[4]).toBe('estimated');

    // …and the CANDIDATE side carries no such filter: previously-estimated rows
    // ARE re-estimated (from real donors, at the current rule), which is the
    // ratchet this conversion removes. `[\s\S]` because the statement is
    // whitespace-collapsed but still one long line.
    const candidateSubquery = /FROM \(\s*SELECT e\.event_id[\s\S]*?\) c/i.exec(sql);
    expect(candidateSubquery).not.toBeNull();
    expect(candidateSubquery![0]).not.toMatch(/location_source/i);
    expect(candidateSubquery![0]).not.toMatch(/location_coordinates/i);
  });

  it('prefers the temporally nearest donor, using a GPS fix only to break a tie', async () => {
    const h = makeStage([loadedRow(1)]);

    await h.stage.run(ctx, [eventId(1)]);

    // Precision about the wrong hour is not precision: a distant position fix
    // must never beat a temporally closer located event.
    expect(h.update()!.sql).toMatch(/ORDER BY delta_seconds ASC,\s*\(donor <> 'position'\)/i);
  });

  it('parenthesizes each UNION branch, so its ORDER BY/LIMIT binds to that branch', async () => {
    const h = makeStage([loadedRow(1)]);

    await h.stage.run(ctx, [eventId(1)]);

    const sql = h.update()!.sql;

    // Without the parentheses the query still runs and quietly returns the wrong
    // donor — the worst kind of failure, because it succeeds.
    expect(sql).toMatch(/\(\s*SELECT p\.location AS coords[\s\S]*?LIMIT 1\s*\)\s*UNION ALL/i);
    expect(sql).toMatch(/UNION ALL\s*\(\s*SELECT n\.location_coordinates AS coords/i);
  });

  it('bounds both donor lookups with a sargable BETWEEN window', async () => {
    const h = makeStage([loadedRow(1)]);

    await h.stage.run(ctx, [eventId(1)]);

    const sql = h.update()!.sql;

    // `abs(...) < x` would be unusable by the (user_id, time) index and would stop
    // TimescaleDB excluding chunks on ci.position, which is the largest table on
    // the appliance.
    expect(sql).toMatch(/p\.time BETWEEN c\.start_time - make_interval/i);
    expect(sql).toMatch(/n\.start_time BETWEEN c\.start_time - make_interval/i);
  });

  it('marks the row inferred and never RAISES its confidence', async () => {
    const h = makeStage([loadedRow(1)]);

    await h.stage.run(ctx, [eventId(1)]);

    const sql = h.update()!.sql;

    expect(sql).toMatch(/is_inferred\s*=\s*true/i);
    // LEAST, unlike the geocode stage's plain assignment: an estimate is a guess
    // and must never make an event look more certain than it already was.
    expect(sql).toMatch(/confidence_score\s*=\s*LEAST\(COALESCE\(tgt\.confidence_score, 1\.0\), \$4/i);
    expect(sql).toMatch(/'method', 'temporal_nn'/i);
  });

  it('wraps the UPDATE in a CTE, because TypeORM returns [rows, rowCount] for a bare one', async () => {
    // MEASURED against the dev database, TypeORM 0.3 + node-pg:
    //   UPDATE … RETURNING  => [[{event_id: …}], 1]
    //   WITH … SELECT       =>  [{event_id: …}]
    //   INSERT … RETURNING  =>  [{event_id: …}]   (hence PipelineStateService's immunity)
    //
    // With the bare form this stage receives an array whose first element is an
    // array of rows, so its `filledById` lookup misses every id and EVERY row it
    // just successfully filled is recorded as `skipped: no_donor_in_window`.
    // Nothing throws; the coordinates are written and the ledger says the
    // opposite of what happened. It was caught by running the real statement
    // against Postgres inside a rolled-back transaction, and no assertion over a
    // fake DataSource could have caught it — which is why this one asserts the
    // SHAPE OF THE STATEMENT rather than the shape of the result.
    const h = makeStage([loadedRow(1)]);

    await h.stage.run(ctx, [eventId(1)]);

    const write = h.update();
    expect(write).toBeDefined();
    expect(write!.sql).toMatch(/^WITH estimated AS \(\s*UPDATE ci\.events tgt/i);
    expect(write!.sql).toMatch(/SELECT event_id, donor, donor_id, delta_seconds FROM estimated$/i);
    // No statement this stage issues may be a bare, unwrapped UPDATE.
    expect(h.statements.some((statement) => /^update/i.test(statement.sql))).toBe(false);
  });

  it('guards the CHECK constraint in the statement as well as in the load', async () => {
    const h = makeStage([loadedRow(1)]);

    await h.stage.run(ctx, [eventId(1)]);

    // `valid_prediction_inference` is NOT (is_predicted AND is_inferred). A row
    // that flips to predicted between the load and the write would otherwise
    // abort the entire slice's statement, failing every other id with it.
    expect(h.update()!.sql).toMatch(/COALESCE\(tgt\.is_predicted, false\) = false/i);
  });
});

describe('EstimateLocationStage.run — every id gets exactly one answer', () => {
  const ctx = { userId: USER };

  it('SKIPS a candidate the write did not fill, with a reason', async () => {
    // The counterpart of a geocoder's ZERO_RESULTS: an answer, not a failure, and
    // one that will not change until the corpus does. A wave of newly-imported
    // GPS fixes re-opens these rows through a version bump — the honest
    // replacement for the service's `forced` flag.
    const h = makeStage([loadedRow(1), loadedRow(2)], { filled: [filledRow(1)] });

    const results = await h.stage.run(ctx, [eventId(1), eventId(2)]);

    expect(results.get(eventId(1))?.outcome).toBe('done');
    expect(results.get(eventId(2))).toEqual({ outcome: 'skipped', reason: 'no_donor_in_window' });
  });

  it('FAILS every candidate when the one statement does not commit', async () => {
    // One statement means one outcome: it committed or it did not. Attributing
    // the failure to one id would be a guess, and a guess is what the reason
    // column exists to replace.
    const h = makeStage([loadedRow(1), loadedRow(2)], {
      writeError: new Error('deadlock detected'),
    });

    const results = await h.stage.run(ctx, [eventId(1), eventId(2)]);

    for (const id of [eventId(1), eventId(2)]) {
      expect(results.get(id)).toMatchObject({ outcome: 'failed', reason: 'estimate_write_failed' });
    }
  });

  it('answers for an id whose row is gone rather than staying silent', async () => {
    const h = makeStage([]);

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toEqual({ outcome: 'skipped', reason: 'source_row_missing' });
    // Nothing to estimate, so no write at all.
    expect(h.update()).toBeUndefined();
  });

  it('SKIPS a row soft-deleted or turned into a prediction mid-flight', async () => {
    const h = makeStage([loadedRow(1, { is_deleted: true }), loadedRow(2, { is_predicted: true })]);

    const results = await h.stage.run(ctx, [eventId(1), eventId(2)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'skipped', reason: 'event_deleted' });
    expect(results.get(eventId(2))).toMatchObject({ outcome: 'skipped', reason: 'predicted_event' });
    expect(h.update()).toBeUndefined();
  });

  it('scopes the row load to the slice user', async () => {
    const h = makeStage([loadedRow(1)]);

    await h.stage.run({ userId: OTHER_USER }, [eventId(1)]);

    expect(h.statements[0].params[1]).toBe(OTHER_USER);
    expect(h.update()).toBeUndefined();
  });

  it('gives every non-done outcome a reason — the ledger refuses one without', async () => {
    const h = makeStage([loadedRow(1, { has_coordinates: true, location_source: 'geocoded' })], {
      filled: [],
    });

    const results = await h.stage.run(ctx, [eventId(1), eventId(2)]);

    for (const [id, result] of results) {
      if (result.outcome !== 'done') {
        expect(`${id}:${result.reason ?? ''}`).not.toMatch(/:$/);
      }
    }

    expect(results.size).toBe(2);
  });

  it('returns an empty map for an empty slice without touching the database', async () => {
    const h = makeStage([]);

    const results = await h.stage.run(ctx, []);

    expect(results.size).toBe(0);
    expect(h.statements).toHaveLength(0);
  });

  it('refuses to write a skip or a failure with no reason', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1)]);

    await expect(
      h.service.complete(
        stage as never,
        ENTITY_TYPE,
        new Map<string, StageResult>([[eventId(1), { outcome: 'skipped' }]]),
      ),
    ).rejects.toThrow(/no reason/i);

    expect(h.writes).toHaveLength(0);
  });
});

describe('EstimateLocationStage.run — it never overwrites a location the row already owns', () => {
  const ctx = { userId: USER };

  it.each([
    ['a measured or imported coordinate', null],
    ['a geocoded coordinate', 'geocoded'],
    ['a coarse geocoded centroid', 'approximate'],
    ['a reverse-geocoded fix', 'reverse_geocoded'],
  ])('SKIPS %s rather than replacing it with a 0.4 guess', async (_label, source) => {
    // THE SURVIVING HALF of `location_coordinates IS NULL`. That clause was doing
    // two jobs; the ledger took over candidate selection, and this is the other
    // one — now recorded per row instead of being an invisible consequence of a
    // WHERE clause.
    const h = makeStage([loadedRow(1, { has_coordinates: true, location_source: source })]);

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'has_own_location',
    });
    expect(h.update()).toBeUndefined();
  });

  it('RE-ESTIMATES a row whose coordinates are its own previous estimate', async () => {
    // Re-estimating an estimate is fine and intended — the row is recomputed FROM
    // REAL DONORS at the current rule. Chaining one estimate off another is not,
    // and that is the donor-side clause, not this one.
    const h = makeStage([loadedRow(1, { has_coordinates: true, location_source: 'estimated' })], {
      filled: [filledRow(1, 'event', 3600)],
    });

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'done',
      detail: { donor: 'event' },
    });
    expect(h.update()).toBeDefined();
  });

  it('estimates a row with no coordinates whatever its provenance tag says', async () => {
    const h = makeStage([loadedRow(1, { has_coordinates: false, location_source: 'virtual' })], {
      filled: [filledRow(1)],
    });

    expect((await h.stage.run(ctx, [eventId(1)])).get(eventId(1))?.outcome).toBe('done');
  });
});

describe("EstimateLocationStage.run — an event that names its own location is the geocoder's (v2)", () => {
  const ctx = { userId: USER };

  it("SKIPS a named row with no coordinate instead of lending it a neighbour's", async () => {
    // The v1 defect: a calendar event "Bangkok BKK" with no geocode yet was
    // filled from the nearest GPS fix — the user's home — and promote.place then
    // linked it to the home Location.
    const h = makeStage([loadedRow(1, { has_location_name: true })]);

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toEqual({
      outcome: 'skipped',
      reason: 'has_location_name',
      detail: { locationSource: null },
    });
    expect(h.update()).toBeUndefined();
  });

  it('SKIPS a named row that still carries a v1 estimate, and leaves the estimate to the migration', async () => {
    // Re-estimating it would re-pin it; withdrawing it here would strand
    // promote.place's link on a row that stage can no longer select. The
    // detail says which of these rows still carry one.
    const h = makeStage([
      loadedRow(1, { has_location_name: true, has_coordinates: true, location_source: 'estimated' }),
    ]);

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'has_location_name',
      detail: { locationSource: 'estimated' },
    });
    expect(h.update()).toBeUndefined();
  });

  it('keeps `has_own_location` as the reason when a named row also has a real coordinate', async () => {
    const h = makeStage([
      loadedRow(1, { has_location_name: true, has_coordinates: true, location_source: 'geocoded' }),
    ]);

    expect((await h.stage.run(ctx, [eventId(1)])).get(eventId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'has_own_location',
    });
  });

  it('estimates only the unnamed rows of a mixed slice', async () => {
    const h = makeStage([loadedRow(1), loadedRow(2, { has_location_name: true }), loadedRow(3)], {
      filled: [filledRow(1), filledRow(3)],
    });

    const results = await h.stage.run(ctx, [eventId(1), eventId(2), eventId(3)]);

    expect(results.get(eventId(1))?.outcome).toBe('done');
    expect(results.get(eventId(2))?.reason).toBe('has_location_name');
    expect(results.get(eventId(3))?.outcome).toBe('done');
    // The named row never reaches the write.
    expect((h.update()!.params as [string[]])[0]).toEqual([eventId(1), eventId(3)]);
  });

  it("tests the name with GEOCODE_SOURCE's own expression, in the load and again in the write", async () => {
    const h = makeStage([loadedRow(1)]);

    await h.stage.run(ctx, [eventId(1)]);

    // The load decides; the write re-checks, so a name that lands between the
    // two still wins — the same shape as the is_predicted guard.
    expect(h.statements[0].sql).toMatch(
      /\(e\.location_name IS NOT NULL AND btrim\(e\.location_name\) <> ''\) AS has_location_name/i,
    );
    expect(h.update()!.sql).toMatch(
      /AND \(tgt\.location_name IS NULL OR btrim\(tgt\.location_name\) = ''\)/i,
    );
  });

  it('is decided per row, not by the sweep — the predicate still offers named rows', async () => {
    // A recorded skip is countable and a generation bump re-opens it; a
    // filtered-out row is neither. eventLocationProducers.spec.ts refuses a
    // `location_name IS NULL` test in any ci.events predicate for that reason.
    const { stage } = makeStage();

    expect(stage.source.predicate).not.toMatch(/location_name/i);
  });
});

/* ===================================================================== *
 * Against the real database
 * ===================================================================== */

/**
 * The part a fake `DataSource` structurally cannot check.
 *
 * This stage's write is one statement carrying a correlated `CROSS JOIN LATERAL`
 * over `ci.position` and `ci.events`, a parenthesized `UNION ALL` whose per-branch
 * `LIMIT` decides the donor, a jsonb merge, a CHECK-constraint guard, and a
 * `RETURNING` the caller reads to decide every id's outcome. A double agrees with
 * all of it unconditionally — and the return SHAPE of that statement is exactly
 * how this stage first reported every successfully-filled row as
 * `skipped: no_donor_in_window` (see the CTE regression test above).
 *
 * Everything happens inside ONE transaction that is ALWAYS rolled back, so the
 * dev database is untouched — including `ci.pipeline_state`, written here for
 * real. The suite SKIPS (never silently passes) when no database is reachable;
 * see `__tests__/harness/README.md` on why that decision must be synchronous.
 */
const availability = databaseAvailability();
const describeIfDb = availability.available ? describe : describe.skip;

describeIfDb(`EstimateLocationStage — against real Postgres (${availability.reason})`, () => {
  let dataSource: DataSource;
  let runner: ReturnType<DataSource['createQueryRunner']>;
  let schemaLock: SchemaLock | null = null;
  let realUserId: string;

  /**
   * Fixture ids: random per run (two suites may share the database and neither
   * may collide) but under a prefix that sorts ABOVE every real id.
   *
   * The appliance's own ids are uuid v7, so they all begin `019…`; these begin
   * `fff…`. The sweep pages by keyset in id order and a slice is bounded, so with
   * ~3,100 applicable rows in the real corpus a fixture at a random position
   * would simply fall off the end of the first page. Starting the sweep from
   * {@link FIXTURE_CURSOR} jumps straight to them — using the sweep's OWN
   * pagination rather than a test-only shortcut around it.
   */
  const FIXTURE_PREFIX = 'ffffffff-ffff-4fff-bfff-';
  const FIXTURE_CURSOR = `${FIXTURE_PREFIX}000000000000`;
  const fixtureId = () => `${FIXTURE_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const candidateId = fixtureId();
  const donorId = fixtureId();
  const farCandidateId = fixtureId();

  /** Googleplex, as the donor carries it. */
  const DONOR = { lat: 37.4224, lng: -122.0841 };

  const transactionalDataSource = () => ({
    query: (sql: string, params?: unknown[]) => runner.query(sql, params),
  });

  const makeRealStage = () =>
    new EstimateLocationStage(transactionalDataSource() as never, makeLogger() as never);

  beforeAll(async () => {
    const connection = resolveConnection()!;

    dataSource = new DataSource({
      type: 'postgres',
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
      database: connection.database,
      entities: [],
      synchronize: false,
      logging: false,
    });

    await dataSource.initialize();

    // SHARED: this suite holds row locks on shared `ci.*` tables for the length
    // of its transaction. Shared holders never block each other, so this only
    // ever waits on a suite applying a migration.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'EstimateLocationStage');
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    realUserId = await createSyntheticTestUser(
      (sql, params) => runner.query(sql, params),
      'EstimateLocationStage',
    );

    // A candidate with no location of its own, and a donor five minutes later
    // carrying a REAL coordinate.
    // An event is a CTI aggregate: the base row in ci.entities owns the title
    // and the FK makes it mandatory. Seeded base-first, which needs no help
    // from the constraint's deferral.
    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties,
                                owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', 'pipeline spec candidate', '{}'::jsonb, $2, 'events', $1),
              ($3, 'Event', 'pipeline spec far candidate', '{}'::jsonb, $2, 'events', $3)`,
      [candidateId, realUserId, farCandidateId],
    );
    await runner.query(
      `INSERT INTO ci.events (event_id, user_id, start_time, source_system,
                              is_deleted, is_predicted)
       VALUES ($1, $2, now(), 'calendar', false, false),
              ($3, $2, now() + interval '30 hours', 'calendar', false, false)`,
      [candidateId, realUserId, farCandidateId],
    );
    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties,
                                owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', 'pipeline spec donor', '{}'::jsonb, $2, 'events', $1)`,
      [donorId, realUserId],
    );
    await runner.query(
      `INSERT INTO ci.events (event_id, user_id, start_time, source_system,
                              is_deleted, is_predicted, location_coordinates)
       VALUES ($1, $2, now() + interval '5 minutes', 'calendar', false, false,
               ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography)`,
      [donorId, realUserId, DONOR.lng, DONOR.lat],
    );
  });

  afterAll(async () => {
    if (runner != null) {
      await runner.rollbackTransaction();
      await runner.release();
    }

    // Before `destroy()`: the lock is held on a runner from this pool.
    await schemaLock?.release();

    if (dataSource != null) {
      await dataSource.destroy();
    }
  });

  it('fills the candidate from its nearest real donor, with the full inference_sources', async () => {
    const results = await makeRealStage().run({ userId: realUserId }, [candidateId]);

    expect(results.get(candidateId)).toMatchObject({
      outcome: 'done',
      confidence: ESTIMATED_CONFIDENCE,
      detail: { donor: 'event', donorId, deltaSeconds: 300 },
    });

    const [row] = await runner.query(
      `SELECT ST_Y(location_coordinates::geometry) AS lat,
              ST_X(location_coordinates::geometry) AS lng,
              is_inferred,
              confidence_score,
              metadata->>'location_source' AS location_source,
              inference_sources
         FROM ci.events
        WHERE event_id = $1`,
      [candidateId],
    );

    expect(Number(row.lat)).toBeCloseTo(DONOR.lat, 4);
    expect(Number(row.lng)).toBeCloseTo(DONOR.lng, 4);
    expect(row.is_inferred).toBe(true);
    expect(Number(row.confidence_score)).toBe(ESTIMATED_CONFIDENCE);
    expect(row.location_source).toBe('estimated');
    expect(row.inference_sources).toMatchObject({
      method: 'temporal_nn',
      donor: 'event',
      donor_id: donorId,
      delta_seconds: 300,
      max_gap_hours: ESTIMATE_MAX_GAP_HOURS,
    });
  });

  it('REFUSES to seed an estimate from the estimate it just wrote', async () => {
    // THE INVARIANT, against real Postgres. The far candidate is 30 hours from
    // the real donor (outside the window) but only ~30 hours from... nothing else
    // except the row estimated above, which is 30 hours away too — and even if it
    // were adjacent, the donor clause excludes it. Chaining would make the map a
    // random walk whose error nothing records.
    const results = await makeRealStage().run({ userId: realUserId }, [farCandidateId]);

    expect(results.get(farCandidateId)).toEqual({
      outcome: 'skipped',
      reason: 'no_donor_in_window',
    });

    const [row] = await runner.query(
      `SELECT location_coordinates IS NULL AS still_empty FROM ci.events WHERE event_id = $1`,
      [farCandidateId],
    );

    expect(row.still_empty).toBe(true);
  });

  it('SKIPS the donor itself, which owns a real location', async () => {
    const results = await makeRealStage().run({ userId: realUserId }, [donorId]);

    expect(results.get(donorId)).toMatchObject({ outcome: 'skipped', reason: 'has_own_location' });
  });

  it('re-selects the estimated row after a bump — what `forced` used to do by hand', async () => {
    // The headline property against the real ledger: the row now HAS coordinates
    // and a `done` row at the current version, so the sweep passes over it; move
    // the version and it comes back, coordinates and all.
    const stage = makeRealStage();
    const ledger = new PipelineStateService(transactionalDataSource() as never, makeLogger() as never);

    // Also the proof that this stage's applicability predicate — an interpolated
    // literal including the source-system allowlist — is valid SQL over the real
    // ci.events.
    const before = await ledger.selectStale(stage as never, realUserId, FIXTURE_CURSOR, 500);
    expect(before).toContain(candidateId);

    await ledger.complete(
      stage as never,
      ENTITY_TYPE,
      new Map<string, StageResult>([[candidateId, { outcome: 'done', confidence: ESTIMATED_CONFIDENCE }]]),
    );

    const atCurrent = await ledger.selectStale(stage as never, realUserId, FIXTURE_CURSOR, 500);
    expect(atCurrent).not.toContain(candidateId);

    const afterBump = await ledger.selectStale(
      atVersion(stage, stage.version + 1) as never,
      realUserId,
      FIXTURE_CURSOR,
      500,
    );
    expect(afterBump).toContain(candidateId);
  });
});
