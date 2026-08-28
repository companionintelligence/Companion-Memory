import { PipelineStateService } from '../../services/PipelineStateService';
import {
  cellKey,
  EVENT_REVERSE_RULE_GENERATION,
  EVENT_REVERSE_SOURCE,
  EVENT_REVERSE_VERSION,
  EventReverseStage,
  eventReverseStageVersion,
  NAME_OWNERSHIP_SOURCES,
} from '../enrich/EventReverseStage';
import { REVERSE_GEOCODE_PROVIDER_GENERATION } from '../enrich/PositionReverseStage';

/**
 * `enrich.event_reverse` — the coordinate → name half of `ci.events`, which had
 * no scheduled producer at all.
 *
 * ── What was broken ────────────────────────────────────────────────────────
 *
 * `enrich.geocode` runs one direction only. An event that arrived with a
 * MEASUREMENT and no label — photo EXIF GPS, a GPX check-in, a geotagged post —
 * could only be named by `MaintenanceOrchestratorService`'s operator-triggered
 * reverse leg or the `reverse_geocode` CLI backfill, neither of which is on a
 * cron or chained from an import. And `promote.place` requires a coordinate AND
 * a non-blank name, so those events never became places and never reached the
 * map. On the appliance this was written against: 91 events carried coordinates,
 * 79 of them unnamed, 2 linked to a place.
 *
 * `__tests__/eventLocationProducers.spec.ts` is the standing guard on the GAP
 * (discovered off disk, so it notices a producer that is deleted or narrowed
 * later). This file is the guard on the stage's DECISIONS, in three parts:
 *
 *  1. **Selection** — candidacy is decided by `ci.pipeline_state`, never by
 *     `ci.events.location_name`. `GeocodeBatchListener.selectReverseCandidates`
 *     uses `location_name IS NULL` and says so in its own comment (*"a resolved
 *     row now HAS a name and drops out of the candidate set"*), which freezes
 *     the first label any provider ever produced for a coordinate.
 *  2. **Ownership** — the stage refuses to overwrite a name it did not write.
 *     `ci.events.location_name` has many writers (calendar invites, Takeout
 *     venues, the user), and every one of them is a BETTER name than a
 *     provider's formatted address.
 *  3. **Decision** — every id gets exactly one answer, no non-`done` answer is
 *     anonymous, and the transient/permanent split lands on the right side of
 *     `failed` vs `skipped`. Getting that backwards costs money in one direction
 *     and coverage in the other.
 *
 * The tests are written against the CONTRACT. The fake `DataSource` recognises
 * the sweep by its `ci.pipeline_state` join and evaluates THE ONE RULE in
 * TypeScript from the six bound parameters, so the assertions cover which rows
 * come back for which ledger states rather than a SQL string.
 */

/* ===================================================================== *
 * Fixtures
 * ===================================================================== */

const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';
const ENTITY_TYPE = 'event';
const STAGE_ID = 'enrich.event_reverse';

/**
 * Ordered uuids. Canonical lowercase hex uuids compare byte-wise in Postgres and
 * lexically in JS in the SAME order, so the fake's keyset comparison is a
 * faithful stand-in for `s."event_id" > $5::uuid`.
 */
function eventId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Googleplex, and a point ~2 m away — inside the same ~11 m cache cell. */
const MOUNTAIN_VIEW = { lat: 37.4224, lng: -122.0841 };
const MOUNTAIN_VIEW_NEXT_DOOR = { lat: 37.42241, lng: -122.08411 };
const GOOGLEPLEX = '1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA';

interface SourceRow {
  id: string;
  user_id: string;
  has_coordinates: boolean;
  is_deleted: boolean | null;
  /** The stage's OUTPUT column. Nothing in selection may ever read it. */
  location_name: string | null;
}

function eventRow(n: number, overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: eventId(n),
    user_id: USER,
    has_coordinates: true,
    is_deleted: false,
    location_name: null,
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

/** What `GeocodeService.reverseGeocode` hands back, in each shape that matters. */
function okOutcome(placeName: string | null = GOOGLEPLEX): Record<string, unknown> {
  return { status: 'OK', placeName, cached: false, retryable: false, components: null };
}

function permanentOutcome(status: string) {
  return { status, placeName: null, cached: true, retryable: false };
}

function transientOutcome(status: string) {
  return { status, placeName: null, cached: false, retryable: true };
}

/** A row as {@link EventReverseStage.loadRows} projects it. */
interface LoadedRow {
  id: string;
  lat: number | string | null;
  lng: number | string | null;
  location_name: string | null;
  location_source: string | null;
  is_deleted: boolean | null;
}

function loadedRow(n: number, overrides: Partial<LoadedRow> = {}): LoadedRow {
  return {
    id: eventId(n),
    lat: MOUNTAIN_VIEW.lat,
    lng: MOUNTAIN_VIEW.lng,
    location_name: null,
    location_source: null,
    is_deleted: false,
    ...overrides,
  };
}

interface StageHarness {
  stage: EventReverseStage;
  reverseGeocode: jest.Mock;
  sendMany: jest.Mock;
  /** Every statement the stage issued, in order. */
  statements: Array<{ sql: string; params: unknown[] }>;
  /** The single bulk UPDATE, if one was issued. */
  update(): { sql: string; params: unknown[] } | undefined;
}

/**
 * The stage with its three collaborators stubbed. The fake `DataSource` answers
 * the slice load from `rows` and records the write; the geocode service resolves
 * every coordinate to the Googleplex unless a test says otherwise.
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

  const reverseGeocode = jest.fn(async () => okOutcome());
  const sendMany = jest.fn(async () => undefined);

  const stage = new EventReverseStage(
    { query } as never,
    { reverseGeocode } as never,
    makeLogger() as never,
    { sendMany } as never,
  );

  return {
    stage,
    reverseGeocode,
    sendMany,
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
 * Faithful to `EVENT_REVERSE_SOURCE.predicate`: a live event carrying a
 * coordinate. Note what it does NOT consult — `location_name`, the column this
 * stage writes. That absence is the fix, and the assertions below make it
 * observable rather than taking the fake's word for it.
 */
function isApplicable(row: SourceRow): boolean {
  return row.has_coordinates && (row.is_deleted ?? false) === false;
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

  const query = jest.fn(async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim();

    // The sweep is the only statement that joins the ledger onto a source.
    if (/not\s+exists[\s\S]*ci\.pipeline_state/i.test(sql)) {
      sweeps.push({ sql, params: params ?? [] });

      return evaluateOneRule(rows, ledger, params ?? []);
    }

    return [];
  });

  const service = new PipelineStateService({ query } as never, makeLogger() as never);

  return {
    service,
    sweeps,
    seed: (entityId: string, row: LedgerRow) => ledger.set(ledgerKey(ENTITY_TYPE, entityId, STAGE_ID), row),
  };
}

/**
 * The real stage, at a different version.
 *
 * `STAGE_VERSIONS` is the production declaration and a test must not mutate it,
 * so the bump is modelled by handing the sweep the same id, entity types and
 * SOURCE with a higher version — exactly what incrementing
 * `EVENT_REVERSE_RULE_GENERATION` (and the matching `versions.ts` line) does to
 * the value the sweep binds as `$4`.
 */
function atVersion(stage: EventReverseStage, version: number) {
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

describe('EventReverseStage — candidate selection asks the LEDGER, not location_name', () => {
  it('selects an event that ALREADY HAS a name when the ledger has never seen it', async () => {
    // The repair `location_name IS NULL` makes impossible. A label written by v1
    // of this stage — or by the old listener's reverse leg — would otherwise put
    // the row permanently out of reach of a better provider. (Whether the stage
    // then WRITES it is the ownership rule's business, and is asserted below;
    // selection and applicability are not the same question.)
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1, { location_name: 'Somewhere' })]);

    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([eventId(1)]);
  });

  it('never names the output column in the sweep', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    const sql = h.sweeps[0].sql.toLowerCase();
    expect(sql).not.toMatch(/location_name/);
    expect(sql).not.toMatch(/location_source/);
    expect(sql).not.toMatch(/location_entity_id/);
  });

  it('splices the applicability predicate verbatim, and it says what a row IS', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    expect(h.sweeps[0].sql).toContain(stage.source.predicate);
    // Applicability, never completion: the predicate must not mention the ledger
    // (StageRegistry rejects that) nor anything this stage writes.
    expect(stage.source.predicate).not.toMatch(/location_name|location_source|pipeline_state/i);
    expect(stage.source.predicate).toMatch(/location_coordinates IS NOT NULL/i);
  });

  it('excludes coordinate-less events, tombstones and another user by applicability alone', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([
      eventRow(1),
      // Nothing to reverse: there is no coordinate to ask a geocoder about.
      eventRow(2, { has_coordinates: false }),
      // Soft-deleted: spending a metered call on a tombstone is pure cost.
      eventRow(3, { is_deleted: true }),
      eventRow(4, { user_id: OTHER_USER }),
      eventRow(5),
    ]);

    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([
      eventId(1),
      eventId(5),
    ]);
  });

  it('stops re-billing an unnameable coordinate, and a bump re-opens it', async () => {
    // Mid-ocean, Antarctic ice, an unmapped track. Under `location_name IS NULL`
    // every one of those is re-sent to a METERED provider on every run forever,
    // because "nothing there" and "never tried" are the same NULL.
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1), eventRow(2)]);
    h.seed(eventId(1), {
      stageVersion: stage.version,
      status: 'skipped',
      reason: 'zero_results',
      nextAttemptAt: null,
    });

    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([eventId(2)]);
    // …and a provider with better rural coverage gets to answer again.
    await expect(
      h.service.selectStale(atVersion(stage, stage.version + 1) as never, USER, null, 10),
    ).resolves.toEqual([eventId(1), eventId(2)]);
  });

  it('records the ledger under entity_type "event", at the stage version', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([eventRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    expect(h.sweeps[0].params[0]).toBe(ENTITY_TYPE);
    expect(h.sweeps[0].params[1]).toBe(STAGE_ID);
    expect(h.sweeps[0].params[3]).toBe(stage.version);
  });
});

describe('EventReverseStage — the version is DERIVED from the SHARED provider generation', () => {
  it('derives the version from the reverse provider and this stage rule', () => {
    expect(EVENT_REVERSE_VERSION).toBe(
      REVERSE_GEOCODE_PROVIDER_GENERATION + EVENT_REVERSE_RULE_GENERATION - 1,
    );
    expect(Number.isInteger(EVENT_REVERSE_VERSION)).toBe(true);
    expect(EVENT_REVERSE_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('shares the provider generation with enrich.position_reverse rather than re-declaring one', () => {
    // The coupling is the point: "what does this coordinate resolve to?" is ONE
    // question with one answer and two callers, so swapping the provider must
    // re-open both tables or neither. A private copy of the constant here would
    // let `ci.position` be repaired and `ci.events` silently not.
    expect(REVERSE_GEOCODE_PROVIDER_GENERATION).toBeGreaterThanOrEqual(1);
    expect(EVENT_REVERSE_VERSION).toBeGreaterThanOrEqual(REVERSE_GEOCODE_PROVIDER_GENERATION);
  });

  it('reports the derived version, and the stage reads it rather than hardcoding one', () => {
    const { stage } = makeStage();

    expect(stage.version).toBe(EVENT_REVERSE_VERSION);
    expect(eventReverseStageVersion({})).toBe(EVENT_REVERSE_VERSION);
  });

  it('throws when STAGE_VERSIONS disagrees with the derivation', () => {
    // Bumping a generation without the matching one-line diff to versions.ts
    // otherwise surfaces as StageRegistry complaining about a HARDCODED version,
    // which is not what happened and sends the reader to the wrong file.
    expect(() => eventReverseStageVersion({ [STAGE_ID]: EVENT_REVERSE_VERSION + 1 })).toThrow(/derives/i);
    expect(() => eventReverseStageVersion({ [STAGE_ID]: EVENT_REVERSE_VERSION })).not.toThrow();
  });
});

describe('EventReverseStage.run — ownership decides what is written, and it is decided for free', () => {
  const ctx = { userId: USER };

  it('refuses a name it did not write, BEFORE any provider call', async () => {
    // A calendar room, a Takeout venue, a name the user typed. Every one of them
    // is better than a provider's formatted address, and overwriting them is the
    // failure `types.ts` warns about: a worse answer destroying a better one.
    const h = makeStage([loadedRow(1, { location_name: "Mum's" })]);

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'name_not_owned',
    });
    // The protection is also a cost saving: the row never reached the provider,
    // and nothing was written.
    expect(h.reverseGeocode).not.toHaveBeenCalled();
    expect(h.update()).toBeUndefined();
  });

  it('DOES replace a name it wrote itself, so a better provider can repair it', async () => {
    // The other half of ownership, and the reason it is expressed as a set
    // rather than as `location_name IS NULL`: a row this stage answered at v1
    // must be repairable at v2, which requires overwriting.
    const h = makeStage([
      loadedRow(1, { location_name: 'Mountain View, CA', location_source: 'reverse_geocoded' }),
    ]);

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'done' });
    expect(h.reverseGeocode).toHaveBeenCalledTimes(1);
    expect(NAME_OWNERSHIP_SOURCES.has('reverse_geocoded')).toBe(true);
  });

  it('refuses to name an ESTIMATED coordinate', async () => {
    // `enrich.estimate_location` copies a temporal neighbour's coordinate onto a
    // row precisely because it had none of its own. Naming it would turn "you
    // were probably somewhere near here" into "you were at this venue", and
    // `promote.place` would then mint a place link off the back of it — a
    // fabricated visit nothing downstream could tell from a measured one.
    const h = makeStage([loadedRow(1, { location_source: 'estimated' })]);

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'coordinates_estimated',
    });
    expect(h.reverseGeocode).not.toHaveBeenCalled();
  });

  it('treats a blank name as no name, not as a name it must protect', async () => {
    // `btrim(...) <> ''` is what `promote.place` demands of the column, so a
    // whitespace-only label leaves the event just as unpromotable as a NULL.
    const h = makeStage([loadedRow(1, { location_name: '   ' })]);

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'done' });
  });
});

describe('EventReverseStage.run — every id gets exactly one answer', () => {
  const ctx = { userId: USER };

  it('writes the name and stamps the provenance the forward stage refuses to overwrite', async () => {
    const h = makeStage([loadedRow(1)]);

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'done',
      detail: { locationName: GOOGLEPLEX },
    });

    const update = h.update();
    expect(update).toBeDefined();

    const [userId, locationSource, ids, names] = update!.params as [string, string, string[], string[]];

    expect(userId).toBe(USER);
    expect(ids).toEqual([eventId(1)]);
    expect(names).toEqual([GOOGLEPLEX]);
    // `reverse_geocoded` is the token `GeocodeStage` deliberately leaves OUT of
    // OVERWRITABLE_LOCATION_SOURCES. Without it, the name this stage writes
    // makes the row a candidate for the FORWARD geocoder, which would resolve
    // the derived label back into a coordinate and replace the measurement that
    // produced it with the provider's own centroid.
    expect(locationSource).toBe('reverse_geocoded');
  });

  it('merges metadata and leaves the coordinate and confidence untouched', async () => {
    const h = makeStage([loadedRow(1)]);

    await h.stage.run(ctx, [eventId(1)]);

    const sql = h.update()!.sql.toLowerCase();
    // A shared jsonb bag: this stage owns exactly one key in it.
    expect(sql).toMatch(/metadata\s*=\s*coalesce\(e\.metadata, '\{\}'::jsonb\)\s*\|\|/);
    // It read the coordinate; it has nothing to say about it. And
    // `confidence_score` is an EVENT-level column that a name derived from a
    // coordinate cannot speak to either way — `ReverseGeocodeOutcome` carries no
    // precision signal at all, so any number here would be invented.
    expect(sql).not.toMatch(/location_coordinates\s*=/);
    expect(sql).not.toMatch(/confidence_score\s*=/);
    expect(h.update()!.sql).toMatch(/e\.user_id = \$1::uuid/);
  });

  it('resolves ONE provider call per cache cell, however many events share it', async () => {
    // A burst of photos from one afternoon in one room. Without this they would
    // all miss the cache in the same instant and fire identical BILLED calls,
    // because the cache row is only written after the first one returns.
    const h = makeStage([
      loadedRow(1),
      loadedRow(2, MOUNTAIN_VIEW_NEXT_DOOR),
      loadedRow(3, { lat: 51.5033, lng: -0.1196 }),
    ]);

    const results = await h.stage.run(ctx, [eventId(1), eventId(2), eventId(3)]);

    expect(h.reverseGeocode).toHaveBeenCalledTimes(2);
    expect(results.size).toBe(3);
    // The de-duplication is EXACT, not approximate: the key is the one
    // `GeocodeService.reverseGeocode` itself builds, imported rather than
    // re-derived, so two ids grouped together are guaranteed to hit one cache row.
    expect(cellKey(MOUNTAIN_VIEW.lat, MOUNTAIN_VIEW.lng)).toBe(
      cellKey(MOUNTAIN_VIEW_NEXT_DOOR.lat, MOUNTAIN_VIEW_NEXT_DOOR.lng),
    );
  });

  it('answers for an id whose row vanished between the sweep and the slice', async () => {
    const h = makeStage([loadedRow(1)]);

    const results = await h.stage.run(ctx, [eventId(1), eventId(2)]);

    expect(results.get(eventId(2))).toEqual({ outcome: 'skipped', reason: 'source_row_missing' });
  });

  it('distinguishes a cleared coordinate from a corrupt one', async () => {
    const h = makeStage([
      loadedRow(1, { lat: null, lng: null }),
      loadedRow(2, { lat: 'not-a-number', lng: 'nonsense' }),
    ]);

    const results = await h.stage.run(ctx, [eventId(1), eventId(2)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'skipped', reason: 'no_coordinates' });
    expect(results.get(eventId(2))).toMatchObject({ outcome: 'skipped', reason: 'invalid_coordinates' });
    expect(h.reverseGeocode).not.toHaveBeenCalled();
  });

  it('skips an event soft-deleted between the sweep and the slice', async () => {
    const h = makeStage([loadedRow(1, { is_deleted: true })]);

    const results = await h.stage.run(ctx, [eventId(1)]);

    // Distinct from `source_row_missing`: the row is still there and comes back
    // if it is undeleted.
    expect(results.get(eventId(1))).toEqual({ outcome: 'skipped', reason: 'event_deleted' });
  });

  it('returns an empty map for an empty slice without touching anything', async () => {
    const h = makeStage([]);

    await expect(h.stage.run(ctx, [])).resolves.toEqual(new Map());
    expect(h.statements).toHaveLength(0);
  });
});

describe('EventReverseStage.run — the transient/permanent split', () => {
  const ctx = { userId: USER };

  it.each([
    ['ZERO_RESULTS', 'zero_results'],
    ['REQUEST_DENIED', 'provider_denied'],
    ['INVALID_REQUEST', 'invalid_request'],
  ])('SKIPS %s as permanent, so it is never re-billed', async (status, reason) => {
    const h = makeStage([loadedRow(1)]);
    h.reverseGeocode.mockResolvedValue(permanentOutcome(status));

    const results = await h.stage.run(ctx, [eventId(1)]);

    // Skipped, never failed: `GeocodeService` negative-caches all three, so a
    // retry would not even reach the provider — it would just burn the retry
    // budget into quarantine.
    expect(results.get(eventId(1))).toMatchObject({ outcome: 'skipped', reason });
  });

  it('FAILS a throttled or unreachable provider, with the token the retry budget refunds', async () => {
    const h = makeStage([loadedRow(1)]);
    h.reverseGeocode.mockResolvedValue(transientOutcome('OVER_QUERY_LIMIT'));

    const results = await h.stage.run(ctx, [eventId(1)]);

    // `provider_unavailable` is load-bearing: it is in TRANSIENT_FAILURE_REASONS,
    // which is what tells the ledger to refund the attempt. Its sibling stage is
    // where the missing distinction was measured — 12,237 quarantined position
    // fixes, 19 % of that corpus, from one brief outage.
    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'failed',
      reason: 'provider_unavailable',
    });
    expect(h.update()).toBeUndefined();
  });

  it('FAILS an unrecognised status rather than guessing it is permanent', async () => {
    const h = makeStage([loadedRow(1)]);
    h.reverseGeocode.mockResolvedValue({ status: 'SOMETHING_NEW', placeName: null, retryable: false });

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'failed',
      reason: 'provider_status_unrecognized',
    });
  });

  it('records a contract-breaking blank OK rather than writing an empty name', async () => {
    // A blank name would satisfy neither `promote.place`'s predicate nor a
    // reader, while still marking the row done — the worst of both.
    const h = makeStage([loadedRow(1)]);
    h.reverseGeocode.mockResolvedValue(okOutcome('   '));

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'skipped', reason: 'no_name_resolved' });
    expect(h.update()).toBeUndefined();
  });

  it('fails every id in a slice whose single write statement threw', async () => {
    const h = makeStage([loadedRow(1), loadedRow(2, { lat: 51.5033, lng: -0.1196 })], {
      writeError: new Error('deadlock detected'),
    });

    const results = await h.stage.run(ctx, [eventId(1), eventId(2)]);

    // One statement means one outcome: it committed or it did not, so every row
    // in it shares the verdict. Attributing the failure to one id would be a
    // guess, and a guess is what the reason column exists to replace.
    for (const id of [eventId(1), eventId(2)]) {
      expect(results.get(id)).toMatchObject({ outcome: 'failed', reason: 'name_write_failed' });
    }
  });
});

describe('EventReverseStage.run — a late-arriving name still becomes searchable', () => {
  const ctx = { userId: USER };

  it('enqueues a search re-index for every event it named', async () => {
    // `searchTexts.ts` weights `event.locationName` at 4, and `index.vector_event`
    // has already recorded `done` for these rows — the ledger's own correctness
    // (do not redo finished work) is exactly what makes a late enrichment
    // invisible to search. One `sendMany` onto `search-index` is the fix, the
    // same one `PositionReverseStage` uses.
    const h = makeStage([loadedRow(1), loadedRow(2, { lat: 51.5033, lng: -0.1196 })]);

    await h.stage.run(ctx, [eventId(1), eventId(2)]);

    expect(h.sendMany).toHaveBeenCalledTimes(1);
    const [queue, jobs] = h.sendMany.mock.calls[0] as [string, Array<{ name: string; data: unknown }>];

    expect(queue).toBe('search-index');
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toEqual({ name: 'event.updated', data: { eventId: eventId(1) } });
  });

  it('still reports done when the re-index enqueue fails', async () => {
    // The name is already committed. Failing the slice over the index would
    // re-bill the provider for every id in it on the retry.
    const h = makeStage([loadedRow(1)]);
    h.sendMany.mockRejectedValue(new Error('bus down'));

    const results = await h.stage.run(ctx, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'done' });
  });

  it('enqueues nothing when nothing resolved', async () => {
    const h = makeStage([loadedRow(1)]);
    h.reverseGeocode.mockResolvedValue(permanentOutcome('ZERO_RESULTS'));

    await h.stage.run(ctx, [eventId(1)]);

    expect(h.sendMany).not.toHaveBeenCalled();
  });
});

describe('EVENT_REVERSE_SOURCE', () => {
  it('reads ci.events by its primary key, scoped to the owner', () => {
    expect(EVENT_REVERSE_SOURCE).toMatchObject({
      schema: 'ci',
      table: 'events',
      idColumn: 'event_id',
      userColumn: 'user_id',
    });
  });

  it('excludes tombstones, because a metered call on one is pure cost', () => {
    expect(EVENT_REVERSE_SOURCE.predicate).toMatch(/COALESCE\(s\.is_deleted, false\) = false/i);
  });
});
