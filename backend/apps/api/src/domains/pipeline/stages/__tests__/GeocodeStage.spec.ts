import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { databaseAvailability, resolveConnection } from '../../__tests__/harness/pipelineHarness';
import { PipelineStateService } from '../../services/PipelineStateService';
import type { StageResult } from '../../types';
import {
  ENRICH_GEOCODE_STAGE_ID,
  FORWARD_GEOCODE_PROVIDER_GENERATION,
  GEOCODE_RESULT_RULE_GENERATION,
  GEOCODE_VERSION,
  GeocodeStage,
  geocodeStageVersion,
  OVERWRITABLE_LOCATION_SOURCES,
  queryKey,
} from '../enrich/GeocodeStage';

/**
 * `enrich.geocode` — `GeocodeBatchListener`'s forward sweep, on the ledger.
 *
 * Three halves, and the split is the whole argument for the rebuild:
 *
 *  1. **Selection** (`PipelineStateService.selectStale` driven with THIS stage's
 *     real `source`) — proves candidacy is decided by `ci.pipeline_state` and
 *     never by `ci.events.location_coordinates`. The listener's predicate is
 *     `location_coordinates IS NULL` and its own comment states the consequence:
 *     *"a resolved coordinate is never re-billed"* — so an unresolvable string is
 *     re-sent to a metered provider forever, and a coarse city-centroid hit can
 *     never be improved.
 *  2. **Decision** (`stage.run`) — proves every id gets exactly one answer, that
 *     no non-`done` answer is anonymous, and that the transient/permanent split
 *     lands on the right side of `failed` vs `skipped`. Getting that backwards
 *     costs money in one direction and coverage in the other.
 *  3. **Ownership** — proves the stage refuses to overwrite coordinates it did
 *     not write. `ci.events.location_coordinates` has several writers, and on the
 *     appliance this was written against 76 of the 95 named events carry
 *     importer-supplied coordinates at confidence 1.0. A stage that overwrote
 *     unconditionally would replace them with a provider centroid at 0.4.
 *
 * The tests are written against the CONTRACT, not the implementation. Most of them
 * need no Postgres: the fake `DataSource` recognises the sweep by its `LEFT JOIN
 * ci.pipeline_state` and evaluates THE ONE RULE in TypeScript from the six bound
 * parameters, so the assertions cover which rows come back for which ledger
 * states rather than a SQL string.
 *
 * The last block DOES need one, because a fake agrees with whatever SQL it is
 * handed. It runs the stage and the real ledger against the dev database inside a
 * transaction that is always rolled back, and SKIPS — never silently passes —
 * when no database is reachable.
 */

/* ===================================================================== *
 * Fixtures
 * ===================================================================== */

const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';
const ENTITY_TYPE = 'event';

/**
 * Ordered uuids. Canonical lowercase hex uuids compare byte-wise in Postgres and
 * lexically in JS in the SAME order, so the fake's keyset comparison is a
 * faithful stand-in for `s."event_id" > $5::uuid`.
 */
function eventId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Googleplex. */
const MOUNTAIN_VIEW = { lat: 37.4224, lng: -122.0841 };

interface SourceRow {
  id: string;
  user_id: string;
  location_name: string | null;
  is_deleted: boolean | null;
  /** The stage's OUTPUT columns. Nothing in selection may ever read these. */
  has_coordinates: boolean;
  confidence_score: number | null;
}

function eventRow(n: number, overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: eventId(n),
    user_id: USER,
    location_name: '1600 Amphitheatre Pkwy, Mountain View, CA',
    is_deleted: false,
    has_coordinates: false,
    confidence_score: null,
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

/** What `GeocodeService.geocode` hands back, in each shape that matters. */
function okOutcome(
  point = MOUNTAIN_VIEW,
  confidence = 0.95,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: 'OK',
    // PostGIS / GeoJSON order: [lng, lat].
    point: { type: 'Point', coordinates: [point.lng, point.lat] },
    confidence,
    cached: false,
    retryable: false,
    lowConfidence: confidence <= 0.4,
    normalizedAddress: '1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA',
    locationType: 'ROOFTOP',
    placeId: 'p1',
    components: null,
    ...extra,
  };
}

function permanentOutcome(status: string) {
  return { status, point: null, confidence: null, cached: true, retryable: false };
}

function transientOutcome(status: string) {
  return { status, point: null, confidence: null, cached: false, retryable: true };
}

function virtualOutcome() {
  return { status: 'virtual', point: null, confidence: null, cached: false, retryable: false };
}

/** A row as {@link GeocodeStage.loadRows} projects it. */
interface LoadedRow {
  id: string;
  location_name: string | null;
  has_coordinates: boolean;
  location_source: string | null;
  is_deleted: boolean | null;
}

function loadedRow(n: number, overrides: Partial<LoadedRow> = {}): LoadedRow {
  return {
    id: eventId(n),
    location_name: '1600 Amphitheatre Pkwy, Mountain View, CA',
    has_coordinates: false,
    location_source: null,
    is_deleted: false,
    ...overrides,
  };
}

interface StageHarness {
  stage: GeocodeStage;
  geocode: jest.Mock;
  /** Every statement the stage issued, in order. */
  statements: Array<{ sql: string; params: unknown[] }>;
  /** The single bulk UPDATE, if one was issued. */
  update(): { sql: string; params: unknown[] } | undefined;
}

/**
 * The stage with its two collaborators stubbed. The fake `DataSource` answers the
 * slice load from `rows` and records the write; the geocode service resolves
 * everything to Mountain View unless a test says otherwise.
 */
function makeStage(rows: LoadedRow[] = [], opts: { writeError?: Error } = {}): StageHarness {
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

    return [];
  });

  const geocode = jest.fn(async () => okOutcome());

  const stage = new GeocodeStage({ query } as never, { geocode } as never, makeLogger() as never);

  return {
    stage,
    geocode,
    statements,
    update: () => statements.find((statement) => /^update/i.test(statement.sql)),
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
 * Kept faithful to `GEOCODE_SOURCE.predicate`: a live event carrying free text
 * worth resolving. Note what it does NOT consult — `location_coordinates`,
 * `confidence_score`, or `metadata->>'location_source'`. That absence is the fix,
 * and the assertions below make it observable rather than taking the fake's word
 * for it.
 */
function isApplicable(row: SourceRow): boolean {
  return row.location_name != null && row.location_name.trim() !== '' && (row.is_deleted ?? false) === false;
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

      // p.stage_version < $4 — the provider or the rule improved since this row
      // was answered.
      if (entry.stageVersion < version) {
        return true;
      }

      // (p.status = 'failed' AND p.next_attempt_at <= now()) — retry is due. A
      // NULL gate makes the comparison NULL, i.e. NOT selected.
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

    // The sweep is the only statement that LEFT JOINs the ledger onto a source.
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
 * The real stage, at a different version.
 *
 * `STAGE_VERSIONS` is the production declaration and a test must not mutate it,
 * so the bump is modelled by handing the sweep the same id, entity types and
 * SOURCE with a higher version — which is exactly what incrementing
 * `FORWARD_GEOCODE_PROVIDER_GENERATION` (and the matching `versions.ts` line)
 * does to the value the sweep binds as `$4`.
 */
function atVersion(stage: GeocodeStage, version: number) {
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

describe('GeocodeStage — candidate selection asks the LEDGER, not location_coordinates', () => {
  it('selects an event whose coordinates are ALREADY SET when the ledger has never seen it', async () => {
    // The repair `location_coordinates IS NULL` makes impossible. A coordinate
    // written by v1 of this stage — or by the old listener at confidence 0.4 —
    // would otherwise put the row permanently out of reach of a better provider.
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1, { has_coordinates: true, confidence_score: 0.4 })]);

    const ids = await h.service.selectStale(stage as never, USER, null, 10);

    expect(ids).toEqual([eventId(1)]);
  });

  it('never names the output columns in the sweep', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    const sql = h.sweeps[0].sql.toLowerCase();
    expect(sql).not.toMatch(/location_coordinates/);
    expect(sql).not.toMatch(/confidence_score/);
    expect(sql).not.toMatch(/location_source/);
  });

  it('splices the stage applicability predicate verbatim, and it says what a row IS', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    expect(h.sweeps[0].sql).toContain(stage.source.predicate);
    // Applicability, never completion: the predicate must not mention the ledger
    // (StageRegistry rejects that) nor anything this stage writes.
    expect(stage.source.predicate).not.toMatch(
      /location_coordinates|confidence_score|location_source|pipeline_state/i,
    );
  });

  it('excludes unnamed, blank-named, deleted events and another user by applicability alone', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([
      eventRow(1),
      // No free text to resolve: there is nothing for a geocoder to answer.
      eventRow(2, { location_name: null }),
      // Whitespace is not a location. `btrim(...) <> ''` in the predicate.
      eventRow(3, { location_name: '   ' }),
      // Soft-deleted: spending a metered call on a tombstone is pure cost.
      eventRow(4, { is_deleted: true }),
      eventRow(5, { user_id: OTHER_USER }),
      eventRow(6),
    ]);

    const ids = await h.service.selectStale(stage as never, USER, null, 10);

    expect(ids).toEqual([eventId(1), eventId(6)]);
  });

  it('stops re-selecting an unresolvable string — the one that used to be re-billed forever', async () => {
    // The bug this deletes, and here it costs actual money: a location the
    // provider has nothing for stays `location_coordinates IS NULL`, so every run
    // re-sends it to a metered API for as long as the appliance exists.
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1), eventRow(2)]);
    h.seed(
      eventId(1),
      { stageVersion: stage.version, status: 'skipped', reason: 'zero_results', nextAttemptAt: null },
      stage.id,
    );

    const ids = await h.service.selectStale(stage as never, USER, null, 10);

    expect(ids).toEqual([eventId(2)]);
  });

  it('stops re-walking a virtual venue without needing the metadata clause that used to', async () => {
    // `GeocodeBatchListener` adds `metadata->>'location_source' <> 'virtual'` to
    // its candidate query for exactly this, and relaxes it with a `retryNull`
    // request flag. Both are replaced by one ledger row and one integer.
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1, { location_name: 'Zoom' })]);
    h.seed(
      eventId(1),
      { stageVersion: stage.version, status: 'skipped', reason: 'virtual_location', nextAttemptAt: null },
      stage.id,
    );

    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([]);
    // …and the denylist improving re-opens it, which is what `retryNull` was for.
    await expect(
      h.service.selectStale(atVersion(stage, stage.version + 1) as never, USER, null, 10),
    ).resolves.toEqual([eventId(1)]);
  });

  it('leaves a geocoded row alone at the current version and re-selects it after a bump', async () => {
    // The headline property. Row 1 already HAS coordinates and row 2 was skipped;
    // at the current version neither is a candidate, and the instant the version
    // moves both come back — including the skip, because a wrong skip is as
    // repairable as a wrong answer.
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1, { has_coordinates: true, confidence_score: 0.4 }), eventRow(2)]);
    h.seed(
      eventId(1),
      { stageVersion: stage.version, status: 'done', reason: null, nextAttemptAt: null },
      stage.id,
    );
    h.seed(
      eventId(2),
      { stageVersion: stage.version, status: 'skipped', reason: 'zero_results', nextAttemptAt: null },
      stage.id,
    );

    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([]);
    await expect(
      h.service.selectStale(atVersion(stage, stage.version + 1) as never, USER, null, 10),
    ).resolves.toEqual([eventId(1), eventId(2)]);
  });

  it('binds the version off the stage, so bumping a generation is the whole mechanism', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    expect(h.sweeps[0].params[3]).toBe(stage.version);
  });

  it('records the ledger under entity_type "event"', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    expect(h.sweeps[0].params[0]).toBe(ENTITY_TYPE);
    expect(h.sweeps[0].params[1]).toBe(ENRICH_GEOCODE_STAGE_ID);
  });
});

describe('GeocodeStage — the version is DERIVED, so improving the provider re-runs history', () => {
  it('derives the version from the provider and rule generations', () => {
    expect(GEOCODE_VERSION).toBe(FORWARD_GEOCODE_PROVIDER_GENERATION + GEOCODE_RESULT_RULE_GENERATION - 1);
    expect(Number.isInteger(GEOCODE_VERSION)).toBe(true);
    expect(GEOCODE_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('reports the derived version, and the stage reads it rather than hardcoding one', () => {
    const { stage } = makeStage();

    expect(stage.version).toBe(GEOCODE_VERSION);
    expect(geocodeStageVersion({})).toBe(GEOCODE_VERSION);
  });

  it('throws when STAGE_VERSIONS disagrees with the derivation', () => {
    // Bumping a generation without the matching one-line diff to versions.ts
    // otherwise surfaces as StageRegistry complaining about a HARDCODED version,
    // which is not what happened and sends the reader to the wrong file.
    expect(() => geocodeStageVersion({ [ENRICH_GEOCODE_STAGE_ID]: GEOCODE_VERSION + 1 })).toThrow(/derives/i);
  });

  it('accepts a STAGE_VERSIONS entry that agrees, and ignores a thunk', () => {
    expect(geocodeStageVersion({ [ENRICH_GEOCODE_STAGE_ID]: GEOCODE_VERSION })).toBe(GEOCODE_VERSION);
    // A thunk for this stage could only be this very function; invoking one here
    // would recurse forever, and a derivation that IS the declaration cannot
    // disagree with itself.
    expect(geocodeStageVersion({ [ENRICH_GEOCODE_STAGE_ID]: () => 99 })).toBe(GEOCODE_VERSION);
  });
});

describe('GeocodeStage.run — every id gets exactly one answer', () => {
  const ctx = { userId: USER };

  it('writes the coordinate, the provider confidence and the provenance tag', async () => {
    const h = makeStage([loadedRow(1)]);

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'done', confidence: 0.95 });

    const update = h.update();
    expect(update).toBeDefined();

    const [ids, lats, lngs, confidences, sources, userId] = update!.params as [
      string[],
      number[],
      number[],
      number[],
      string[],
      string,
    ];

    expect(ids).toEqual([eventId(1)]);
    expect(lats[0]).toBe(MOUNTAIN_VIEW.lat);
    expect(lngs[0]).toBe(MOUNTAIN_VIEW.lng);
    expect(confidences[0]).toBe(0.95);
    expect(sources[0]).toBe('geocoded');
    expect(userId).toBe(USER);
  });

  it('builds the Point as (lng, lat), the order PostGIS actually stores', async () => {
    // The classic bug in this neighbourhood: GeoJSON is [lng, lat] and every
    // human writes "lat, lng". A transposition puts Mountain View in the Yellow
    // Sea and nothing throws.
    const h = makeStage([loadedRow(1)]);

    await h.stage.run(ctx, [eventId(1)]);

    expect(h.update()!.sql).toMatch(/st_makepoint\(u\.lng,\s*u\.lat\)/i);
  });

  it('tags a coarse centroid as approximate, so it stays distinguishable from a rooftop hit', async () => {
    const h = makeStage([loadedRow(1)]);
    h.geocode.mockResolvedValue(okOutcome(MOUNTAIN_VIEW, 0.4));

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'done', confidence: 0.4 });
    expect((h.update()!.params as [string[], number[], number[], number[], string[]])[4][0]).toBe(
      'approximate',
    );
  });

  it('assigns confidence rather than LEAST()-ing it, or a bump could not raise a bad one', async () => {
    const h = makeStage([loadedRow(1)]);

    await h.stage.run(ctx, [eventId(1)]);

    // `LEAST(existing, new)` would freeze the first — worst — value: a 0.4 city
    // centroid could never become the 0.95 rooftop a better provider returns.
    expect(h.update()!.sql).not.toMatch(/least\(/i);
    expect(h.update()!.sql).toMatch(/confidence_score\s*=\s*u\.confidence/i);
  });

  it('merges metadata instead of replacing it — the jsonb bag is shared', async () => {
    const h = makeStage([loadedRow(1)]);

    await h.stage.run(ctx, [eventId(1)]);

    expect(h.update()!.sql).toMatch(/metadata\s*=\s*coalesce\(e\.metadata/i);
    expect(h.update()!.sql).toMatch(/\|\|\s*jsonb_build_object\('location_source'/i);
  });

  it('SKIPS a string that resolves to nothing WITH a reason, and never writes', async () => {
    const h = makeStage([loadedRow(1)]);
    h.geocode.mockResolvedValue(permanentOutcome('ZERO_RESULTS'));

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'skipped', reason: 'zero_results' });
    expect(h.update()).toBeUndefined();
  });

  it('SKIPS a denylisted virtual venue with its own reason', async () => {
    // "Zoom", "TBD", a dial-in number. GeocodeService never sends these to a
    // provider, so the skip is free — and countable, which the old listener's
    // metadata tag could only approximate.
    const h = makeStage([loadedRow(1, { location_name: 'Zoom' })]);
    h.geocode.mockResolvedValue(virtualOutcome());

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'skipped', reason: 'virtual_location' });
    expect(h.update()).toBeUndefined();
  });

  it('FAILS a transient provider outage so it retries, and SKIPS a permanent refusal so it does not', async () => {
    // The split that decides whether an incident costs coverage or money.
    const transient = makeStage([loadedRow(1)]);
    transient.geocode.mockResolvedValue(transientOutcome('OVER_QUERY_LIMIT'));

    const transientResults = await transient.stage.run(ctx, [eventId(1)]);

    expect(transientResults.get(eventId(1))).toMatchObject({
      outcome: 'failed',
      reason: 'provider_unavailable',
      detail: { status: 'OVER_QUERY_LIMIT' },
    });

    const permanent = makeStage([loadedRow(1)]);
    permanent.geocode.mockResolvedValue(permanentOutcome('REQUEST_DENIED'));

    const permanentResults = await permanent.stage.run(ctx, [eventId(1)]);

    expect(permanentResults.get(eventId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'provider_denied',
    });
  });

  it('FAILS a transport failure, which GeocodeService reports as retryable UNKNOWN_ERROR', async () => {
    const h = makeStage([loadedRow(1)]);
    h.geocode.mockResolvedValue(transientOutcome('UNKNOWN_ERROR'));

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))?.outcome).toBe('failed');
    expect(results.get(eventId(1))?.reason).toBe('provider_unavailable');
  });

  it('SKIPS an INVALID_REQUEST, which is permanent for this string', async () => {
    const h = makeStage([loadedRow(1)]);
    h.geocode.mockResolvedValue(permanentOutcome('INVALID_REQUEST'));

    expect((await h.stage.run(ctx, [eventId(1)])).get(eventId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'invalid_request',
    });
  });

  it('FAILS, rather than guessing permanence, on a status the provider abstraction did not have', async () => {
    const h = makeStage([loadedRow(1)]);
    h.geocode.mockResolvedValue({
      status: 'MYSTERY',
      point: null,
      confidence: null,
      cached: false,
      retryable: false,
    });

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'failed',
      reason: 'provider_status_unrecognized',
    });
  });

  it('SKIPS an OK with no Point, rather than writing a NaN coordinate', async () => {
    const h = makeStage([loadedRow(1)]);
    h.geocode.mockResolvedValue({
      status: 'OK',
      point: null,
      confidence: null,
      cached: false,
      retryable: false,
    });

    expect((await h.stage.run(ctx, [eventId(1)])).get(eventId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'no_coordinates_resolved',
    });
  });

  it('FAILS the resolved rows when the write throws, separately from a provider failure', async () => {
    const h = makeStage([loadedRow(1)], { writeError: new Error('deadlock detected') });

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'failed',
      reason: 'coordinate_write_failed',
    });
  });

  it('costs ONE provider call for a whole slice at the same address', async () => {
    // Without the grouping, 200 concurrent events at one venue all miss the cache
    // in the same instant — the cache row is only written after the first call
    // returns — and 200 identical billed calls go out.
    const rows = Array.from({ length: 12 }, (_, index) => loadedRow(index + 1));
    const h = makeStage(rows);

    const results = await h.stage.run(
      ctx,
      rows.map((row) => row.id),
    );

    expect(h.geocode).toHaveBeenCalledTimes(1);
    expect(results.size).toBe(12);
    expect([...results.values()].every((result) => result.outcome === 'done')).toBe(true);
  });

  it('groups by the CANONICAL query, so punctuation and case cost nothing extra', async () => {
    // The grouping key is `GeocodeService.canonicalize`, which is the cache key's
    // own normalization — so this is exact, not a heuristic.
    expect(queryKey('123 Main St.')).toBe(queryKey('123  main st'));

    const h = makeStage([
      loadedRow(1, { location_name: '123 Main St.' }),
      loadedRow(2, { location_name: '123  main st' }),
      loadedRow(3, { location_name: 'Somewhere else' }),
    ]);

    await h.stage.run(ctx, [eventId(1), eventId(2), eventId(3)]);

    expect(h.geocode).toHaveBeenCalledTimes(2);
  });

  it('answers for an id whose row is gone rather than staying silent', async () => {
    const h = makeStage([]);

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toEqual({ outcome: 'skipped', reason: 'source_row_missing' });
  });

  it('SKIPS a row soft-deleted between the sweep and the slice', async () => {
    const h = makeStage([loadedRow(1, { is_deleted: true })]);

    expect((await h.stage.run(ctx, [eventId(1)])).get(eventId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'event_deleted',
    });
    expect(h.geocode).not.toHaveBeenCalled();
  });

  it('SKIPS a row whose location_name was cleared mid-flight', async () => {
    const h = makeStage([loadedRow(1, { location_name: '   ' })]);

    expect((await h.stage.run(ctx, [eventId(1)])).get(eventId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'no_location_name',
    });
    expect(h.geocode).not.toHaveBeenCalled();
  });

  it('scopes the row load to the slice user', async () => {
    // A slice can arrive from a dead letter replayed weeks later; re-scoping is
    // the difference between "not yours" and billing someone else's calendar.
    const h = makeStage([loadedRow(1)]);

    await h.stage.run({ userId: OTHER_USER }, [eventId(1)]);

    expect(h.statements[0].params[1]).toBe(OTHER_USER);
    expect(h.geocode).not.toHaveBeenCalled();
  });

  it('gives every non-done outcome a reason — the ledger refuses one without', async () => {
    const h = makeStage([loadedRow(1)]);
    h.geocode.mockResolvedValue(permanentOutcome('ZERO_RESULTS'));

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
    // Enforced by the ledger before a single row is written. Pinned here too,
    // because this stage's skips are the ones that stop money being spent and a
    // nameless one is indistinguishable from work that never happened.
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

describe('GeocodeStage.run — it never destroys a coordinate it does not own', () => {
  const ctx = { userId: USER };

  it('SKIPS an importer-supplied coordinate WITHOUT spending a provider call', async () => {
    // 76 of the 95 named events on the appliance this was written against arrive
    // from Google Takeout with the venue's own coordinates at confidence 1.0.
    // Overwriting one with a provider centroid at 0.4 is a worse answer
    // permanently destroying a better one — and paying for the privilege.
    const h = makeStage([loadedRow(1, { has_coordinates: true, location_source: null })]);

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'coordinates_not_owned',
    });
    expect(h.geocode).not.toHaveBeenCalled();
    expect(h.update()).toBeUndefined();
  });

  it('SKIPS a reverse_geocoded row, whose name is DERIVED from its measured fix', async () => {
    // Forward-geocoding a name that was itself produced from the row's
    // coordinates, and writing the answer back, is a round trip that loses
    // precision every single time it runs.
    const h = makeStage([loadedRow(1, { has_coordinates: true, location_source: 'reverse_geocoded' })]);

    expect((await h.stage.run(ctx, [eventId(1)])).get(eventId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'coordinates_not_owned',
    });
    expect(h.geocode).not.toHaveBeenCalled();
  });

  it.each([...OVERWRITABLE_LOCATION_SOURCES])(
    'overwrites a coordinate tagged "%s", which it or a weaker producer wrote',
    async (source) => {
      const h = makeStage([loadedRow(1, { has_coordinates: true, location_source: source })]);

      const results = await h.stage.run(ctx, [eventId(1)]);

      expect(results.get(eventId(1))?.outcome).toBe('done');
      expect(h.update()).toBeDefined();
    },
  );

  it('geocodes a row that has no coordinates at all, whatever its provenance tag says', async () => {
    const h = makeStage([loadedRow(1, { has_coordinates: false, location_source: 'reverse_geocoded' })]);

    expect((await h.stage.run(ctx, [eventId(1)])).get(eventId(1))?.outcome).toBe('done');
  });

  it('declares an ownership set that cannot silently swallow a measured fix', () => {
    // A regression guard on the SET itself: adding `reverse_geocoded` (or any
    // token an importer writes) here would re-open the round trip above, and
    // nothing else in the codebase would notice.
    expect([...OVERWRITABLE_LOCATION_SOURCES].sort()).toEqual([
      'approximate',
      'estimated',
      'geocoded',
      'virtual',
    ]);
  });
});

/* ===================================================================== *
 * Against the real database
 * ===================================================================== */

/**
 * Everything above runs against a fake `DataSource`, which will happily agree
 * that any string is valid SQL. These do not.
 *
 * Two things only Postgres can answer, and both have bitten this change:
 *
 *  - **Is the statement valid, and does it mean what the double pretended?**
 *    The write builds a `geography(Point, 4326)` out of `unnest()`d parallel
 *    arrays and merges a jsonb key; the sweep interpolates this stage's
 *    applicability predicate verbatim into a query over the real `ci.events`.
 *    A typo in either is invisible to every assertion above.
 *  - **Does the ledger actually re-open a row that already has coordinates?**
 *    That is the entire point of the rebuild, it is a property of a JOIN against
 *    `ci.pipeline_state`, and a mock will agree with whatever the sweep asks it.
 *
 * Everything happens inside ONE transaction that is ALWAYS rolled back, so the
 * dev database is untouched — including `ci.pipeline_state`, which is written
 * here for real. The suite SKIPS (never silently passes) when no database is
 * reachable; see `__tests__/harness/README.md` on why that decision has to be
 * made synchronously.
 */
const availability = databaseAvailability();
const describeIfDb = availability.available ? describe : describe.skip;

describeIfDb(`GeocodeStage — against real Postgres (${availability.reason})`, () => {
  let dataSource: DataSource;
  let runner: ReturnType<DataSource['createQueryRunner']>;
  let realUserId: string;

  /**
   * Fixture id: random per run (two suites may share the database and neither may
   * collide) but under a prefix that sorts ABOVE every real id.
   *
   * The appliance's own ids are uuid v7, so they all begin `019…`; this begins
   * `fff…`. The sweep pages by keyset in id order and a slice is bounded, so a
   * fixture at a random position would fall off the end of the first page as the
   * corpus grows. Starting the sweep from {@link FIXTURE_CURSOR} jumps straight to
   * it — using the sweep's OWN pagination rather than a test-only shortcut around
   * it.
   */
  const FIXTURE_PREFIX = 'ffffffff-ffff-4fff-bfff-';
  const FIXTURE_CURSOR = `${FIXTURE_PREFIX}000000000000`;
  const candidateId = `${FIXTURE_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  /** The stage, talking to the open transaction rather than the pool. */
  const transactionalDataSource = () => ({
    query: (sql: string, params?: unknown[]) => runner.query(sql, params),
  });

  function resolvingGeocodeService(confidence = 0.95) {
    return {
      geocode: async () => ({
        status: 'OK',
        point: { type: 'Point', coordinates: [MOUNTAIN_VIEW.lng, MOUNTAIN_VIEW.lat] },
        confidence,
        cached: false,
        retryable: false,
        lowConfidence: confidence <= 0.4,
      }),
    };
  }

  beforeAll(async () => {
    const connection = resolveConnection()!;

    dataSource = new DataSource({
      type: 'postgres',
      // Discrete fields rather than a URL, so a password containing URL
      // metacharacters (the dev one ends in `!`) never has to survive a round
      // trip through percent-encoding.
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
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    // `ci.events.user_id` has a FK to `ci.users`, so the fixture has to belong to
    // a real user. Nothing about the user is asserted.
    const users = await runner.query(`SELECT id FROM ci.users LIMIT 1`);
    realUserId = users[0].id;

    await runner.query(
      `INSERT INTO ci.events (event_id, user_id, start_time, title, source_system,
                              is_deleted, is_predicted, location_name)
       VALUES ($1, $2, now(), 'pipeline spec fixture', 'calendar', false, false,
               '1600 Amphitheatre Pkwy, Mountain View, CA')`,
      [candidateId, realUserId],
    );
  });

  afterAll(async () => {
    if (runner != null) {
      await runner.rollbackTransaction();
      await runner.release();
    }

    if (dataSource != null) {
      await dataSource.destroy();
    }
  });

  it('writes a real geography Point, the provider confidence and the provenance tag', async () => {
    const stage = new GeocodeStage(
      transactionalDataSource() as never,
      resolvingGeocodeService() as never,
      makeLogger() as never,
    );

    const results = await stage.run({ userId: realUserId }, [candidateId]);

    expect(results.get(candidateId)).toMatchObject({ outcome: 'done', confidence: 0.95 });

    const [row] = await runner.query(
      `SELECT ST_Y(location_coordinates::geometry) AS lat,
              ST_X(location_coordinates::geometry) AS lng,
              confidence_score,
              metadata->>'location_source' AS location_source
         FROM ci.events
        WHERE event_id = $1`,
      [candidateId],
    );

    // Round-tripped through PostGIS, so a transposed [lat, lng] would land in the
    // Yellow Sea and be caught here rather than in production.
    expect(Number(row.lat)).toBeCloseTo(MOUNTAIN_VIEW.lat, 4);
    expect(Number(row.lng)).toBeCloseTo(MOUNTAIN_VIEW.lng, 4);
    expect(Number(row.confidence_score)).toBe(0.95);
    expect(row.location_source).toBe('geocoded');
  });

  it('re-selects that row after a version bump even though it now HAS coordinates', async () => {
    // THE HEADLINE PROPERTY, against real Postgres and the real ledger: the row
    // written by the test above is `done` at the current version, so a second
    // sweep skips it — and the instant the version moves it comes back, WITH its
    // coordinates still in place. `location_coordinates IS NULL` cannot express
    // that, which is the whole reason this subsystem exists.
    const stage = new GeocodeStage(
      transactionalDataSource() as never,
      resolvingGeocodeService() as never,
      makeLogger() as never,
    );
    const ledger = new PipelineStateService(transactionalDataSource() as never, makeLogger() as never);

    // Interpolates this stage's predicate into a query over the real ci.events —
    // which is also what proves the predicate is valid SQL against that table.
    const beforeLedger = await ledger.selectStale(stage as never, realUserId, FIXTURE_CURSOR, 500);
    expect(beforeLedger).toContain(candidateId);

    await ledger.complete(
      stage as never,
      ENTITY_TYPE,
      new Map<string, StageResult>([[candidateId, { outcome: 'done' }]]),
    );

    const atCurrentVersion = await ledger.selectStale(stage as never, realUserId, FIXTURE_CURSOR, 500);
    expect(atCurrentVersion).not.toContain(candidateId);

    const afterBump = await ledger.selectStale(
      atVersion(stage, stage.version + 1) as never,
      realUserId,
      FIXTURE_CURSOR,
      500,
    );
    expect(afterBump).toContain(candidateId);
  });

  it('records a permanent provider answer as a skip that is never re-billed', async () => {
    // The other half: `zero_results` is terminal at this version, so the metered
    // provider is not asked again until someone decides it should be.
    const stage = new GeocodeStage(
      transactionalDataSource() as never,
      { geocode: async () => permanentOutcome('ZERO_RESULTS') } as never,
      makeLogger() as never,
    );
    const ledger = new PipelineStateService(transactionalDataSource() as never, makeLogger() as never);

    const results = await stage.run({ userId: realUserId }, [candidateId]);
    expect(results.get(candidateId)).toMatchObject({ outcome: 'skipped', reason: 'zero_results' });

    await ledger.complete(stage as never, ENTITY_TYPE, results);

    const [row] = await runner.query(
      `SELECT status, reason, stage_version
         FROM ci.pipeline_state
        WHERE entity_type = $1 AND entity_id = $2 AND stage = $3`,
      [ENTITY_TYPE, candidateId, stage.id],
    );

    expect(row).toMatchObject({ status: 'skipped', reason: 'zero_results' });
    expect(Number(row.stage_version)).toBe(stage.version);

    const afterSkip = await ledger.selectStale(stage as never, realUserId, FIXTURE_CURSOR, 500);
    expect(afterSkip).not.toContain(candidateId);
  });
});
