import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../../__tests__/support/scratchDatabase';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The estimates v1 pinned onto NAMED events are withdrawn — with everything
 * built on them, and nothing else. Proved against real Postgres.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `enrich.estimate_location` v1 copied a neighbour's coordinate onto events
 * that carried their own `location_name`; `promote.place` linked them to
 * whatever Location sat at that coordinate, `promote.edge_event` projected a
 * LOCATED_AT edge, and promote.place derived the Location's footprint from
 * them. {@link MIGRATION} withdraws all four. The reference corpus it was
 * measured on exercised only the plainest shape (37 ICS events, every link
 * promote.place's, every delta unsummarized, no Location shared with a real
 * visit), so each branch the corpus did not reach has a fixture here:
 *
 *  - a creation delta a summary already read (amended, not erased);
 *  - an importer's own confidence below the estimator's 0.4 (kept);
 *  - a Location that keeps a real visit (footprint kept, and re-derived);
 *  - a Location merged into another (the edge points at the survivor);
 *  - a link another writer made, and an inference another writer recorded;
 *  - a LOCATED_AT edge a receipt projected over the same pair (kept);
 *  - an unnamed estimate and a blank-named one (the stage working as designed).
 *
 * Runs on a database of its own — the migration is unscoped, so pointing it at
 * a shared one would repair that database's rows too. Skips (loudly) without an
 * administrative connection; see `domains/__tests__/support/scratchDatabase.ts`.
 */

const MIGRATION = '20260930035044_clear_estimates_on_events_with_own_location.sql';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../db/postgres/migrations');

/** The `-- migrate:up` half of the migration, as dbmate would run it. */
function migrationUpSql(): string {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
  const down = sql.indexOf('-- migrate:down');

  return down === -1 ? sql : sql.slice(0, down);
}

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/EstimateLocationRepair.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(600_000);

const USER = '11111111-1111-4111-8111-111111111111';

const HOME = { lat: 34.0537, lng: -118.2428 };
const OFFICE = { lat: 34.0094, lng: -118.4973 };

/** Fixed ids, so "this row kept its link" is a thing an assertion can state. */
const IDS = {
  // Locations
  home: 'b0000000-0000-4000-8000-000000000001',
  shared: 'b0000000-0000-4000-8000-000000000002',
  mergedLoser: 'b0000000-0000-4000-8000-000000000003',
  mergedSurvivor: 'b0000000-0000-4000-8000-000000000004',
  otherWriters: 'b0000000-0000-4000-8000-000000000005',
  receiptPlace: 'b0000000-0000-4000-8000-000000000006',
  // Named events carrying a v1 estimate — the repair's working set
  bangkok: 'e0000000-0000-4000-8000-000000000001',
  summarized: 'e0000000-0000-4000-8000-000000000002',
  sharesOffice: 'e0000000-0000-4000-8000-000000000003',
  toMergedPlace: 'e0000000-0000-4000-8000-000000000004',
  foreignLink: 'e0000000-0000-4000-8000-000000000005',
  receiptEdge: 'e0000000-0000-4000-8000-000000000006',
  // Controls
  realVisit: 'e0000000-0000-4000-8000-000000000011',
  unnamedEstimate: 'e0000000-0000-4000-8000-000000000012',
  blankNameEstimate: 'e0000000-0000-4000-8000-000000000013',
  // Graph
  bangkokEdge: 'f0000000-0000-4000-8000-000000000001',
  summarizedEdge: 'f0000000-0000-4000-8000-000000000002',
  sharesOfficeEdge: 'f0000000-0000-4000-8000-000000000003',
  toMergedPlaceEdge: 'f0000000-0000-4000-8000-000000000004',
  receiptEdgeEdge: 'f0000000-0000-4000-8000-000000000006',
  realVisitEdge: 'f0000000-0000-4000-8000-000000000011',
  summary: 'a0000000-0000-4000-8000-000000000001',
};

/** What the estimator wrote into `inference_sources`. */
const TEMPORAL_NN = { method: 'temporal_nn', donor: 'position', donor_id: 'x', delta_seconds: 600 };

/** promote.place's provenance on a link it wrote. */
const PROMOTE_LINK = { stage: 'promote.place', version: 1, at: '2026-09-29T00:00:00Z' };

describeWithDatabase(`clear estimates on events with their own location (${availability.target})`, () => {
  let scratch: ScratchDatabase;

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    scratch.dataSource.query(sql, params);

  async function location(
    id: string,
    name: string,
    point: { lat: number; lng: number },
    opts: { footprint?: boolean; mergedInto?: string } = {},
  ): Promise<void> {
    await q(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, properties, location_point,
                                place_kind, location_boundary, merged_into_entity_id, is_active)
       VALUES ($1::uuid, 'Location', $2, $3::uuid, $4::jsonb,
               ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, 'address',
               CASE WHEN $7::boolean
                    THEN ST_Buffer(ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, 56)::geography END,
               $8::uuid, $8::uuid IS NULL)`,
      [
        id,
        name,
        USER,
        JSON.stringify({
          source: 'reverse_geocode',
          ...(opts.footprint === true ? { promote: { stage: 'promote.place', version: 1 } } : {}),
        }),
        point.lng,
        point.lat,
        opts.footprint === true,
        opts.mergedInto ?? null,
      ],
    );
  }

  async function event(
    id: string,
    args: {
      title: string;
      name: string | null;
      point: { lat: number; lng: number };
      linkedTo?: string;
      metadata: Record<string, unknown>;
      confidence?: number;
      isInferred?: boolean;
      inference?: Record<string, unknown>;
    },
  ): Promise<void> {
    await q(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, linked_table, linked_id)
       VALUES ($1::uuid, 'Event', $2, $3::uuid, 'events', $1::uuid)`,
      [id, args.title, USER],
    );
    await q(
      `INSERT INTO ci.events (event_id, user_id, start_time, source_type, source_system, source_id,
                              location_name, location_coordinates, location_entity_id, metadata,
                              confidence_score, is_inferred, inference_sources)
       VALUES ($1::uuid, $2::uuid, '2026-05-01T10:00:00Z', 'ci-import-tools', 'calendar', $1::text,
               $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6::uuid, $7::jsonb,
               $8, $9, $10::jsonb)`,
      [
        id,
        USER,
        args.name,
        args.point.lng,
        args.point.lat,
        args.linkedTo ?? null,
        JSON.stringify(args.metadata),
        args.confidence ?? 1.0,
        args.isInferred ?? false,
        JSON.stringify(args.inference ?? {}),
      ],
    );
  }

  async function edge(id: string, from: string, to: string, rule: string, summaryId?: string): Promise<void> {
    await q(
      `INSERT INTO ci.relationships (relationship_id, from_entity_id, to_entity_id, relationship_type, strength,
                                     properties, owner_user_id, from_entity_type, to_entity_type)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'LOCATED_AT', 0.6, $4::jsonb, $5::uuid, 'Event', 'Location')`,
      [id, from, to, JSON.stringify({ rule, derived_from: 'events.location_entity_id' }), USER],
    );
    await q(
      `INSERT INTO ci.graph_deltas (node_type, change_type, relationship_id, relationship_type,
                                    from_entity_id, to_entity_id, owner_user_id, change_source, change_reason,
                                    summary_id)
       VALUES ('relationship', 'created', $1::uuid, 'LOCATED_AT', $2::uuid, $3::uuid, $4::uuid,
               'DeterministicEdgeBackfillService', $5, $6::uuid)`,
      [id, from, to, USER, rule, summaryId ?? null],
    );
  }

  async function ledger(eventId: string, stages: string[]): Promise<void> {
    for (const stage of stages) {
      await q(
        `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, stage_version, status, attempts, user_id)
         VALUES ('event', $1::uuid, $2, 1, 'done', 1, $3::uuid)`,
        [eventId, stage, USER],
      );
    }
  }

  /** A named event carrying a v1 estimate, with the defaults the reference corpus showed. */
  const estimatedNamed = (
    title: string,
    name: string,
    linkedTo: string | undefined,
    extra: Partial<Parameters<typeof event>[1]> = {},
  ): Parameters<typeof event>[1] => ({
    title,
    name,
    point: HOME,
    linkedTo,
    metadata: {
      Source: 'ICS',
      Location: name,
      location_source: 'estimated',
      ...(linkedTo != null ? { promote: PROMOTE_LINK } : {}),
    },
    confidence: 0.4,
    isInferred: true,
    inference: TEMPORAL_NN,
    ...extra,
  });

  const ALL_STAGES = [
    'enrich.estimate_location',
    'promote.place',
    'promote.edge_event',
    'index.vector_event',
    'clean.temporal_repair',
  ];

  async function seed(): Promise<void> {
    await q(`INSERT INTO ci.users (id, email, name) VALUES ($1::uuid, 'repair@example.invalid', 'U')`, [
      USER,
    ]);
    await q(
      `INSERT INTO ci.summaries (summary_id, user_id, period_start, period_end, period_type, source_types)
       VALUES ($1::uuid, $2::uuid, '2026-05-01', '2026-05-02', 'daily', ARRAY['graph'])`,
      [IDS.summary, USER],
    );

    // One 0.001-degree cell per Location: `entities_location_snap_dedup_uniq`
    // allows a single Location per owner per cell, merged or not.
    const nearby = (base: { lat: number; lng: number }, cells: number) => ({
      lat: base.lat + cells * 0.01,
      lng: base.lng,
    });

    await location(IDS.home, 'Home', HOME, { footprint: true });
    await location(IDS.shared, 'Office', OFFICE, { footprint: true });
    await location(IDS.mergedSurvivor, 'Home (merged)', nearby(HOME, 1));
    await location(IDS.mergedLoser, 'Home dup', nearby(HOME, 2), { mergedInto: IDS.mergedSurvivor });
    await location(IDS.otherWriters, 'Irvine Spectrum', nearby(OFFICE, 1));
    await location(IDS.receiptPlace, 'Airport', nearby(HOME, 3));

    await event(IDS.bangkok, estimatedNamed('Flight to Taipei', 'Bangkok BKK', IDS.home));
    await edge(IDS.bangkokEdge, IDS.bangkok, IDS.home, 'event.happened_at');
    await ledger(IDS.bangkok, ALL_STAGES);

    // The importer's own confidence was LOWER than the estimator's 0.4, so
    // LEAST kept it; and a summary has already read this edge's creation.
    await event(IDS.summarized, estimatedNamed('Dinner', 'Santa Monica', IDS.home, { confidence: 0.3 }));
    await edge(IDS.summarizedEdge, IDS.summarized, IDS.home, 'event.happened_at', IDS.summary);

    await event(IDS.sharesOffice, estimatedNamed('Offsite', 'Glendale', IDS.shared, { point: OFFICE }));
    await edge(IDS.sharesOfficeEdge, IDS.sharesOffice, IDS.shared, 'event.happened_at');

    // Linked to a Location that has since been merged: the projection wrote the
    // edge to the survivor.
    await event(IDS.toMergedPlace, estimatedNamed('Pickup', 'LAX-it', IDS.mergedLoser));
    await edge(IDS.toMergedPlaceEdge, IDS.toMergedPlace, IDS.mergedSurvivor, 'event.happened_at');

    // A link and an inference record some OTHER writer made.
    await event(IDS.foreignLink, {
      ...estimatedNamed('Shopping', 'Irvine Spectrum', undefined),
      linkedTo: IDS.otherWriters,
      inference: { method: 'hbpe', model: 'x' },
    });
    await ledger(IDS.foreignLink, ['enrich.estimate_location']);

    // The same pair's LOCATED_AT edge, projected from a receipt, not the link.
    await event(IDS.receiptEdge, estimatedNamed('Duty free', 'BKK Terminal', IDS.receiptPlace));
    await edge(IDS.receiptEdgeEdge, IDS.receiptEdge, IDS.receiptPlace, 'receipt.happened_at');

    // Controls.
    await event(IDS.realVisit, {
      title: 'Standup',
      name: 'Office',
      point: OFFICE,
      linkedTo: IDS.shared,
      metadata: { Source: 'ICS', promote: PROMOTE_LINK },
    });
    await edge(IDS.realVisitEdge, IDS.realVisit, IDS.shared, 'event.happened_at');
    await ledger(IDS.realVisit, ['promote.place', 'promote.edge_event']);

    await event(IDS.unnamedEstimate, {
      ...estimatedNamed('Gym', 'unused', undefined),
      name: null,
      metadata: { location_source: 'estimated' },
    });
    await ledger(IDS.unnamedEstimate, ['enrich.estimate_location']);

    await event(IDS.blankNameEstimate, {
      ...estimatedNamed('Call', '   ', undefined),
      metadata: { location_source: 'estimated' },
    });
  }

  /** Apply the migration the way dbmate does: the whole up half, one transaction. */
  async function applyMigration(): Promise<void> {
    const runner = scratch.dataSource.createQueryRunner();

    await runner.connect();
    await runner.startTransaction();

    try {
      await runner.query(migrationUpSql());
      await runner.commitTransaction();
    } catch (err) {
      await runner.rollbackTransaction();

      throw err;
    } finally {
      await runner.release();
    }
  }

  async function eventRow(id: string) {
    const [row] = await q<{
      has_coordinates: boolean;
      location_entity_id: string | null;
      metadata: Record<string, unknown>;
      is_inferred: boolean;
      inference_sources: Record<string, unknown>;
      confidence_score: number;
    }>(
      `SELECT location_coordinates IS NOT NULL AS has_coordinates, location_entity_id, metadata,
              is_inferred, inference_sources, confidence_score
         FROM ci.events WHERE event_id = $1::uuid`,
      [id],
    );

    return row;
  }

  const edgeExists = async (id: string): Promise<boolean> =>
    (await q(`SELECT 1 FROM ci.relationships WHERE relationship_id = $1::uuid`, [id])).length > 0;

  const ledgerStages = async (id: string): Promise<string[]> =>
    (
      await q<{ stage: string }>(
        `SELECT stage FROM ci.pipeline_state WHERE entity_id = $1::uuid ORDER BY 1`,
        [id],
      )
    ).map((row) => row.stage);

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'estimate location repair' });
    await seed();
    await applyMigration();
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('gives a named event back exactly what the estimator and promote.place took', async () => {
    const row = await eventRow(IDS.bangkok);

    expect(row).toMatchObject({
      has_coordinates: false,
      location_entity_id: null,
      is_inferred: false,
      inference_sources: {},
      confidence_score: 1,
    });
    // Only the two keys this chain wrote; the importer's own survive.
    expect(row.metadata).toEqual({ Source: 'ICS', Location: 'Bangkok BKK' });
  });

  it("keeps an importer's confidence that was already below the estimator's", async () => {
    expect((await eventRow(IDS.summarized)).confidence_score).toBe(0.3);
  });

  it('deletes the LOCATED_AT edge and its unread creation delta', async () => {
    expect(await edgeExists(IDS.bangkokEdge)).toBe(false);
    expect(
      await q(`SELECT 1 FROM ci.graph_deltas WHERE relationship_id = $1::uuid`, [IDS.bangkokEdge]),
    ).toEqual([]);
  });

  it('amends, rather than erases, a creation delta a summary already read', async () => {
    expect(await edgeExists(IDS.summarizedEdge)).toBe(false);

    const deltas = await q<{ change_type: string; summary_id: string | null }>(
      `SELECT change_type, summary_id FROM ci.graph_deltas WHERE relationship_id = $1::uuid ORDER BY changed_at, change_type`,
      [IDS.summarizedEdge],
    );

    expect(deltas).toEqual([
      { change_type: 'created', summary_id: IDS.summary },
      { change_type: 'deleted', summary_id: null },
    ]);
  });

  it('follows a merged Location to the survivor the edge was written to', async () => {
    expect(await edgeExists(IDS.toMergedPlaceEdge)).toBe(false);
    expect((await eventRow(IDS.toMergedPlace)).location_entity_id).toBeNull();
  });

  it('keeps a LOCATED_AT edge a receipt projected over the same pair', async () => {
    expect(await edgeExists(IDS.receiptEdgeEdge)).toBe(true);
    // The link promote.place wrote is still withdrawn.
    expect((await eventRow(IDS.receiptEdge)).location_entity_id).toBeNull();
  });

  it('clears the coordinate but keeps a link and an inference another writer made', async () => {
    const row = await eventRow(IDS.foreignLink);

    expect(row).toMatchObject({
      has_coordinates: false,
      location_entity_id: IDS.otherWriters,
      is_inferred: true,
      inference_sources: { method: 'hbpe', model: 'x' },
      confidence_score: 1,
    });
    expect(row.metadata).not.toHaveProperty('location_source');
  });

  it('clears a footprint derived only from withdrawn links, and keeps the Location', async () => {
    const [home] = await q<{
      is_active: boolean;
      has_boundary: boolean;
      properties: Record<string, unknown>;
    }>(
      `SELECT is_active, location_boundary IS NOT NULL AS has_boundary, properties
         FROM ci.entities WHERE entity_id = $1::uuid`,
      [IDS.home],
    );

    expect(home).toEqual({ is_active: true, has_boundary: false, properties: { source: 'reverse_geocode' } });
  });

  it('keeps the footprint of a Location that still has a real visit, and re-arms that visit to re-derive it', async () => {
    const [shared] = await q<{ has_boundary: boolean; promote: unknown }>(
      `SELECT location_boundary IS NOT NULL AS has_boundary, properties->'promote' AS promote
         FROM ci.entities WHERE entity_id = $1::uuid`,
      [IDS.shared],
    );

    expect(shared).toEqual({ has_boundary: true, promote: { stage: 'promote.place', version: 1 } });
    expect(await edgeExists(IDS.sharesOfficeEdge)).toBe(false);
    expect(await edgeExists(IDS.realVisitEdge)).toBe(true);
    // promote.place recomputes a footprint from the links that are left; the
    // real visit is the one the sweep will now re-offer.
    expect(await ledgerStages(IDS.realVisit)).toEqual(['promote.edge_event']);
    expect(await eventRow(IDS.realVisit)).toMatchObject({
      has_coordinates: true,
      location_entity_id: IDS.shared,
    });
  });

  it('re-arms exactly the three stages built on the estimate', async () => {
    expect(await ledgerStages(IDS.bangkok)).toEqual(['clean.temporal_repair', 'index.vector_event']);
  });

  it('leaves unnamed and blank-named estimates alone — that is the stage working as designed', async () => {
    for (const id of [IDS.unnamedEstimate, IDS.blankNameEstimate]) {
      expect(await eventRow(id)).toMatchObject({
        has_coordinates: true,
        is_inferred: true,
        inference_sources: TEMPORAL_NN,
        confidence_score: 0.4,
        metadata: { location_source: 'estimated' },
      });
    }

    expect(await ledgerStages(IDS.unnamedEstimate)).toEqual(['enrich.estimate_location']);
  });

  it('is idempotent — a second run changes nothing', async () => {
    const snapshot = async () =>
      q(
        `SELECT 'event' AS t, event_id::text AS id,
                concat_ws('|', location_coordinates IS NULL, location_entity_id, metadata::text, is_inferred,
                          inference_sources::text, confidence_score) AS v
           FROM ci.events
          UNION ALL SELECT 'edge', relationship_id::text, relationship_type FROM ci.relationships
          UNION ALL SELECT 'delta', relationship_id::text, change_type FROM ci.graph_deltas
          UNION ALL SELECT 'place', entity_id::text, concat_ws('|', location_boundary IS NULL, properties::text)
                      FROM ci.entities WHERE entity_type = 'Location'
          UNION ALL SELECT 'ledger', entity_id::text, stage FROM ci.pipeline_state
          ORDER BY 1, 2, 3`,
      );

    const before = await snapshot();
    await applyMigration();

    expect(await snapshot()).toEqual(before);
  });
});
