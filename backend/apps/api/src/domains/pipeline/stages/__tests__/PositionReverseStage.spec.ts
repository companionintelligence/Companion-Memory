import { PipelineStateService } from '../../services/PipelineStateService';
import type { StageResult } from '../../types';
import {
  buildAddressPatch,
  ENRICH_POSITION_REVERSE_STAGE_ID,
  POSITION_ADDRESS_RULE_GENERATION,
  POSITION_REVERSE_VERSION,
  PositionReverseStage,
  positionReverseStageVersion,
  REVERSE_GEOCODE_PROVIDER_GENERATION,
} from '../enrich/PositionReverseStage';

/**
 * `enrich.position_reverse` — the writer `ci.position`'s seven address columns
 * never had.
 *
 * Two halves, and the split is the whole argument for the rebuild:
 *
 *  1. **Selection** (`PipelineStateService.selectStale` driven with THIS stage's
 *     real `source`) — proves candidacy is decided by `ci.pipeline_state` and
 *     never by `ci.position.address`. `address IS NULL` is the obvious predicate
 *     to write for a column-filling stage and it is the exact ratchet the ledger
 *     exists to remove: an open-ocean fix would be re-sent to a BILLED provider
 *     forever, and a fix that resolved once could never be improved.
 *  2. **Decision** (`stage.run`) — proves every id gets exactly one answer, that
 *     no non-`done` answer is anonymous, and that the transient/permanent split
 *     lands on the right side of `failed` vs `skipped`. Getting that backwards
 *     costs money in one direction and coverage in the other.
 *
 * The tests are written against the CONTRACT, not the implementation. There is no
 * Postgres: the fake `DataSource` recognises the sweep by its `LEFT JOIN
 * ci.pipeline_state` and evaluates THE ONE RULE in TypeScript from the six bound
 * parameters, so the assertions cover which rows come back for which ledger
 * states rather than a SQL string.
 */

/* ===================================================================== *
 * Fixtures
 * ===================================================================== */

const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER_USER = '00000000-0000-4000-8000-0000000000bb';
const ENTITY_TYPE = 'position';

/**
 * Ordered uuids. Canonical lowercase hex uuids compare byte-wise in Postgres and
 * lexically in JS in the SAME order, so the fake's keyset comparison is a
 * faithful stand-in for `s."id" > $5::uuid`.
 */
function positionId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Googleplex, and a point in the middle of the Pacific. */
const MOUNTAIN_VIEW = { lat: 37.4224, lng: -122.0841 };
const OPEN_OCEAN = { lat: -30.0, lng: -140.0 };

/** A representative Google reverse-geocode component set. */
const MOUNTAIN_VIEW_COMPONENTS = {
  address_components: [
    { long_name: '1600', short_name: '1600', types: ['street_number'] },
    { long_name: 'Amphitheatre Parkway', short_name: 'Amphitheatre Pkwy', types: ['route'] },
    { long_name: 'Googleplex', short_name: 'Googleplex', types: ['point_of_interest', 'establishment'] },
    { long_name: 'Shoreline West', short_name: 'Shoreline West', types: ['neighborhood', 'political'] },
    { long_name: 'Mountain View', short_name: 'Mountain View', types: ['locality', 'political'] },
    { long_name: 'California', short_name: 'CA', types: ['administrative_area_level_1', 'political'] },
    { long_name: 'United States', short_name: 'US', types: ['country', 'political'] },
    { long_name: '94043', short_name: '94043', types: ['postal_code'] },
  ],
};

interface SourceRow {
  id: string | null;
  user_id: string;
  /** Present for an absolute fix; NULL for a relative-only one. */
  location: string | null;
  /** The stage's OUTPUT columns. Nothing in selection may ever read these. */
  address: string | null;
  city: string | null;
}

function fixRow(n: number, overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: positionId(n),
    user_id: USER,
    location: 'POINT(-122.0841 37.4224)',
    address: null,
    city: null,
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
function okOutcome(placeName: string, components: Record<string, unknown> | null = MOUNTAIN_VIEW_COMPONENTS) {
  return { status: 'OK', placeName, cached: false, retryable: false, placeId: 'p1', components };
}

function permanentOutcome(status: string) {
  return { status, placeName: null, cached: true, retryable: false };
}

function transientOutcome(status: string) {
  return { status, placeName: null, cached: false, retryable: true };
}

interface PositionRow {
  id: string;
  time: Date;
  lat: number;
  lng: number;
}

function positionRow(n: number, point = MOUNTAIN_VIEW, time = new Date('2024-05-01T12:00:00Z')): PositionRow {
  return { id: positionId(n), time, lat: point.lat, lng: point.lng };
}

interface StageHarness {
  stage: PositionReverseStage;
  reverseGeocode: jest.Mock;
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
function makeStage(rows: PositionRow[] = [], opts: { writeError?: Error } = {}): StageHarness {
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

  const reverseGeocode = jest.fn(async () =>
    okOutcome('1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA'),
  );

  const stage = new PositionReverseStage(
    { query } as never,
    { reverseGeocode } as never,
    makeLogger() as never,
  );

  return {
    stage,
    reverseGeocode,
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
 * Kept faithful to `POSITION_REVERSE_SOURCE.predicate`: an absolute fix that the
 * ledger can address. Note what it does NOT consult — `address`, or any of the
 * other six output columns. That absence is the fix, and the assertions below
 * make it observable rather than taking the fake's word for it.
 */
function isApplicable(row: SourceRow): boolean {
  return row.location != null && row.id != null;
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
      const entry = ledger.get(ledgerKey(entityType, row.id as string, stageId));

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
    .filter((row) => cursor == null || (row.id as string) > cursor)
    .sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : (a.id as string) > (b.id as string) ? 1 : 0))
    .slice(0, limit)
    .map((row) => ({ id: row.id as string }));
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
 * `REVERSE_GEOCODE_PROVIDER_GENERATION` (and the matching `versions.ts` line)
 * does to the value the sweep binds as `$4`.
 */
function atVersion(stage: PositionReverseStage, version: number) {
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

describe('PositionReverseStage — candidate selection asks the LEDGER, not ci.position.address', () => {
  it('selects a fix whose address is ALREADY SET when the ledger has never seen it', async () => {
    // The repair `address IS NULL` makes impossible. An address written by the
    // bulk importer's Apple placemark — or by v1 of this stage — would otherwise
    // put the row permanently out of reach of a better provider.
    const { stage } = makeStage();
    const h = makeLedgerHarness([fixRow(1, { address: 'Somewhere', city: 'Mountain View' })]);

    const ids = await h.service.selectStale(stage as never, USER, null, 10);

    expect(ids).toEqual([positionId(1)]);
  });

  it('never names the output columns in the sweep', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([fixRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    const sql = h.sweeps[0].sql.toLowerCase();
    expect(sql).not.toMatch(/\baddress\b/);
    expect(sql).not.toMatch(/\bcity\b/);
    expect(sql).not.toMatch(/\bregion\b/);
    expect(sql).not.toMatch(/\bcountry\b/);
    expect(sql).not.toMatch(/\bpostal_code\b/);
    expect(sql).not.toMatch(/\bdescription\b/);
  });

  it('splices the stage applicability predicate verbatim, and it says what a row IS', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([fixRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    expect(h.sweeps[0].sql).toContain(stage.source.predicate);
    // Applicability, never completion: the predicate must not mention the ledger
    // (StageRegistry rejects that) nor any of the seven columns the stage writes.
    expect(stage.source.predicate).not.toMatch(
      /address|city|region|country|postal_code|description|pipeline_state/i,
    );
  });

  it('excludes relative-only fixes, unaddressable rows and another user by applicability alone', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([
      fixRow(1),
      // A relative fix (reference_entity_id + relative_coordinates): no lat/lng
      // to reverse, and not this stage's to interpret.
      fixRow(2, { location: null }),
      // `ci.position.id` is nullable and never constrained; a row without one
      // cannot be keyed in the ledger at all.
      fixRow(3, { id: null }),
      fixRow(4, { user_id: OTHER_USER }),
      fixRow(5),
    ]);

    const ids = await h.service.selectStale(stage as never, USER, null, 10);

    expect(ids).toEqual([positionId(1), positionId(5)]);
  });

  it('stops re-selecting an open-ocean fix — the one that used to be re-billed forever', async () => {
    // The bug this deletes, and here it costs actual money: a fix the provider
    // has nothing for stays `address IS NULL`, so every run re-sends it to a
    // metered API for as long as the appliance exists.
    const { stage } = makeStage();
    const h = makeLedgerHarness([fixRow(1), fixRow(2)]);
    h.seed(
      positionId(1),
      { stageVersion: stage.version, status: 'skipped', reason: 'zero_results', nextAttemptAt: null },
      stage.id,
    );

    const ids = await h.service.selectStale(stage as never, USER, null, 10);

    expect(ids).toEqual([positionId(2)]);
  });

  it('leaves a fully-filled row alone at the current version and re-selects it after a bump', async () => {
    // The headline property. Row 1 has every one of the seven columns populated
    // and row 2 was skipped; at the current version neither is a candidate, and
    // the instant the version moves both come back — including the skip, because
    // a wrong skip is as repairable as a wrong answer.
    const { stage } = makeStage();
    const h = makeLedgerHarness([
      fixRow(1, { address: '1600 Amphitheatre Pkwy', city: 'Mountain View' }),
      fixRow(2),
    ]);
    h.seed(
      positionId(1),
      { stageVersion: stage.version, status: 'done', reason: null, nextAttemptAt: null },
      stage.id,
    );
    h.seed(
      positionId(2),
      { stageVersion: stage.version, status: 'skipped', reason: 'zero_results', nextAttemptAt: null },
      stage.id,
    );

    await expect(h.service.selectStale(stage as never, USER, null, 10)).resolves.toEqual([]);
    await expect(
      h.service.selectStale(atVersion(stage, stage.version + 1) as never, USER, null, 10),
    ).resolves.toEqual([positionId(1), positionId(2)]);
  });

  it('binds the version off the stage, so bumping a generation is the whole mechanism', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([fixRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    expect(h.sweeps[0].params[3]).toBe(stage.version);
  });

  it('records the ledger under entity_type "position"', async () => {
    const { stage } = makeStage();
    const h = makeLedgerHarness([fixRow(1)]);

    await h.service.selectStale(stage as never, USER, null, 10);

    expect(h.sweeps[0].params[0]).toBe(ENTITY_TYPE);
    expect(h.sweeps[0].params[1]).toBe(ENRICH_POSITION_REVERSE_STAGE_ID);
  });
});

describe('PositionReverseStage — the version is DERIVED, so improving the provider re-runs history', () => {
  it('derives the version from the provider and rule generations', () => {
    expect(POSITION_REVERSE_VERSION).toBe(
      REVERSE_GEOCODE_PROVIDER_GENERATION + POSITION_ADDRESS_RULE_GENERATION - 1,
    );
    expect(Number.isInteger(POSITION_REVERSE_VERSION)).toBe(true);
    expect(POSITION_REVERSE_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('reports the derived version, and the stage reads it rather than hardcoding one', () => {
    const { stage } = makeStage();

    expect(stage.version).toBe(POSITION_REVERSE_VERSION);
    expect(positionReverseStageVersion({})).toBe(POSITION_REVERSE_VERSION);
  });

  it('throws when STAGE_VERSIONS disagrees with the derivation', () => {
    // Bumping a generation without the matching one-line diff to versions.ts
    // otherwise surfaces as StageRegistry complaining about a HARDCODED version,
    // which is not what happened and sends the reader to the wrong file.
    expect(() =>
      positionReverseStageVersion({ [ENRICH_POSITION_REVERSE_STAGE_ID]: POSITION_REVERSE_VERSION + 1 }),
    ).toThrow(/derives/i);
  });

  it('accepts a STAGE_VERSIONS entry that agrees', () => {
    expect(
      positionReverseStageVersion({ [ENRICH_POSITION_REVERSE_STAGE_ID]: POSITION_REVERSE_VERSION }),
    ).toBe(POSITION_REVERSE_VERSION);
  });
});

describe('PositionReverseStage.run — every id gets exactly one answer', () => {
  const ctx = { userId: USER };

  it('fills all seven address columns from one resolved fix', async () => {
    const h = makeStage([positionRow(1)]);

    const results = await h.stage.run(ctx, [positionId(1)]);

    expect(results.get(positionId(1))?.outcome).toBe('done');

    const update = h.update();
    expect(update).toBeDefined();

    const [ids, , address, city, region, country, postalCode, name, description] = update!.params as [
      string[],
      Date[],
      string[],
      string[],
      string[],
      string[],
      string[],
      string[],
      string[],
    ];

    expect(ids).toEqual([positionId(1)]);
    expect(address[0]).toBe('1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA');
    expect(city[0]).toBe('Mountain View');
    expect(region[0]).toBe('California');
    expect(country[0]).toBe('United States');
    expect(postalCode[0]).toBe('94043');
    expect(name[0]).toBe('Googleplex');
    expect(description[0]).toBe('Shoreline West');
  });

  it('addresses the row by its (time, user_id) primary key and bounds the update to the slice', async () => {
    // `ci.position` is a hypertable with no index on `id`. Keying the write on
    // the PK, inside a time range covering only the slice's own fixes, is what
    // lets TimescaleDB skip every chunk the slice does not touch.
    const early = new Date('2019-03-04T05:06:07Z');
    const late = new Date('2024-11-12T13:14:15Z');
    const h = makeStage([positionRow(1, MOUNTAIN_VIEW, early), positionRow(2, MOUNTAIN_VIEW, late)]);

    await h.stage.run(ctx, [positionId(1), positionId(2)]);

    const update = h.update()!;
    expect(update.sql).toMatch(/p\.time\s*=\s*u\.fix_time/i);
    expect(update.params[9]).toBe(USER);
    expect((update.params[10] as Date).getTime()).toBe(early.getTime());
    expect((update.params[11] as Date).getTime()).toBe(late.getTime());
  });

  it('overwrites rather than filling only NULLs, or a version bump could not repair anything', async () => {
    const h = makeStage([positionRow(1)]);

    await h.stage.run(ctx, [positionId(1)]);

    // A COALESCE here would move the ratchet out of candidate selection and into
    // the UPDATE: the sweep would dutifully re-select the row and the write would
    // silently keep the old, worse answer.
    expect(h.update()!.sql).not.toMatch(/coalesce/i);
  });

  it('SKIPS a point that reverse-geocodes to nothing WITH a reason, and never writes', async () => {
    // Open ocean. The provider knows the coordinate and has nothing there, so
    // this is permanent — a retry would not even reach the provider, since
    // GeocodeService negative-caches it.
    const h = makeStage([positionRow(1, OPEN_OCEAN)]);
    h.reverseGeocode.mockResolvedValue(permanentOutcome('ZERO_RESULTS'));

    const results = await h.stage.run(ctx, [positionId(1)]);

    expect(results.get(positionId(1))).toMatchObject({ outcome: 'skipped', reason: 'zero_results' });
    expect(h.update()).toBeUndefined();
  });

  it('FAILS a transient provider outage so it retries, and SKIPS a permanent refusal so it does not', async () => {
    // The split that decides whether an incident costs coverage or money.
    const transient = makeStage([positionRow(1)]);
    transient.reverseGeocode.mockResolvedValue(transientOutcome('OVER_QUERY_LIMIT'));

    const transientResults = await transient.stage.run(ctx, [positionId(1)]);

    expect(transientResults.get(positionId(1))).toMatchObject({
      outcome: 'failed',
      reason: 'provider_unavailable',
      detail: { status: 'OVER_QUERY_LIMIT' },
    });

    const permanent = makeStage([positionRow(1)]);
    permanent.reverseGeocode.mockResolvedValue(permanentOutcome('REQUEST_DENIED'));

    const permanentResults = await permanent.stage.run(ctx, [positionId(1)]);

    expect(permanentResults.get(positionId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'provider_denied',
    });
  });

  it('FAILS a transport failure, which GeocodeService reports as retryable UNKNOWN_ERROR', async () => {
    const h = makeStage([positionRow(1)]);
    h.reverseGeocode.mockResolvedValue(transientOutcome('UNKNOWN_ERROR'));

    const results = await h.stage.run(ctx, [positionId(1)]);

    expect(results.get(positionId(1))?.outcome).toBe('failed');
    expect(results.get(positionId(1))?.reason).toBe('provider_unavailable');
  });

  it('FAILS, rather than guessing permanence, on a status the provider abstraction did not have', async () => {
    const h = makeStage([positionRow(1)]);
    h.reverseGeocode.mockResolvedValue({
      status: 'MYSTERY',
      placeName: null,
      cached: false,
      retryable: false,
    });

    const results = await h.stage.run(ctx, [positionId(1)]);

    expect(results.get(positionId(1))).toMatchObject({
      outcome: 'failed',
      reason: 'provider_status_unrecognized',
    });
  });

  it('FAILS the resolved rows when the write throws, separately from a provider failure', async () => {
    // A real one: `ci.position` compresses chunks after 7 days, so the UPDATE
    // path for historical fixes goes through decompression and has failure modes
    // the provider call does not share.
    const h = makeStage([positionRow(1)], { writeError: new Error('cannot update rows from chunk') });

    const results = await h.stage.run(ctx, [positionId(1)]);

    expect(results.get(positionId(1))).toMatchObject({
      outcome: 'failed',
      reason: 'address_write_failed',
    });
  });

  it('costs ONE provider call for a whole slice standing still in the same 11 m cell', async () => {
    // Without the grouping, 200 concurrent fixes in one room all miss the cache
    // in the same instant — the cache row is only written after the first call
    // returns — and 200 identical billed calls go out.
    const rows = Array.from({ length: 12 }, (_, index) => positionRow(index + 1));
    const h = makeStage(rows);

    const results = await h.stage.run(
      ctx,
      rows.map((row) => row.id),
    );

    expect(h.reverseGeocode).toHaveBeenCalledTimes(1);
    expect(results.size).toBe(12);
    expect([...results.values()].every((result) => result.outcome === 'done')).toBe(true);
  });

  it('still calls once per distinct cell', async () => {
    const h = makeStage([positionRow(1, MOUNTAIN_VIEW), positionRow(2, OPEN_OCEAN)]);

    await h.stage.run(ctx, [positionId(1), positionId(2)]);

    expect(h.reverseGeocode).toHaveBeenCalledTimes(2);
  });

  it('answers for an id whose row is gone rather than staying silent', async () => {
    const h = makeStage([]);

    const results = await h.stage.run(ctx, [positionId(1)]);

    expect(results.get(positionId(1))).toEqual({ outcome: 'skipped', reason: 'source_row_missing' });
  });

  it('scopes the row load to the slice user', async () => {
    // A slice can arrive from a dead letter replayed weeks later; re-scoping is
    // the difference between "not yours" and billing someone else's movements.
    const h = makeStage([positionRow(1)]);

    await h.stage.run({ userId: OTHER_USER }, [positionId(1)]);

    expect(h.statements[0].params[1]).toBe(OTHER_USER);
    expect(h.reverseGeocode).not.toHaveBeenCalled();
  });

  it('gives every non-done outcome a reason — the ledger refuses one without', async () => {
    const h = makeStage([positionRow(1, OPEN_OCEAN)]);
    h.reverseGeocode.mockResolvedValue(permanentOutcome('ZERO_RESULTS'));

    const results = await h.stage.run(ctx, [positionId(1), positionId(2)]);

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
    const h = makeLedgerHarness([fixRow(1)]);

    await expect(
      h.service.complete(
        stage as never,
        ENTITY_TYPE,
        new Map<string, StageResult>([[positionId(1), { outcome: 'skipped' }]]),
      ),
    ).rejects.toThrow(/no reason/i);

    expect(h.writes).toHaveLength(0);
  });
});

describe('buildAddressPatch — the component rule', () => {
  it('reads long_name, matching PlaceService, so one country has one spelling', () => {
    const patch = buildAddressPatch('somewhere', MOUNTAIN_VIEW_COMPONENTS);

    expect(patch.country).toBe('United States');
  });

  it('falls back past locality for the rest of the world', () => {
    const patch = buildAddressPatch('somewhere', {
      address_components: [
        { long_name: 'Camden Town', types: ['postal_town'] },
        { long_name: 'England', types: ['administrative_area_level_1'] },
      ],
    });

    expect(patch.city).toBe('Camden Town');
    expect(patch.region).toBe('England');
  });

  it('never repeats the city as the description', () => {
    const patch = buildAddressPatch('somewhere', {
      address_components: [{ long_name: 'Shibuya', types: ['sublocality', 'sublocality_level_1'] }],
    });

    expect(patch.city).toBe('Shibuya');
    expect(patch.description).toBeNull();
  });

  it('leaves a venue-less fix with a NULL name rather than repeating the address', () => {
    const patch = buildAddressPatch('A303, Wiltshire, UK', { address_components: [] });

    expect(patch.address).toBe('A303, Wiltshire, UK');
    expect(patch.name).toBeNull();
    expect(patch.city).toBeNull();
  });

  it('tolerates a provider result with no components at all', () => {
    expect(buildAddressPatch('somewhere', null)).toMatchObject({ address: 'somewhere', city: null });
  });
});
