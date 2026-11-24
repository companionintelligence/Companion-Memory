import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../../__tests__/support/scratchDatabase';
import { PipelineStateService } from '../../services/PipelineStateService';
import { eventHappenedSql } from '../enrich/EstimateLocationStage';
import {
  PLACE_UNCERTAINTY_FLOOR_METRES,
  PROMOTE_PLACE_SOURCE,
  PROMOTE_PLACE_STAGE_ID,
  PlacePromoteStage,
} from '../promote/PlacePromoteStage';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The place links promote.place wrote onto events that did not happen are
 * withdrawn — with the edges and footprints built on them, and nothing else.
 * Proved against real Postgres.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Before `PROMOTE_PLACE_SOURCE` applied `eventHappenedSql`, `promote.place`
 * linked a cancelled, no_show or skipped event, a prediction, and a Takeout
 * reservation marked `Canceled` to the Location at its venue, and
 * `promote.edge_event` projected an `event.happened_at` edge from the link.
 * The new predicate stops new links but cannot reach these (it gates every arm
 * of the sweep), so {@link MIGRATION} withdraws them. The reference corpus had
 * none, so every branch has a fixture here:
 *
 *  - each kind of event that did not happen, and each near miss that did (the
 *    list is written out, not the shared lifecycle table, so a status added to
 *    the schema later cannot change what this migration is held to);
 *  - an event that did not happen AND was deleted (withdrawn), and one that is
 *    only deleted (a tombstone keeps its edges, so restore is exact);
 *  - a creation delta a summary already read (amended, not erased);
 *  - a Location that keeps a real visit (footprint kept, the visit re-armed,
 *    and the stage re-derives the footprint without the withdrawn point);
 *  - a Location whose only other promote.place link is a tombstone the sweep
 *    will not offer (footprint cleared);
 *  - a Location merged into another (the edge points at the survivor);
 *  - a link another writer made, a receipt's LOCATED_AT edge over the same
 *    pair, and a footprint a person drew (all kept);
 *  - a withdrawn event that is reinstated afterwards is offered to the real
 *    stage again and re-linked, which is what deleting its ledger row is for.
 *
 * Runs on a database of its own — the migration is unscoped, so pointing it at
 * a shared one would repair that database's rows too. Skips (loudly) without
 * an administrative connection; see `domains/__tests__/support/scratchDatabase.ts`.
 */

const MIGRATION = '20261001153044_withdraw_place_links_from_events_that_did_not_happen.sql';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../db/postgres/migrations');

/** The `-- migrate:up` half of the migration, as dbmate would run it. */
function migrationUpSql(): string {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
  const down = sql.indexOf('-- migrate:down');

  return down === -1 ? sql : sql.slice(0, down);
}

/** Runs of whitespace as one space, so SQL laid out over lines compares as text. */
const squash = (sql: string): string => sql.replace(/\s+/g, ' ');

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/PlaceLinkDidNotHappenRepair.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(600_000);

const USER = '22222222-2222-4222-8222-222222222222';

/** promote.place's provenance on a link it wrote. */
const PROMOTE_LINK = { stage: 'promote.place', version: 1, at: '2026-09-29T00:00:00Z' };

/** The footprint promote.place derived, wider than the floor: a hull over several points. */
const DERIVED_FOOTPRINT_METRES = 500;

/** What an event says about whether it happened. Defaults: a confirmed calendar event. */
interface Lifecycle {
  status?: string;
  isDeleted?: boolean;
  isPredicted?: boolean | null;
  sourceSystem?: string;
  metadata?: Record<string, unknown>;
}

/** A Google Takeout reservation, as `import/datasources/google_purchases.ts` writes one. */
const RESERVATION = { Kind: 'reservation', Name: 'Reservation', Source: 'Google' };

/**
 * Every kind of event, linked by promote.place before the rule. `withdrawn` is
 * what the migration must do to it. Each gets a Location of its own.
 */
const CASES: ReadonlyArray<{ name: string; lifecycle: Lifecycle; withdrawn: boolean }> = [
  { name: 'cancelled', lifecycle: { status: 'cancelled' }, withdrawn: true },
  { name: 'no_show', lifecycle: { status: 'no_show' }, withdrawn: true },
  { name: 'skipped', lifecycle: { status: 'skipped' }, withdrawn: true },
  { name: 'predicted', lifecycle: { isPredicted: true }, withdrawn: true },
  {
    name: 'reservation Canceled: true',
    lifecycle: { sourceSystem: 'google_purchases', metadata: { ...RESERVATION, Canceled: true } },
    withdrawn: true,
  },
  // Restoring it would give back an event that did not happen.
  { name: 'cancelled, then deleted', lifecycle: { status: 'cancelled', isDeleted: true }, withdrawn: true },
  // Near misses: each happened.
  { name: 'confirmed', lifecycle: {}, withdrawn: false },
  { name: 'tentative', lifecycle: { status: 'tentative' }, withdrawn: false },
  { name: 'rescheduled', lifecycle: { status: 'rescheduled' }, withdrawn: false },
  { name: 'completed', lifecycle: { status: 'completed' }, withdrawn: false },
  { name: 'planned', lifecycle: { status: 'planned' }, withdrawn: false },
  { name: 'in_progress', lifecycle: { status: 'in_progress' }, withdrawn: false },
  // NULL is not a prediction: the column defaults to false.
  { name: 'is_predicted NULL', lifecycle: { isPredicted: null }, withdrawn: false },
  {
    name: 'reservation Canceled: false',
    lifecycle: { sourceSystem: 'google_purchases', metadata: { ...RESERVATION, Canceled: false } },
    withdrawn: false,
  },
  // A tombstone keeps its link and its edge, so that restoring it is exact.
  { name: 'deleted, otherwise happened', lifecycle: { isDeleted: true }, withdrawn: false },
];

/** Fixed ids for the structural fixtures, so "this row kept its link" is a thing an assertion can state. */
const IDS = {
  // Locations
  summarized: 'b1000000-0000-4000-8000-000000000001',
  shared: 'b1000000-0000-4000-8000-000000000002',
  tombstoneOnly: 'b1000000-0000-4000-8000-000000000003',
  mergedLoser: 'b1000000-0000-4000-8000-000000000004',
  mergedSurvivor: 'b1000000-0000-4000-8000-000000000005',
  otherWriters: 'b1000000-0000-4000-8000-000000000006',
  receiptPlace: 'b1000000-0000-4000-8000-000000000007',
  handDrawn: 'b1000000-0000-4000-8000-000000000008',
  // Events that did not happen
  summarizedEvent: 'e1000000-0000-4000-8000-000000000001',
  sharedCancelled: 'e1000000-0000-4000-8000-000000000002',
  tombstoneCancelled: 'e1000000-0000-4000-8000-000000000003',
  toMerged: 'e1000000-0000-4000-8000-000000000004',
  foreignLink: 'e1000000-0000-4000-8000-000000000005',
  receiptEvent: 'e1000000-0000-4000-8000-000000000006',
  handDrawnEvent: 'e1000000-0000-4000-8000-000000000007',
  // Events that happened, or are only deleted
  sharedVisit: 'e1000000-0000-4000-8000-000000000011',
  tombstoneVisit: 'e1000000-0000-4000-8000-000000000012',
  // Graph
  summarizedEdge: 'f1000000-0000-4000-8000-000000000001',
  sharedCancelledEdge: 'f1000000-0000-4000-8000-000000000002',
  sharedVisitEdge: 'f1000000-0000-4000-8000-000000000003',
  tombstoneCancelledEdge: 'f1000000-0000-4000-8000-000000000004',
  tombstoneVisitEdge: 'f1000000-0000-4000-8000-000000000005',
  toMergedEdge: 'f1000000-0000-4000-8000-000000000006',
  foreignLinkEdge: 'f1000000-0000-4000-8000-000000000007',
  receiptEdge: 'f1000000-0000-4000-8000-000000000008',
  summary: 'a1000000-0000-4000-8000-000000000001',
};

/** A point per Location, two cells apart: `entities_location_snap_dedup_uniq` allows one Location per owner per 0.001-degree cell. */
const pointFor = (n: number) => ({ lat: 51.5 + n * 0.002, lng: -0.12 });

describeWithDatabase(`withdraw place links from events that did not happen (${availability.target})`, () => {
  let scratch: ScratchDatabase;

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    scratch.dataSource.query(sql, params);

  /** The id each case's event and Location were seeded under. */
  const caseIds = new Map<string, { event: string; location: string; edge: string; venue: string }>();
  /** Location id by venue name, for the stage's `PlaceService` stand-in. */
  const locationByVenue = new Map<string, string>();
  const locationPoint = new Map<string, { lat: number; lng: number }>();
  let points = 0;

  async function location(
    id: string,
    name: string,
    opts: { footprint?: 'promote' | 'hand'; mergedInto?: string } = {},
  ): Promise<{ lat: number; lng: number }> {
    const point = pointFor((points += 1));

    await q(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, properties, location_point,
                                place_kind, location_boundary, merged_into_entity_id, is_active)
       VALUES ($1::uuid, 'Location', $2, $3::uuid, $4::jsonb,
               ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, 'address',
               CASE WHEN $7::float8 IS NOT NULL
                    THEN ST_Buffer(ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7::float8)::geography END,
               $8::uuid, $8::uuid IS NULL)`,
      [
        id,
        name,
        USER,
        JSON.stringify({
          source: 'forward_geocode',
          ...(opts.footprint === 'promote'
            ? {
                promote: {
                  stage: 'promote.place',
                  version: 1,
                  boundary_metres: DERIVED_FOOTPRINT_METRES,
                },
              }
            : {}),
        }),
        point.lng,
        point.lat,
        opts.footprint === 'promote' ? DERIVED_FOOTPRINT_METRES : opts.footprint === 'hand' ? 40 : null,
        opts.mergedInto ?? null,
      ],
    );
    locationByVenue.set(name, id);
    locationPoint.set(id, point);

    return point;
  }

  async function event(
    id: string,
    args: {
      title: string;
      venue: string;
      point: { lat: number; lng: number };
      lifecycle: Lifecycle;
      linkedTo: string;
      /** Linked by promote.place (its marker), rather than by another writer. */
      promoted: boolean;
    },
  ): Promise<void> {
    const deleted = args.lifecycle.isDeleted === true;

    await q(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, linked_table, linked_id, is_active)
       VALUES ($1::uuid, 'Event', $2, $3::uuid, 'events', $1::uuid, $4)`,
      [id, args.title, USER, !deleted],
    );
    await q(
      `INSERT INTO ci.events (event_id, user_id, start_time, source_type, source_system, source_id,
                              location_name, location_coordinates, location_entity_id, metadata,
                              status, is_deleted, is_predicted)
       VALUES ($1::uuid, $2::uuid, '2026-05-01T10:00:00Z', 'ci.import', $3, $1::text,
               $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7::uuid, $8::jsonb,
               $9, $10, $11)`,
      [
        id,
        USER,
        args.lifecycle.sourceSystem ?? 'calendar',
        args.venue,
        args.point.lng,
        args.point.lat,
        args.linkedTo,
        JSON.stringify({
          Location: args.venue,
          ...(args.lifecycle.metadata ?? {}),
          ...(args.promoted ? { promote: PROMOTE_LINK } : {}),
        }),
        args.lifecycle.status ?? 'confirmed',
        deleted,
        args.lifecycle.isPredicted === undefined ? false : args.lifecycle.isPredicted,
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

  const EVERY_STAGE = ['promote.place', 'promote.edge_event', 'index.vector_event'];

  /** A promote.place link the way the stage left it: link, edge, unread delta, ledger. */
  async function promotedVisit(
    eventId: string,
    edgeId: string,
    locationId: string,
    args: { title: string; venue: string; point: { lat: number; lng: number }; lifecycle: Lifecycle },
  ): Promise<void> {
    await event(eventId, { ...args, linkedTo: locationId, promoted: true });
    await edge(edgeId, eventId, locationId, 'event.happened_at');
    await ledger(eventId, EVERY_STAGE);
  }

  async function seed(): Promise<void> {
    await q(`INSERT INTO ci.users (id, email, name) VALUES ($1::uuid, 'repair@example.invalid', 'U')`, [
      USER,
    ]);
    await q(
      `INSERT INTO ci.summaries (summary_id, user_id, period_start, period_end, period_type, source_types)
       VALUES ($1::uuid, $2::uuid, '2026-05-01', '2026-05-02', 'daily', ARRAY['graph'])`,
      [IDS.summary, USER],
    );

    // One Location, one event and one edge per case, ids derived from its index.
    for (const [index, c] of CASES.entries()) {
      const n = String(index + 1).padStart(12, '0');
      const ids = {
        location: `c0000000-0000-4000-8000-${n}`,
        event: `d0000000-0000-4000-8000-${n}`,
        edge: `f0000000-0000-4000-8000-${n}`,
        venue: `${c.name} venue`,
      };
      const point = await location(ids.location, ids.venue, { footprint: 'promote' });

      await promotedVisit(ids.event, ids.edge, ids.location, {
        title: c.name,
        venue: ids.venue,
        point,
        lifecycle: c.lifecycle,
      });
      caseIds.set(c.name, ids);
    }

    const CANCELLED: Lifecycle = { status: 'cancelled' };

    // A summary has already read this edge's creation.
    const summarizedAt = await location(IDS.summarized, 'Summarized venue', { footprint: 'promote' });
    await event(IDS.summarizedEvent, {
      title: 'Read by a summary',
      venue: 'Summarized venue',
      point: summarizedAt,
      lifecycle: CANCELLED,
      linkedTo: IDS.summarized,
      promoted: true,
    });
    await edge(IDS.summarizedEdge, IDS.summarizedEvent, IDS.summarized, 'event.happened_at', IDS.summary);

    // A venue the user did visit, and a cancelled meeting ~55 m away that
    // promote.place folded into the same Location.
    const sharedAt = await location(IDS.shared, 'Shared venue', { footprint: 'promote' });
    await promotedVisit(IDS.sharedVisit, IDS.sharedVisitEdge, IDS.shared, {
      title: 'Visit',
      venue: 'Shared venue',
      point: sharedAt,
      lifecycle: {},
    });
    await promotedVisit(IDS.sharedCancelled, IDS.sharedCancelledEdge, IDS.shared, {
      title: 'Called off',
      venue: 'Shared venue',
      point: { lat: sharedAt.lat + 0.0005, lng: sharedAt.lng },
      lifecycle: CANCELLED,
    });

    // The only other promote.place link is on a tombstone, which the sweep
    // will not offer, so nothing could re-derive this footprint.
    const tombstoneAt = await location(IDS.tombstoneOnly, 'Tombstone venue', { footprint: 'promote' });
    await promotedVisit(IDS.tombstoneVisit, IDS.tombstoneVisitEdge, IDS.tombstoneOnly, {
      title: 'Deleted visit',
      venue: 'Tombstone venue',
      point: tombstoneAt,
      lifecycle: { isDeleted: true },
    });
    await promotedVisit(IDS.tombstoneCancelled, IDS.tombstoneCancelledEdge, IDS.tombstoneOnly, {
      title: 'Called off too',
      venue: 'Tombstone venue',
      point: tombstoneAt,
      lifecycle: CANCELLED,
    });

    // Linked to a Location that has since been merged: the projection wrote
    // the edge to the survivor.
    await location(IDS.mergedSurvivor, 'Merged survivor');
    const loserAt = await location(IDS.mergedLoser, 'Merged loser', {
      footprint: 'promote',
      mergedInto: IDS.mergedSurvivor,
    });
    await promotedVisit(IDS.toMerged, IDS.toMergedEdge, IDS.mergedSurvivor, {
      title: 'Called off, merged',
      venue: 'Merged loser',
      point: loserAt,
      lifecycle: CANCELLED,
    });
    await q(`UPDATE ci.events SET location_entity_id = $2::uuid WHERE event_id = $1::uuid`, [
      IDS.toMerged,
      IDS.mergedLoser,
    ]);

    // A link some OTHER writer made: no promote marker.
    const foreignAt = await location(IDS.otherWriters, 'Other writer venue');
    await event(IDS.foreignLink, {
      title: 'Linked elsewhere',
      venue: 'Other writer venue',
      point: foreignAt,
      lifecycle: CANCELLED,
      linkedTo: IDS.otherWriters,
      promoted: false,
    });
    await edge(IDS.foreignLinkEdge, IDS.foreignLink, IDS.otherWriters, 'event.happened_at');

    // The pair's LOCATED_AT edge was projected from a receipt, not the link.
    const receiptAt = await location(IDS.receiptPlace, 'Receipt venue', { footprint: 'promote' });
    await event(IDS.receiptEvent, {
      title: 'Refunded',
      venue: 'Receipt venue',
      point: receiptAt,
      lifecycle: CANCELLED,
      linkedTo: IDS.receiptPlace,
      promoted: true,
    });
    await edge(IDS.receiptEdge, IDS.receiptEvent, IDS.receiptPlace, 'receipt.happened_at');

    // A footprint a person drew: no promote provenance.
    const handAt = await location(IDS.handDrawn, 'Hand-drawn venue', { footprint: 'hand' });
    await event(IDS.handDrawnEvent, {
      title: 'Called off, drawn',
      venue: 'Hand-drawn venue',
      point: handAt,
      lifecycle: CANCELLED,
      linkedTo: IDS.handDrawn,
      promoted: true,
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
      location_entity_id: string | null;
      metadata: Record<string, unknown>;
      has_coordinates: boolean;
      location_name: string | null;
    }>(
      `SELECT location_entity_id, metadata, location_coordinates IS NOT NULL AS has_coordinates, location_name
         FROM ci.events WHERE event_id = $1::uuid`,
      [id],
    );

    return row;
  }

  async function placeRow(id: string) {
    const [row] = await q<{
      is_active: boolean;
      has_boundary: boolean;
      promote: unknown;
      radius_m: number | null;
    }>(
      `SELECT is_active, location_boundary IS NOT NULL AS has_boundary, properties->'promote' AS promote,
              sqrt(ST_Area(location_boundary) / pi()) AS radius_m
         FROM ci.entities WHERE entity_id = $1::uuid`,
      [id],
    );

    return { ...row, radius_m: row.radius_m == null ? null : Number(row.radius_m) };
  }

  const edgeExists = async (id: string): Promise<boolean> =>
    (await q(`SELECT 1 FROM ci.relationships WHERE relationship_id = $1::uuid`, [id])).length > 0;

  const deltas = (relationshipId: string) =>
    q<{ change_type: string; summary_id: string | null }>(
      `SELECT change_type, summary_id FROM ci.graph_deltas
        WHERE relationship_id = $1::uuid ORDER BY changed_at, delta_id`,
      [relationshipId],
    );

  const ledgerStages = async (id: string): Promise<string[]> =>
    (
      await q<{ stage: string }>(
        `SELECT stage FROM ci.pipeline_state WHERE entity_id = $1::uuid ORDER BY 1`,
        [id],
      )
    ).map((row) => row.stage);

  /** The real stage and ledger, on the scratch database. */
  function realStage() {
    const logger = {
      setContext: jest.fn(),
      log: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const stage = new PlacePromoteStage(
      scratch.dataSource,
      {
        // The Locations already exist, by venue name, as findOrCreateForGeocode
        // would find them.
        findOrCreateForGeocode: async (_ctx: unknown, input: { name: string }) => ({
          id: locationByVenue.get(input.name)!,
          created: false,
        }),
      } as never,
      logger as never,
    );

    return { stage, ledger: new PipelineStateService(scratch.dataSource, logger as never) };
  }

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'place links that did not happen repair' });
    await seed();
    await applyMigration();
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it("selects by the stage's own rule, minus the deletion clause", () => {
    // The working set is NOT (eventHappenedSql) without `is_deleted`, and a
    // surviving visit is one PROMOTE_PLACE_SOURCE would offer. Pinned as text
    // because `status` and `is_deleted` are NOT NULL, so a COALESCE dropped
    // from either passes every case below. This migration is history: if the
    // rule moves on, pin this to the text it was written against.
    const sql = squash(migrationUpSql());
    const clauses = eventHappenedSql('e')
      .split(' AND ')
      .filter((clause) => !clause.includes('is_deleted'));

    expect(clauses).toHaveLength(3);
    expect(sql).toContain(`AND NOT (${clauses.join(' AND ')});`);
    expect(sql).toContain(squash(PROMOTE_PLACE_SOURCE.predicate!.replace(/\bs\./g, 'o.')));
  });

  describe.each(CASES.map((c) => [c.name, c.withdrawn] as const))('%s (withdrawn: %s)', (name, withdrawn) => {
    it('loses its link and promote marker only if withdrawn, and keeps its coordinate and name', async () => {
      const ids = caseIds.get(name)!;
      const row = await eventRow(ids.event);

      expect(row).toMatchObject({ has_coordinates: true, location_name: ids.venue });
      expect(row.location_entity_id).toBe(withdrawn ? null : ids.location);
      // Only the key this stage wrote; the importer's own survive.
      expect(row.metadata.Location).toBe(ids.venue);
      expect('promote' in row.metadata).toBe(!withdrawn);
    });

    it('loses its event.happened_at edge and the unread delta only if withdrawn', async () => {
      const ids = caseIds.get(name)!;

      expect(await edgeExists(ids.edge)).toBe(!withdrawn);
      expect(await deltas(ids.edge)).toEqual(withdrawn ? [] : [{ change_type: 'created', summary_id: null }]);
    });

    it('leaves its Location in place, clearing the footprint derived from it only if withdrawn', async () => {
      const place = await placeRow(caseIds.get(name)!.location);

      expect(place.is_active).toBe(true);
      expect(place.has_boundary).toBe(!withdrawn);
      expect(place.promote == null).toBe(withdrawn);
    });

    it('re-arms promote.place only if withdrawn, and nothing else', async () => {
      expect(await ledgerStages(caseIds.get(name)!.event)).toEqual(
        withdrawn ? ['index.vector_event', 'promote.edge_event'] : [...EVERY_STAGE].sort(),
      );
    });
  });

  it('amends, rather than erases, a creation delta a summary already read', async () => {
    expect(await edgeExists(IDS.summarizedEdge)).toBe(false);
    expect(await deltas(IDS.summarizedEdge)).toEqual([
      { change_type: 'created', summary_id: IDS.summary },
      { change_type: 'deleted', summary_id: null },
    ]);
  });

  it('keeps the footprint of a Location that still has a real visit, and re-arms that visit', async () => {
    expect((await eventRow(IDS.sharedCancelled)).location_entity_id).toBeNull();
    expect(await edgeExists(IDS.sharedCancelledEdge)).toBe(false);

    expect(await eventRow(IDS.sharedVisit)).toMatchObject({ location_entity_id: IDS.shared });
    expect(await edgeExists(IDS.sharedVisitEdge)).toBe(true);
    expect(await placeRow(IDS.shared)).toMatchObject({
      has_boundary: true,
      promote: { stage: 'promote.place' },
    });
    // promote.place recomputes the footprint from the links that are left; the
    // visit is the one its sweep will now re-offer. Its edge leg is left alone.
    expect(await ledgerStages(IDS.sharedVisit)).toEqual(['index.vector_event', 'promote.edge_event']);
  });

  it('clears a footprint whose only other promote.place link is a tombstone, and leaves the tombstone be', async () => {
    expect((await eventRow(IDS.tombstoneCancelled)).location_entity_id).toBeNull();
    expect(await placeRow(IDS.tombstoneOnly)).toMatchObject({
      is_active: true,
      has_boundary: false,
      promote: null,
    });

    expect(await eventRow(IDS.tombstoneVisit)).toMatchObject({ location_entity_id: IDS.tombstoneOnly });
    expect(await edgeExists(IDS.tombstoneVisitEdge)).toBe(true);
    expect(await ledgerStages(IDS.tombstoneVisit)).toEqual([...EVERY_STAGE].sort());
  });

  it('follows a merged Location to the survivor the edge was written to', async () => {
    expect(await edgeExists(IDS.toMergedEdge)).toBe(false);
    expect((await eventRow(IDS.toMerged)).location_entity_id).toBeNull();
  });

  it('keeps a link, and its edge, that another writer made', async () => {
    expect(await eventRow(IDS.foreignLink)).toMatchObject({ location_entity_id: IDS.otherWriters });
    expect(await edgeExists(IDS.foreignLinkEdge)).toBe(true);
  });

  it('keeps a LOCATED_AT edge a receipt projected over the same pair', async () => {
    expect(await edgeExists(IDS.receiptEdge)).toBe(true);
    // The link promote.place wrote is still withdrawn, and its footprint with it.
    expect((await eventRow(IDS.receiptEvent)).location_entity_id).toBeNull();
    expect(await placeRow(IDS.receiptPlace)).toMatchObject({ has_boundary: false, promote: null });
  });

  it('never touches a footprint a person drew', async () => {
    expect((await eventRow(IDS.handDrawnEvent)).location_entity_id).toBeNull();
    expect(await placeRow(IDS.handDrawn)).toMatchObject({ has_boundary: true, promote: null });
  });

  describe('then the stage', () => {
    it('does not offer a withdrawn event while it did not happen, and re-links it once reinstated', async () => {
      // Why statement 5 deletes the ledger row: the row said `done` at the
      // current version, so without it a reinstated event would never be
      // offered again, and would stay unlinked for good.
      const { stage, ledger: state } = realStage();
      const ids = caseIds.get('cancelled')!;

      expect(await state.selectStale(stage, USER, null, 1000)).not.toContain(ids.event);

      await q(`UPDATE ci.events SET status = 'confirmed' WHERE event_id = $1::uuid`, [ids.event]);

      expect(await state.selectStale(stage, USER, null, 1000)).toContain(ids.event);
      expect((await stage.run({ userId: USER }, [ids.event])).get(ids.event)).toMatchObject({
        outcome: 'done',
        detail: { placeEntityId: ids.location },
      });
      expect(await eventRow(ids.event)).toMatchObject({
        location_entity_id: ids.location,
        metadata: expect.objectContaining({
          promote: expect.objectContaining({ stage: PROMOTE_PLACE_STAGE_ID }),
        }),
      });
      // Its cleared footprint is derived again, from the one visit.
      expect((await placeRow(ids.location)).radius_m).toBeLessThan(PLACE_UNCERTAINTY_FLOOR_METRES * 1.05);
    });

    it('re-derives the shared footprint from the visit that is left', async () => {
      const { stage, ledger: state } = realStage();

      expect((await placeRow(IDS.shared)).radius_m).toBeGreaterThan(DERIVED_FOOTPRINT_METRES * 0.95);
      expect(await state.selectStale(stage, USER, null, 1000)).toContain(IDS.sharedVisit);

      await stage.run({ userId: USER }, [IDS.sharedVisit]);

      // One observation is left, so the footprint is the dedupe-cell floor.
      const place = await placeRow(IDS.shared);

      expect(place.radius_m).toBeGreaterThan(PLACE_UNCERTAINTY_FLOOR_METRES * 0.95);
      expect(place.radius_m).toBeLessThan(PLACE_UNCERTAINTY_FLOOR_METRES * 1.05);
    });
  });

  it('is idempotent — a second run changes nothing', async () => {
    const snapshot = async () =>
      q(
        `SELECT 'event' AS t, event_id::text AS id,
                concat_ws('|', location_entity_id, metadata::text, status) AS v
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
