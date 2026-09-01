import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
// The geocode domain's PUBLIC barrel — `no-cross-domain-internals` allows
// `index.ts` and `events.ts` and nothing else. Only the STATIC `hashQuery` is
// used, so nothing is injected and no provider is ever called: see
// {@link loadCachedComponents} for why a promoter that bills is a bug.
import { GeocodeService } from '@ci/domains/geocode';
// Likewise the memory barrel. `PlaceService.findOrCreateForGeocode` +
// `ensureHierarchy` already own place identity (provider place_id first, then
// the 0.001-degree snap cell) and the city -> region -> country fold. This stage
// composes them; it does not re-implement them. Two implementations of the
// admin-place dedupe would fork the hierarchy silently and permanently.
import { PlaceService } from '@ci/domains/memory';

import { PIPELINE_QUEUES } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, type StageVersion } from '../../versions';
// Intra-domain relative import, exactly as `EstimateLocationStage` does. The
// dependency is real: this stage's hierarchy comes from the address components
// the forward geocoder left in `ci.geocode_cache`, so a better provider produces
// a different hierarchy. See {@link PROMOTE_PLACE_VERSION}.
import { FORWARD_GEOCODE_PROVIDER_GENERATION } from '../enrich/GeocodeStage';

/**
 * This stage's id.
 *
 * Declared here ahead of its `STAGE_IDS` entry, exactly as
 * `ENRICH_GEOCODE_STAGE_ID` and `ENRICH_ESTIMATE_LOCATION_STAGE_ID` were: the
 * central wiring (`constants.ts`, `versions.ts`, `StageRegistry`,
 * `stageProviders`) is one reviewable change and this file is another. It
 * becomes `STAGE_IDS.PROMOTE_PLACE` — and this const its alias — in the change
 * that lands the four entries. `__tests__/stageWiring.spec.ts` fails, by name,
 * for as long as the two are apart, which is the point of that file.
 *
 * IDS ARE PERMANENT — the id is the third component of `ci.pipeline_state`'s
 * primary key, so renaming it abandons every ledger row written under the old
 * name and re-promotes the whole corpus under the new one.
 */
export const PROMOTE_PLACE_STAGE_ID = 'promote.place';

/** The ledger `entity_type` this stage records under. */
const ENTITY_TYPE = 'event';

// ---------------------------------------------------------------------------
// The version, DERIVED rather than chosen
// ---------------------------------------------------------------------------

/**
 * Generation of THIS stage's promotion rule — what a resolved event location
 * becomes in the place graph.
 *
 * Covers: which events are eligible (the ownership rule in
 * {@link decideLocally}), the leaf place's identity inputs (name, coordinate,
 * provider `place_id`), the footprint derivation in
 * {@link PLACE_UNCERTAINTY_FLOOR_METERS} / {@link LOCATION_TYPE_RADIUS_METERS},
 * and the `promote` provenance envelope. Bump it in the same commit that edits
 * any of them.
 */
export const PLACE_PROMOTION_RULE_GENERATION = 1;

/**
 * The stage version, derived so that improving EITHER input re-promotes
 * history.
 *
 * The second term is not decoration. A promoted place's HIERARCHY — its
 * `place_kind` chain and `parent_place_id` pointers — comes from the address
 * components the forward geocoder wrote into `ci.geocode_cache`, which this
 * stage reads and never re-requests. A better provider therefore makes every
 * existing hierarchy provisional in exactly the way a better decoder makes every
 * existing image dimension provisional, and the ledger is the only mechanism
 * that can re-open it. `EstimateLocationStage` tracks the same generation for
 * the same reason: its estimates are COPIES of geocoded coordinates.
 *
 * The derivation is a SUM (offset so that both-at-1 gives 1, because
 * `versions.ts` refuses a version below 1). A sum is monotone in each term, so
 * the version can only ever go UP — the invariant `versions.ts` states, and the
 * reason `EmbedStage` argues at length against `version = hash(...)`.
 *
 * Both terms must stay integers >= 1.
 */
export const PROMOTE_PLACE_VERSION =
  PLACE_PROMOTION_RULE_GENERATION + FORWARD_GEOCODE_PROVIDER_GENERATION - 1;

/**
 * The version this stage reports, cross-checked against `STAGE_VERSIONS`.
 *
 * `StageRegistry.assertConsistent` requires `stage.version` to equal
 * `STAGE_VERSIONS[id]`, because a hardcoded version would make bumping the
 * constant a silent no-op. A DERIVED version has the mirror-image failure: bump
 * a generation above, forget the one-line diff to `versions.ts`, and the
 * registry throws at the first sweep with a message about hardcoding that is not
 * what happened. So the derivation is the authority, the `STAGE_VERSIONS` entry
 * is its reviewable mirror, and a disagreement throws HERE.
 *
 * A missing entry is not an error — this file is imported by its own spec before
 * the `constants.ts` / `versions.ts` declarations land.
 */
export function promotePlaceStageVersion(versions: Record<string, StageVersion> = STAGE_VERSIONS): number {
  const declared = versions[PROMOTE_PLACE_STAGE_ID];

  if (typeof declared === 'number' && declared !== PROMOTE_PLACE_VERSION) {
    throw new Error(
      `STAGE_VERSIONS["${PROMOTE_PLACE_STAGE_ID}"] declares ${declared} but the stage derives ` +
        `${PROMOTE_PLACE_VERSION} from PLACE_PROMOTION_RULE_GENERATION ` +
        `(${PLACE_PROMOTION_RULE_GENERATION}) + FORWARD_GEOCODE_PROVIDER_GENERATION ` +
        `(${FORWARD_GEOCODE_PROVIDER_GENERATION}) - 1. Bumping a generation is only half the ` +
        `change: update versions.ts in the same commit, or the two disagree about what has ` +
        `already been promoted.`,
    );
  }

  return PROMOTE_PLACE_VERSION;
}

// Run at module load rather than at the first sweep — the earliest possible
// failure is the cheapest one, on the operator's terminal rather than inside a
// worker on whichever appliance reaches this stage first.
promotePlaceStageVersion();

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Where the sweep looks, and which rows this stage APPLIES to.
 *
 * ── READ THIS BEFORE ADDING `s.location_entity_id IS NULL` ─────────────────
 *
 * That is this stage's OUTPUT column, and it is the ratchet the whole rebuild
 * exists to delete. A predicate over it conflates three different facts:
 *
 *  - never promoted;
 *  - promoted, and the place resolution legitimately produced nothing;
 *  - promoted successfully, under a hierarchy rule or a geocode provider we now
 *    know was worse — the unparented `address` nodes this stage produces
 *    whenever `ci.geocode_cache` held no address components for the name.
 *
 * The third is the one that matters here and it is the one a nullability
 * predicate can never reach: the row HAS a link, so it leaves the candidate set
 * forever, and warming the geocode cache could not repair a single one of them.
 * With the ledger, the repair is `PLACE_PROMOTION_RULE_GENERATION += 1`.
 *
 * What the predicate DOES say is what a row IS: a live event that carries BOTH a
 * resolved coordinate and a name for it. Both are INPUTS, written by importers,
 * `enrich.geocode` and `enrich.estimate_location` — never by this stage.
 *
 * Requiring a name as well as a coordinate is a real narrowing, and it is
 * deliberate. On the appliance this was written against, 358 events carry
 * coordinates and 76 carry both; the other 282 are Uber GPS fixes and geotagged
 * tweets with no label. A place needs a name to be a place — minting
 * "Location(unnamed)" rows at 282 distinct coordinates would fill the place list
 * with noise that no later stage could tell from a real venue. Those rows become
 * candidates the moment `enrich.position_reverse` gives them a name, with no
 * change here.
 */
export const PROMOTE_PLACE_SOURCE: StageSource = {
  schema: 'ci',
  table: 'events',
  idColumn: 'event_id',
  userColumn: 'user_id',
  predicate:
    `s.location_coordinates IS NOT NULL ` +
    `AND s.location_name IS NOT NULL ` +
    `AND btrim(s.location_name) <> '' ` +
    `AND COALESCE(s.is_deleted, false) = false`,
};

// ---------------------------------------------------------------------------
// The promotion rule
// ---------------------------------------------------------------------------

/**
 * The `metadata.promote.stage` marker this stage stamps on every event it links,
 * and the ONLY value that lets it re-link one.
 *
 * `ci.events.location_entity_id` has more than one writer —
 * `GeocodeBatchListener` fills it from the reverse-geocode path, and importers
 * may arrive with a link already resolved. Ownership, not nullability, decides
 * what a version bump may touch: this stage replaces links it wrote, and refuses
 * everything else with `skipped: place_link_not_owned`. That is the same rule
 * `GeocodeStage` applies to `location_coordinates` via
 * `OVERWRITABLE_LOCATION_SOURCES`, and it exists for the same reason — a bump
 * must never let this stage's answer silently destroy a better one.
 */
const PROMOTE_PROVENANCE_KEY = 'promote';

/**
 * The floor on a promoted place's footprint radius, in metres.
 *
 * NOT a guess. `entities_location_snap_dedup_uniq` is
 * `UNIQUE (owner_user_id, ST_SnapToGrid(location_point::geometry, 0.001))`, so
 * this system ALREADY declares two coordinates in the same 0.001-degree cell to
 * be the same place. Half that cell, in latitude, is the greatest distance a
 * contributing coordinate can be from the cell it was folded into — which makes
 * it the smallest footprint the place model is entitled to claim, whatever the
 * geocoder says about its own precision.
 *
 * Latitude is used rather than longitude because a degree of longitude shrinks
 * with the cosine of latitude; taking the larger of the two axes keeps the
 * footprint a bound rather than an under-estimate.
 */
const SNAP_CELL_DEGREES = 0.001;
const METRES_PER_DEGREE_LATITUDE = 111_320;
export const PLACE_UNCERTAINTY_FLOOR_METRES = (SNAP_CELL_DEGREES * METRES_PER_DEGREE_LATITUDE) / 2;

/**
 * Positional uncertainty per geocode precision class, in metres.
 *
 * DECLARED, not measured — these are the provider's own documented precision
 * tiers, and they are the same four `GeocodeService.confidenceForLocationType`
 * already maps to confidences (0.95 / 0.9 / 0.8 / 0.4). Keeping the two tables
 * in the same order is the whole of the claim being made: a rooftop hit is a
 * building, an `APPROXIMATE` hit is a city centroid, and a footprint that did not
 * say so would let a promoted city centroid render as a doorway.
 *
 * An unknown or absent class contributes NOTHING — the floor applies, and the
 * footprint says only what the observations themselves say. That is the
 * difference between deriving a bound and inventing one.
 */
export const LOCATION_TYPE_RADIUS_METRES: Readonly<Record<string, number>> = {
  ROOFTOP: 25,
  RANGE_INTERPOLATED: 75,
  GEOMETRIC_CENTER: 200,
  APPROXIMATE: 1_500,
};

/** A slice row: identity, the two inputs, and who owns the existing link. */
interface CandidateRow {
  id: string;
  location_name: string | null;
  /** NULL when the coordinate was cleared between the sweep and the slice. */
  lat: number | null;
  lng: number | null;
  location_entity_id: string | null;
  /** `metadata->'promote'->>'stage'`, i.e. which stage claims the existing link. */
  promoted_by: string | null;
  is_deleted: boolean | null;
}

/** One `ci.geocode_cache` hit: the hierarchy inputs, for free. */
interface CachedResolution {
  place_id: string | null;
  components: Record<string, unknown> | null;
  location_type: string | null;
}

/**
 * One distinct place within a slice. Many events at one venue resolve it once.
 *
 * The key deliberately mirrors `PlaceService`'s own identity — trimmed
 * lower-cased name plus the 3-decimal-place cell — so collapsing two events here
 * is exact rather than approximate: two rows with the same key are two rows
 * `findOrCreateForGeocode` would return the same entity id for.
 */
interface PlaceGroup {
  key: string;
  name: string;
  lat: number;
  lng: number;
  eventIds: string[];
  cached: CachedResolution | null;
}

/** What one promoted event writes back onto `ci.events`. */
interface EventLink {
  placeEntityId: string;
}

/**
 * Promotes resolved event locations into first-class places.
 *
 * This is the stage `GeocodeStage`'s own documentation asks for by name: *"It
 * belongs in a `promote.place_link` stage reading the components this stage's
 * provider answer already put in `ci.geocode_cache`"*. Splitting it out is what
 * lets a better place-dedupe rule re-run over the whole corpus without
 * re-billing the geocoder — one integer per decision instead of one integer for
 * both.
 *
 * ── What it writes, and where each is read ─────────────────────────────────
 *
 * The Phase 8 gate is that every table a promoter writes gets a read path in the
 * same change. Both of these had one already:
 *
 *  - `ci.entities` (Location) — `name`, `place_kind`, `parent_place_id`,
 *    `location_point` via `PlaceService.findOrCreateForGeocode` /
 *    `ensureHierarchy`; `location_boundary` here. READ by
 *    `PlaceService.findAll` / `findById` / `findByIds` / `placesNear` →
 *    `PlaceResolver.places` / `place` / `placesNear` and `PlaceLoader`. Creation
 *    also emits `PlaceCreatedEvent`, which is what puts the place in the search
 *    index.
 *  - `ci.events.location_entity_id` — READ by `PlaceService.getVisitStats`,
 *    reached from `PlaceType.visitStats` through `PlaceVisitStatsLoader`. That
 *    field returns zero for every place on the appliance today, because nothing
 *    has ever written the column: 0 of 324,044 events carry a link. **This stage
 *    is the reason that number stops being zero**, which is the honest test of
 *    whether a promoter did anything.
 *
 * `location_boundary` is the weakest of the three and it is worth being exact
 * about: the column is SELECTed by `PlaceEntity` (as `boundary`), returned by
 * `PlaceEntity.toEgressType`, and therefore present on every `Place` those four
 * service methods hand back — but `PlaceType` declares no `@Field` for it, so a
 * GraphQL client cannot yet select it. The one-line follow-up
 * (`@Field(() => GraphQLJSONObject, { nullable: true }) boundary`) lives in a
 * file this change does not own. It is read WITHIN this stage too, and not
 * decoratively: {@link writeFootprints} refuses to touch a boundary whose row
 * carries no `promote` provenance, so a user-drawn footprint survives every
 * future version bump.
 *
 * ── What it costs ─────────────────────────────────────────────────────────
 *
 * Nothing metered. A SWEEP OF THIS STAGE IS NOT A BILL, and that is a property
 * to protect: the hierarchy inputs come from `ci.geocode_cache` rows
 * `enrich.geocode` already paid for, read by primary key. If a future edit here
 * reaches for `GeocodeService.geocode()` on a cache miss, every version bump
 * becomes an invoice and the "re-promote freely" argument in the rebuild plan
 * (§8.4) stops being true.
 *
 * The consequence, stated plainly: on a cold cache this stage promotes places
 * WITHOUT a hierarchy — `place_kind = 'address'`, `parent_place_id = NULL`. That
 * is not a failure and is not recorded as one. It is a `done` at version N whose
 * hierarchy arrives when `enrich.geocode` has run and
 * `PLACE_PROMOTION_RULE_GENERATION` is bumped past N.
 *
 * ── Reversibility ─────────────────────────────────────────────────────────
 *
 * Every row this stage writes carries `{"promote": {"stage", "version",
 * "event_id"|"promoted_at"}}` — in `ci.events.metadata` for the link, in
 * `ci.entities.properties` for the footprint. Withdrawal is a predicate, not a
 * diff, and the exact statements are in migration
 * `20260809181915_promote_support.sql`. Nothing here mutates a source fact: the
 * coordinate and the name are read and never written.
 */
@Injectable()
export class PlacePromoteStage implements Stage {
  readonly id = PROMOTE_PLACE_STAGE_ID;

  /**
   * The DERIVED version — see {@link promotePlaceStageVersion}. Resolved ONCE at
   * construction, never as a getter: ids claimed at version 1 and completed at
   * version 2 would never be re-processed by the improvement that bump was for.
   */
  readonly version = promotePlaceStageVersion();

  /**
   * `pipeline-index`: Postgres-bound. No external call, no object storage, no
   * model. The rebuild plan reserves a `pipeline-promote` queue for this phase,
   * but queues exist one per RESOURCE CLASS rather than one per phase, and this
   * stage's resource class is the same Postgres `pipeline-index` already carries.
   * A fourth queue against a global budget of ten in-flight jobs would buy
   * scheduling noise; adding it is a `constants.ts` decision and belongs with a
   * promoter that is bound by something else.
   */
  readonly queue = PIPELINE_QUEUES.INDEX;

  readonly entityTypes = [ENTITY_TYPE] as const;

  readonly source = PROMOTE_PLACE_SOURCE;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly placeService: PlaceService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PlacePromoteStage.name);
  }

  /**
   * Promote one slice of events.
   *
   * Idempotent, as the contract requires: `findOrCreateForGeocode` resolves the
   * same (name, cell) to the same entity id however many times it is called, the
   * link write is an assignment, and the footprint is recomputed from the events
   * currently linked rather than accumulated. Two dispatchers racing the same id
   * cost one redundant UPDATE.
   *
   * Four phases: load and decide locally, resolve each DISTINCT place once, link
   * every event in one statement, recompute every touched footprint in one more.
   */
  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    const rows = await this.loadRows(ctx.userId, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Answer for the ids that came back with no row FIRST, so the map is
    // complete even if the work below throws in a way this does not model.
    for (const id of ids) {
      if (!byId.has(id)) {
        // Deleted outright, or re-owned, between the sweep and the slice. A skip:
        // there is nothing to retry and nothing was lost.
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    // Group by the place a row will resolve to BEFORE touching the database:
    // 200 events at five venues are five resolutions, not two hundred.
    const groups = new Map<string, PlaceGroup>();

    for (const row of rows) {
      const local = this.decideLocally(row);

      if (local != null) {
        results.set(row.id, local);

        continue;
      }

      // Non-null by construction: `decideLocally` returned null, which it only
      // does for a row carrying a name and both coordinates.
      const name = (row.location_name as string).trim();
      const lat = row.lat as number;
      const lng = row.lng as number;
      const key = placeGroupKey(name, lat, lng);
      const group = groups.get(key);

      if (group == null) {
        groups.set(key, { key, name, lat, lng, eventIds: [row.id], cached: null });
      } else {
        group.eventIds.push(row.id);
      }
    }

    if (groups.size === 0) {
      return results;
    }

    await this.attachCachedResolutions([...groups.values()]);

    /** Resolved links, keyed by event id, awaiting the one bulk UPDATE. */
    const links = new Map<string, EventLink>();
    /** entity id -> the coarsest positional uncertainty that contributed to it. */
    const footprintRadii = new Map<string, number>();

    // Sequential, not `Promise.all`. `findOrCreateForGeocode` is
    // INSERT ... ON CONFLICT DO NOTHING followed by SELECT, which is safe under
    // concurrency but resolves a race by doing the work twice; the grouping above
    // has already removed the only contention this slice can create with itself.
    for (const group of groups.values()) {
      try {
        const { id: placeEntityId } = await this.placeService.findOrCreateForGeocode(ctx, {
          name: group.name,
          lat: group.lat,
          lng: group.lng,
          placeId: group.cached?.place_id ?? null,
          components: group.cached?.components ?? null,
        });

        for (const eventId of group.eventIds) {
          links.set(eventId, { placeEntityId });
        }

        const radius = radiusForLocationType(group.cached?.location_type ?? null);
        footprintRadii.set(placeEntityId, Math.max(footprintRadii.get(placeEntityId) ?? 0, radius));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        // FAILED, not skipped: `findOrCreateForGeocode` throws on a unique-index
        // race it could not resolve and on a transport failure, and both are
        // worth retrying on the ledger's own schedule. Scoped to this group's
        // ids — one unresolvable venue must not charge the other 199 events an
        // attempt.
        for (const eventId of group.eventIds) {
          results.set(eventId, {
            outcome: 'failed',
            reason: 'place_resolve_failed',
            detail: { message, place: group.name },
          });
        }

        this.logger.warn('Place resolution failed', { place: group.name, message });
      }
    }

    if (links.size === 0) {
      return results;
    }

    try {
      await this.writeEventLinks(ctx.userId, links);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // One statement means one outcome: it committed or it did not, so every row
      // in it shares the verdict. Attributing it to one id would be a guess.
      for (const eventId of links.keys()) {
        results.set(eventId, {
          outcome: 'failed',
          reason: 'place_link_write_failed',
          detail: { message },
        });
      }

      this.logger.error(
        `Place link write failed for ${links.size} events`,
        err instanceof Error ? err : new Error(message),
      );

      return results;
    }

    // The footprint is derived FROM the links just written, so it runs after them
    // and never before. A failure here does not un-promote the event: the link is
    // the promotion and the boundary is enrichment on top of it, so the outcome
    // stays `done` and the boundary is recomputed by the next version bump.
    let footprintError: string | null = null;

    try {
      await this.writeFootprints(ctx.userId, footprintRadii);
    } catch (err: unknown) {
      footprintError = err instanceof Error ? err.message : String(err);

      this.logger.warn('Place footprint write failed', { message: footprintError });
    }

    for (const [eventId, link] of links) {
      results.set(eventId, {
        outcome: 'done',
        detail: {
          placeEntityId: link.placeEntityId,
          ...(footprintError != null ? { footprintError } : {}),
        },
      });
    }

    return results;
  }

  /**
   * Everything decidable without touching another table.
   *
   * Returns a terminal result, or `null` when the row should be promoted.
   */
  private decideLocally(row: CandidateRow): StageResult | null {
    if (row.is_deleted === true) {
      // Soft-deleted between the sweep and the slice. Distinct from
      // `source_row_missing` because the row is still there and comes back if it
      // is undeleted.
      return { outcome: 'skipped', reason: 'event_deleted' };
    }

    if (row.lat == null || row.lng == null) {
      // The applicability predicate requires a coordinate, so this is one cleared
      // mid-flight, or a dead letter replayed weeks later carrying stale ids.
      return { outcome: 'skipped', reason: 'no_coordinates' };
    }

    if (row.location_name == null || row.location_name.trim().length === 0) {
      return { outcome: 'skipped', reason: 'no_location_name' };
    }

    if (row.location_entity_id != null && row.promoted_by !== PROMOTE_PLACE_STAGE_ID) {
      // A link this stage did not write — `GeocodeBatchListener`'s, or an
      // importer's. Ownership, not nullability: re-pointing it would let a bump
      // silently move an event to a place a better-informed writer had already
      // chosen. Countable, and reopenable the moment that writer is retired.
      return {
        outcome: 'skipped',
        reason: 'place_link_not_owned',
        detail: { locationEntityId: row.location_entity_id, promotedBy: row.promoted_by },
      };
    }

    return null;
  }

  /**
   * The slice's events, in one statement.
   *
   * Raw SQL rather than `CalendarEventService`, for the reason `EmbedStage` gives about
   * `ContentService`: the columns wanted are a strict subset of a ~40-column row
   * carrying jsonb blobs, at 200 rows a slice.
   *
   * The coordinate comes back as two floats rather than a geography, because
   * `PlaceService` takes `{lat, lng}` and the round trip through WKB would buy
   * nothing. PostGIS orders coordinates X, Y — so `ST_Y` is the LATITUDE, and it
   * is spelled that way everywhere in this subsystem precisely because the
   * transposition is the classic bug in this neighbourhood.
   *
   * User-scoped even though the sweep already was: a slice can arrive from a dead
   * letter replayed weeks later, and re-scoping is the difference between "this
   * id is not yours" and writing a place link onto someone else's calendar.
   */
  private loadRows(userId: string, ids: string[]): Promise<CandidateRow[]> {
    return this.dataSource.query<CandidateRow[]>(
      `SELECT e.event_id                                    AS id,
              e.location_name,
              ST_Y(e.location_coordinates::geometry)        AS lat,
              ST_X(e.location_coordinates::geometry)        AS lng,
              e.location_entity_id,
              e.metadata->'${PROMOTE_PROVENANCE_KEY}'->>'stage' AS promoted_by,
              e.is_deleted
         FROM ci.events e
        WHERE e.event_id = ANY($1::uuid[])
          AND e.user_id = $2::uuid`,
      [ids, userId],
    );
  }

  /**
   * Attach each group's `ci.geocode_cache` row, if `enrich.geocode` already paid
   * for one.
   *
   * READ-ONLY, BY PRIMARY KEY, AND NEVER A PROVIDER CALL. `GeocodeService`'s
   * cache is keyed `sha256(canonicalize(raw))`, and `hashQuery` is the public
   * static that computes it — called here rather than re-implemented, so a hit is
   * guaranteed to be the same row `GeocodeService.geocode` would have read. A
   * miss yields no hierarchy and no precision class, which is a legitimate
   * outcome and not an error; see the class docblock.
   *
   * A failure is swallowed to a warning: the cache is an ENRICHMENT input, and a
   * place with no hierarchy is strictly better than no place at all. Failing the
   * slice over it would make an unavailable cache table look like an
   * unpromotable corpus.
   */
  private async attachCachedResolutions(groups: PlaceGroup[]): Promise<void> {
    const byHash = new Map<string, PlaceGroup[]>();

    for (const group of groups) {
      const hash = GeocodeService.hashQuery(group.name);
      const bucket = byHash.get(hash);

      if (bucket == null) {
        byHash.set(hash, [group]);
      } else {
        bucket.push(group);
      }
    }

    try {
      const rows = await this.dataSource.query<Array<CachedResolution & { query_hash: string }>>(
        `SELECT c.query_hash, c.place_id, c.components, c.location_type
           FROM ci.geocode_cache c
          WHERE c.query_hash = ANY($1::text[])
            AND c.status = 'OK'`,
        [[...byHash.keys()]],
      );

      for (const row of rows) {
        for (const group of byHash.get(row.query_hash) ?? []) {
          group.cached = {
            place_id: row.place_id,
            components: row.components,
            location_type: row.location_type,
          };
        }
      }
    } catch (err: unknown) {
      this.logger.warn('Geocode cache lookup failed; promoting without hierarchy', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Link every promoted event in ONE statement.
   *
   * `unnest()` over parallel arrays, one round trip per slice — the same shape
   * `GeocodeStage.writeCoordinates` uses, and for the same reason: the per-row
   * version of this is what makes `GeocodeBatchListener` two round trips per
   * event.
   *
   * The `metadata` merge (`||`, never a replace) is the reversibility record AND
   * the ownership marker read back by {@link decideLocally}. It is one key in a
   * shared jsonb bag; nothing else in it is touched.
   *
   * The WHERE clause repeats the ownership rule rather than trusting the read:
   * `decideLocally` ran against a snapshot taken before
   * `findOrCreateForGeocode`'s round trips, so a concurrent writer could have
   * claimed the link in between. Re-asserting it here makes the guarantee
   * transactional instead of advisory — and a row that lost the race is left
   * exactly as the other writer set it, with this stage still recording `done`,
   * because the event IS linked to a place.
   */
  private async writeEventLinks(userId: string, links: Map<string, EventLink>): Promise<void> {
    const entries = [...links.entries()];

    await this.dataSource.query(
      `UPDATE ci.events e
          SET location_entity_id = u.place_entity_id,
              metadata           = COALESCE(e.metadata, '{}'::jsonb)
                                   || jsonb_build_object(
                                        '${PROMOTE_PROVENANCE_KEY}',
                                        jsonb_build_object(
                                          'stage',   $3::text,
                                          'version', $4::int,
                                          'at',      to_jsonb(now())
                                        )
                                      ),
              updated_at         = now()
         FROM unnest($1::uuid[], $2::uuid[]) AS u(event_id, place_entity_id)
        WHERE e.event_id = u.event_id
          AND e.user_id  = $5::uuid
          AND ( e.location_entity_id IS NULL
             OR e.location_entity_id = u.place_entity_id
             OR e.metadata->'${PROMOTE_PROVENANCE_KEY}'->>'stage' = $3::text )`,
      [
        entries.map(([eventId]) => eventId),
        entries.map(([, link]) => link.placeEntityId),
        PROMOTE_PLACE_STAGE_ID,
        this.version,
        userId,
      ],
    );
  }

  /**
   * Recompute the observed footprint of every place this slice touched, in ONE
   * statement.
   *
   * The polygon is DERIVED, not invented: the convex hull of every
   * `ci.events.location_coordinates` currently linked to the place, buffered by
   * the coarsest precision class that contributed to it and floored at
   * {@link PLACE_UNCERTAINTY_FLOOR_METRES}. A place with one observation gets a
   * circle of the floor radius — which is not a claim about the venue's size, it
   * is a statement that this system already treats every coordinate within that
   * distance as the same place.
   *
   * Recomputed from the current links rather than accumulated, so it is
   * idempotent and so that withdrawing a link shrinks the footprint instead of
   * leaving a permanent high-water mark.
   *
   * The hull is planar over lon/lat degrees before the cast to geography, which
   * is an approximation that grows with the extent of the hull. Over one place's
   * observations — metres to hundreds of metres — it is far below the buffer
   * radius; it would matter for a country-scale polygon, which is not what this
   * column holds.
   *
   * ── The read that protects a user ─────────────────────────────────────────
   *
   * The final predicate is why `location_boundary` is read and not just written:
   * a row that already has a boundary and carries no `promote` provenance was
   * drawn by a human or supplied by an importer, and no version bump of this
   * stage may replace it. Dropping that clause would make the first promoter to
   * run after a hand-corrected footprint destroy it silently.
   */
  private async writeFootprints(userId: string, radii: Map<string, number>): Promise<void> {
    if (radii.size === 0) {
      return;
    }

    const entries = [...radii.entries()];

    await this.dataSource.query(
      `WITH footprint AS (
         SELECT ev.location_entity_id AS entity_id,
                ST_ConvexHull(ST_Collect(ev.location_coordinates::geometry)) AS hull
           FROM ci.events ev
          WHERE ev.user_id = $4::uuid
            AND ev.location_entity_id = ANY($1::uuid[])
            AND ev.location_coordinates IS NOT NULL
          GROUP BY 1
       )
       UPDATE ci.entities e
          SET location_boundary = ST_Buffer(f.hull::geography, GREATEST(u.radius, $5::float8))::geography,
              properties        = COALESCE(e.properties, '{}'::jsonb)
                                  || jsonb_build_object(
                                       '${PROMOTE_PROVENANCE_KEY}',
                                       jsonb_build_object(
                                         'stage',           $2::text,
                                         'version',         $3::int,
                                         'boundary_metres', GREATEST(u.radius, $5::float8),
                                         'at',              to_jsonb(now())
                                       )
                                     ),
              updated_at        = now()
         FROM footprint f
         JOIN unnest($1::uuid[], $6::float8[]) AS u(entity_id, radius)
           ON u.entity_id = f.entity_id
        WHERE e.entity_id    = f.entity_id
          AND e.owner_user_id = $4::uuid
          AND e.entity_type   = 'Location'
          AND ( e.location_boundary IS NULL
             OR e.properties->'${PROMOTE_PROVENANCE_KEY}'->>'stage' = $2::text )`,
      [
        entries.map(([entityId]) => entityId),
        PROMOTE_PLACE_STAGE_ID,
        this.version,
        userId,
        PLACE_UNCERTAINTY_FLOOR_METRES,
        entries.map(([, radius]) => radius),
      ],
    );
  }
}

/**
 * The place two events will resolve to, decided locally.
 *
 * Mirrors `PlaceService.findOrCreateForGeocode`'s own identity: the trimmed,
 * lower-cased name and the coordinate rounded to 3 decimal places, which is the
 * grid `entities_location_snap_dedup_uniq` snaps to. Grouping on it is therefore
 * exact — two rows sharing a key are two rows the service would hand back the
 * same entity id for — rather than a heuristic that happens to save round trips.
 *
 * `toFixed(3)` and not `round(x * 1000)`, matching the service, so the two agree
 * on the boundary cases instead of disagreeing by one cell.
 */
export function placeGroupKey(name: string, lat: number, lng: number): string {
  return `${name.trim().toLowerCase()}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
}

/**
 * Positional uncertainty for a geocode precision class, in metres.
 *
 * An unknown or absent class contributes 0 — the floor in
 * {@link PlacePromoteStage.writeFootprints} then decides — rather than a
 * middle-of-the-road default. A default would be a number nobody measured
 * outranking the one thing here that IS measured: the observations themselves.
 */
export function radiusForLocationType(locationType: string | null): number {
  if (locationType == null) {
    return 0;
  }

  return LOCATION_TYPE_RADIUS_METRES[locationType.toUpperCase()] ?? 0;
}
