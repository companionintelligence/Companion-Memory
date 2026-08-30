import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
// The geocode domain's PUBLIC barrel — `no-cross-domain-internals` allows
// `index.ts` and `events.ts` and nothing else. Only the STATIC
// `hashReverseQuery` is used, so nothing is injected and no provider is ever
// called: see {@link PositionPlacePromoteStage.attachCachedResolutions} for why
// a promoter that bills is a bug.
import { GeocodeService } from '@ci/domains/geocode';
// Likewise the memory barrel. `PlaceService.findOrCreateForGeocode` +
// `ensureHierarchy` already own place identity (provider place_id first, then
// the 0.001-degree snap cell) and the city -> region -> country fold. This
// stage composes them exactly as `promote.place` does; it does not
// re-implement them, and it must not — two implementations of the admin-place
// dedupe would fork the hierarchy silently and permanently.
import { PlaceService } from '@ci/domains/memory';

import { PIPELINE_QUEUES } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, type StageVersion } from '../../versions';
// Intra-domain relative import, exactly as `PlacePromoteStage` imports
// `FORWARD_GEOCODE_PROVIDER_GENERATION`. The dependency is real and it is the
// whole reason this file exists: every input this stage reads — the name AND
// the address components behind the hierarchy — was written by
// `enrich.position_reverse`. See {@link PROMOTE_PLACE_POSITION_VERSION}.
import { POSITION_REVERSE_VERSION } from '../enrich/PositionReverseStage';

import { PLACE_PROMOTION_RULE_GENERATION, placeGroupKey } from './PlacePromoteStage';

/**
 * This stage's id.
 *
 * IDS ARE PERMANENT — the id is the third component of `ci.pipeline_state`'s
 * primary key, so renaming it abandons every ledger row written under the old
 * name and re-promotes the whole corpus under the new one.
 */
export const PROMOTE_PLACE_POSITION_STAGE_ID = 'promote.place_position';

/** The ledger `entity_type` this stage records under — the same one `enrich.position_reverse` uses. */
const ENTITY_TYPE = 'position';

// ---------------------------------------------------------------------------
// The version, DERIVED rather than chosen
// ---------------------------------------------------------------------------

/**
 * Generation of the POSITION-SPECIFIC half of the promotion rule: which fixes
 * are eligible ({@link PositionPlacePromoteStage.decideLocally}), and the
 * ownership rule the link write re-asserts.
 *
 * The clustering and hierarchy halves are NOT here — they are
 * {@link PLACE_PROMOTION_RULE_GENERATION}, shared with `promote.place` and
 * imported below, because the two stages must mint the same place for the same
 * (name, cell) or the map grows two nodes for one venue.
 */
export const POSITION_PLACE_LINK_RULE_GENERATION = 1;

/**
 * The stage version, derived so that improving ANY of its three inputs
 * re-promotes history.
 *
 * The three terms, and why each is not decoration:
 *
 *  - {@link POSITION_PLACE_LINK_RULE_GENERATION} — this stage's own rule.
 *  - {@link PLACE_PROMOTION_RULE_GENERATION} — the clustering key and the
 *    footprint radius table, both imported from `PlacePromoteStage` and both
 *    shared. A better dedupe rule there is a better dedupe rule here, and a
 *    version that did not track it would leave every position pointing at the
 *    place the OLD rule chose.
 *  - {@link POSITION_REVERSE_VERSION} — `enrich.position_reverse` writes BOTH
 *    inputs this stage reads: `ci.position.name` (which is what makes a fix a
 *    candidate at all) and, as a side effect, the `ci.geocode_cache` row whose
 *    address components become the place's hierarchy. A better reverse-geocode
 *    provider or a fixed component-to-column mapping therefore makes every
 *    promotion here provisional, exactly as a better FORWARD geocoder makes
 *    `promote.place`'s hierarchies provisional.
 *
 * The derivation is a SUM (offset by 2 so that all-at-1 gives 1, because
 * `versions.ts` refuses a version below 1). A sum is monotone in each term, so
 * the version can only ever go UP — the invariant `versions.ts` states.
 *
 * All three terms must stay integers >= 1.
 */
export const PROMOTE_PLACE_POSITION_VERSION =
  POSITION_PLACE_LINK_RULE_GENERATION + PLACE_PROMOTION_RULE_GENERATION + POSITION_REVERSE_VERSION - 2;

/**
 * The version this stage reports, cross-checked against `STAGE_VERSIONS`.
 *
 * `StageRegistry.assertConsistent` requires `stage.version` to equal
 * `STAGE_VERSIONS[id]`, because a hardcoded version would make bumping a
 * generation a silent no-op. A DERIVED version has the mirror-image failure:
 * bump a generation above, forget the one-line diff to `versions.ts`, and the
 * registry throws at the first sweep with a message about hardcoding that is
 * not what happened. So the derivation is the authority, the `STAGE_VERSIONS`
 * entry is its reviewable mirror, and a disagreement throws HERE.
 *
 * A missing entry is not an error — this file is imported by its own spec, and
 * a spec must not depend on the central wiring having landed first.
 */
export function promotePlacePositionStageVersion(
  versions: Record<string, StageVersion> = STAGE_VERSIONS,
): number {
  const declared = versions[PROMOTE_PLACE_POSITION_STAGE_ID];

  if (typeof declared === 'number' && declared !== PROMOTE_PLACE_POSITION_VERSION) {
    throw new Error(
      `STAGE_VERSIONS["${PROMOTE_PLACE_POSITION_STAGE_ID}"] declares ${declared} but the stage derives ` +
        `${PROMOTE_PLACE_POSITION_VERSION} from POSITION_PLACE_LINK_RULE_GENERATION ` +
        `(${POSITION_PLACE_LINK_RULE_GENERATION}) + PLACE_PROMOTION_RULE_GENERATION ` +
        `(${PLACE_PROMOTION_RULE_GENERATION}) + POSITION_REVERSE_VERSION (${POSITION_REVERSE_VERSION}) - 2. ` +
        `Bumping a generation is only half the change: update versions.ts in the same commit, or the two ` +
        `disagree about what has already been promoted.`,
    );
  }

  return PROMOTE_PLACE_POSITION_VERSION;
}

// Run at module load rather than at the first sweep — the earliest possible
// failure is the cheapest one, on the operator's terminal rather than inside a
// worker on whichever appliance reaches this stage first.
promotePlacePositionStageVersion();

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Where the sweep looks, and which rows this stage APPLIES to.
 *
 * ── READ THIS BEFORE ADDING `s.location_entity_id IS NULL` ─────────────────
 *
 * That is this stage's OUTPUT column, and a predicate over it is the ratchet
 * the whole ledger rebuild exists to delete: it conflates "never promoted",
 * "promoted and the resolution legitimately produced nothing", and "promoted
 * under a hierarchy rule or a reverse-geocode provider we now know was worse".
 * The third is the one that matters and it is the one a nullability predicate
 * can never reach — the row HAS a link, so it leaves the candidate set forever.
 * With the ledger, the repair is `POSITION_PLACE_LINK_RULE_GENERATION += 1`.
 *
 * What the predicate DOES say is what a row IS:
 *
 *  - `s.location IS NOT NULL` — the fix has absolute coordinates.
 *    `ci.position` also carries RELATIVE fixes (`reference_entity_id` +
 *    `relative_coordinates`, see the `valid_positioning` CHECK), which have no
 *    lat/lng to promote and are not this stage's to interpret.
 *  - `s.id IS NOT NULL` — `ci.position.id` is nullable (added by
 *    `20251205185102_add_id_to_position` and backfilled, never constrained),
 *    and `ci.pipeline_state.entity_id` is a typed uuid. A row with no id cannot
 *    be recorded in the ledger at all, so it is not a candidate — a fact about
 *    the row, not about the work. Same clause `enrich.position_reverse` uses.
 *  - `s.name IS NOT NULL AND btrim(s.name) <> ''` — a place needs a NAME to be
 *    a place. This is the same deliberate narrowing `promote.place` applies to
 *    `ci.events.location_name`, and on the legacy corpus it is the difference
 *    between 2,815 candidates and 65,115: the other 62,300 are raw GPS
 *    breadcrumbs with no venue, and minting a Location for each would bury the
 *    2,473 real venues in noise no later stage could tell them from. Those rows
 *    become candidates the moment `enrich.position_reverse` names one, with no
 *    change here.
 *
 * PERFORMANCE: this sweep is `WHERE user_id = $1 AND <predicate> AND id > $2
 * ORDER BY id`, and `ci.position` is a hypertable with ~95 chunks. Without an
 * index on `id` every hop full-scans all of them, which is why a capped sweep
 * never drains. Migration `..._add_position_id_index.sql` lands it.
 */
/**
 * The structural rejects, mirrored from `isNotAPlaceName`
 * (domains/import/push/inputs.ts) into SQL.
 *
 * A non-blank `ci.position.name` is NOT the same thing as a venue name. The
 * column's upstream is at least five-way — a real waypoint name, a
 * reverse-geocoded POI, a street address, a media filename, and a message/post
 * text snippet all reach it, because `titleFor` hands a geotagged capture.* its
 * own filename and a geotagged message its clipped body, and `toPositionInput`
 * writes whatever it got. Treating "non-blank" as "a place" would mint a
 * Location entity per camera-roll photo: 2,085 rows / 2,063 distinct filenames
 * on this corpus alone (measured on the branch of #2087), burying the real
 * venues in noise no later stage could tell them apart from.
 *
 * Kept as a predicate here rather than relying solely on the write-side guard
 * because this stage also runs over rows written BEFORE that guard existed —
 * exactly the population the paired backfill is repairing.
 *
 * The fifth upstream — the TITLE — was enumerated above long before it was
 * covered. It is the last three arms below, mirroring `isTitleText`: on the
 * corpus this stage had already turned 7 of those titles into Location entities
 * with names like "Uber ride from 520 4th St, San Francisco, CA 94107, US to 999
 * California St, San Francisco, CA 94108, US (request)".
 */
const NOT_A_PLACE_NAME_SQL = [
  // A media filename, and the bare-UUID stem an export leaves when it drops the
  // extension.
  String.raw`btrim(s.name) ~* '\.(jpe?g|png|heic|heif|gif|mov|mp4|m4v|avi|webp|dng|tiff?)$'`,
  String.raw`btrim(s.name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}([-_][0-9]+)?$'`,
  // A URI, bare or labelled.
  String.raw`btrim(s.name) ~* '^[a-z][a-z0-9+.-]*://\S+$'`,
  // A coordinate pair, bare or wearing a generic geolocation noun.
  String.raw`btrim(s.name) ~* '^(location|position|coordinates?|coords?|point|waypoint|fix|gps)?\s*[-:]?\s*[-+]?[0-9]{1,3}(\.[0-9]+)?\s*,\s*[-+]?[0-9]{1,3}(\.[0-9]+)?$'`,
  // A TITLE: prose, not a name. `clip`'s truncation mark (U+2026) means the
  // value is a PREFIX of a longer text; `!`/`?` mean it is a sentence; and more
  // than MAX_PLACE_NAME_WORDS words means it is longer than any place name on
  // this corpus. `.` and `@` are deliberately absent from the punctuation arm —
  // 'A.G. Bartlett Building' and 'On Jane Stanford Way @ Gilbert Biological
  // Sciences' are real, and each is a live ci.position.name.
  String.raw`btrim(s.name) ~ '…$'`,
  String.raw`btrim(s.name) ~ '[!?]'`,
  // `regexp_split_to_array` on btrim'd text cannot yield an empty array, so
  // array_length is never NULL here and the comparison is never three-valued.
  String.raw`array_length(regexp_split_to_array(btrim(s.name), '\s+'), 1) > 14`,
].join(' OR ');

export const PROMOTE_PLACE_POSITION_SOURCE: StageSource = {
  schema: 'ci',
  table: 'position',
  idColumn: 'id',
  userColumn: 'user_id',
  predicate:
    `s.location IS NOT NULL AND s.id IS NOT NULL AND s.name IS NOT NULL AND btrim(s.name) <> '' ` +
    `AND NOT (${NOT_A_PLACE_NAME_SQL})`,
};

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** A slice row: identity, the two inputs, and the existing link. */
interface CandidateRow {
  id: string;
  /**
   * Half of `ci.position`'s `(time, user_id)` primary key, and the only cheap
   * way to address the row for UPDATE — see {@link
   * PositionPlacePromoteStage.writePositionLinks}.
   */
  time: string | Date;
  name: string | null;
  /** NULL when the geography failed to project, or was cleared mid-flight. */
  lat: number | null;
  lng: number | null;
  location_entity_id: string | null;
}

/**
 * One `ci.geocode_cache` hit: the hierarchy inputs, for free.
 *
 * `location_type` is deliberately absent. `promote.place` reads it to size the
 * footprint polygon it owns; this stage writes no footprint (see the class
 * docblock), and selecting a column nothing reads would imply otherwise.
 */
interface CachedResolution {
  place_id: string | null;
  components: Record<string, unknown> | null;
}

/**
 * One distinct place within a slice. Many fixes at one venue resolve it once.
 *
 * The key is {@link placeGroupKey} — `PlacePromoteStage`'s, imported rather
 * than re-derived, so a position and an event at the same venue collapse onto
 * the same `PlaceService` identity instead of forking the graph.
 */
interface PlaceGroup {
  key: string;
  name: string;
  lat: number;
  lng: number;
  /** Every reverse-cache hash contributed by this group's fixes. */
  cacheHashes: Set<string>;
  positionIds: string[];
  cached: CachedResolution | null;
}

/**
 * Promotes reverse-geocoded GPS fixes into first-class places, and links the
 * fix to the place.
 *
 * ── The defect this closes ────────────────────────────────────────────────
 *
 * `enrich.position_reverse` writes seven address columns back onto
 * `ci.position` and stops there. `promote.place` reads `ci.events` and requires
 * a non-empty `events.location_name`; nothing reads `ci.position`. Grepping for
 * writers of `ci.position.location_entity_id` finds entity declarations, DTOs
 * and READ-side consumers (`EdgePromoteStage`'s position leg,
 * `deterministicEdgeMatrix`) — and no writer at all. So on the legacy corpus a
 * COMPLETED reverse-geocode sweep produced 5,005 cache rows, 2,815 named fixes,
 * and exactly 0 positions carrying a place: the map stays empty however long
 * enrichment runs. This stage is the writer that was missing.
 *
 * ── What it writes, and where each is read ────────────────────────────────
 *
 *  - `ci.entities` (Location) — `name`, `place_kind`, `parent_place_id`,
 *    `location_point`, via `PlaceService.findOrCreateForGeocode` /
 *    `ensureHierarchy`, shared with `promote.place`. READ by
 *    `PlaceService.findAll` / `findById` / `findByIds` / `placesNear` →
 *    `PlaceResolver` and `PlaceLoader`. Creation emits `PlaceCreatedEvent`,
 *    which is what puts the place in the search index.
 *  - `ci.position.location_entity_id` — READ by `promote.edge_position`
 *    (`PROMOTE_EDGE_POSITION_SOURCE`'s predicate is literally
 *    `s.location_entity_id IS NOT NULL`) and by the `position.visited` rule in
 *    `deterministicEdgeMatrix`, which projects owner Person −VISITED→ Place.
 *    Both have been correct and starved since the day they shipped.
 *
 * ── What it does NOT write, deliberately ──────────────────────────────────
 *
 * `ci.entities.location_boundary`. `promote.place` derives that polygon from
 * the convex hull of the `ci.events` currently linked to the place and refuses
 * to touch a boundary it does not own. A second writer deriving a hull from a
 * different table would fight it on every sweep — each recomputing "the"
 * footprint from half the observations. Footprints stay `promote.place`'s, and
 * widening the hull to cover linked positions belongs in THAT stage, behind a
 * `PLACE_PROMOTION_RULE_GENERATION` bump.
 *
 * ── What it costs ─────────────────────────────────────────────────────────
 *
 * Nothing metered. A SWEEP OF THIS STAGE IS NOT A BILL: the hierarchy inputs
 * come from `ci.geocode_cache` rows `enrich.position_reverse` already paid for,
 * read by primary key. If a future edit reaches for
 * `GeocodeService.reverseGeocode()` on a cache miss, every version bump becomes
 * an invoice — and the constructor arity is the guard, since this class takes
 * no geocode service at all.
 *
 * On a cold cache the consequence is stated plainly: the place is promoted
 * WITHOUT a hierarchy (`place_kind = 'address'`, `parent_place_id = NULL`).
 * That is a `done` at version N whose hierarchy arrives when the cache is warm
 * and a generation is bumped past N — not a failure, and not recorded as one.
 *
 * ── Reversibility, and its one honest limit ───────────────────────────────
 *
 * `ci.position` has NO jsonb bag. `promote.place` stamps
 * `{"promote": {"stage", "version", "at"}}` into `ci.events.metadata` and reads
 * it back to decide ownership; there is no such column here, and adding one to
 * a 95-chunk compressed hypertable is a schema change with a real cost that
 * belongs in its own review. So ownership is expressed the only way it can be
 * without one, and it is expressed CONSERVATIVELY:
 *
 *  - a fix with no link is promoted;
 *  - a fix already linked to the place this stage resolves is `done` (the write
 *    is a no-op, which is what makes the stage idempotent);
 *  - a fix linked to anything ELSE is `skipped: place_link_not_owned` and left
 *    exactly as its writer set it.
 *
 * The limit that buys: this stage cannot RE-POINT a link it wrote itself under
 * an older rule, because it cannot prove it wrote it. A generation bump
 * re-opens the ledger row, the stage re-resolves, and a fix whose place has
 * moved is recorded as `place_link_not_owned` rather than repaired — visible
 * and countable in `GET /api/pipeline/state`, never silent. Withdrawal is
 * `UPDATE ci.position SET location_entity_id = NULL WHERE ...`, which is why
 * the alternative — guessing that a non-NULL link is probably ours and
 * overwriting it — is the wrong trade: it would let this stage destroy an
 * importer's better-informed answer to save an operator one statement.
 */
@Injectable()
export class PositionPlacePromoteStage implements Stage {
  readonly id = PROMOTE_PLACE_POSITION_STAGE_ID;

  /**
   * The DERIVED version — see {@link promotePlacePositionStageVersion}.
   * Resolved ONCE at construction, never as a getter: ids claimed at version 1
   * and completed at version 2 would never be re-processed by the improvement
   * that bump was for.
   */
  readonly version = promotePlacePositionStageVersion();

  /**
   * `pipeline-index`: Postgres-bound. No external call, no object storage, no
   * model — the same resource class `promote.place` runs in, and deliberately
   * NOT `pipeline-enrich`, which is reserved for the latency-bound metered
   * provider work `enrich.position_reverse` does over this same table.
   */
  readonly queue = PIPELINE_QUEUES.INDEX;

  readonly entityTypes = [ENTITY_TYPE] as const;

  readonly source = PROMOTE_PLACE_POSITION_SOURCE;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly placeService: PlaceService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PositionPlacePromoteStage.name);
  }

  /**
   * Promote one slice of fixes.
   *
   * Idempotent, as the contract requires: `findOrCreateForGeocode` resolves the
   * same (name, cell) to the same entity id however many times it is called,
   * and the link write is a guarded assignment. Two dispatchers racing the same
   * id cost one redundant UPDATE.
   *
   * Four phases: load and decide locally, resolve each DISTINCT place once,
   * link every fix in one statement, answer for every id.
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
    // `PipelineSliceListener` records anything missing as
    // `failed: stage_returned_no_result`, which is correct but uninformative.
    for (const id of ids) {
      if (!byId.has(id)) {
        // Deleted, re-owned, or (for `ci.position` specifically) rewritten by a
        // re-import between the sweep and the slice. A skip: nothing to retry.
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    // Group by the place a row will resolve to BEFORE touching the database:
    // 200 fixes at five venues are five resolutions, not two hundred.
    const groups = new Map<string, PlaceGroup>();

    for (const row of rows) {
      const local = this.decideLocally(row);

      if (local != null) {
        results.set(row.id, local);

        continue;
      }

      // Non-null and finite by construction: `decideLocally` returned null,
      // which it only does for a row carrying a name and both coordinates.
      const name = (row.name as string).trim();
      const lat = Number(row.lat);
      const lng = Number(row.lng);
      const key = placeGroupKey(name, lat, lng);
      const group = groups.get(key);

      if (group == null) {
        groups.set(key, {
          key,
          name,
          lat,
          lng,
          cacheHashes: new Set([GeocodeService.hashReverseQuery(lat, lng)]),
          positionIds: [row.id],
          cached: null,
        });
      } else {
        group.positionIds.push(row.id);
        // A group is a 0.001-degree cell (~111 m) and the reverse cache is
        // keyed at 4 decimals (~11 m), so ONE group spans up to a hundred cache
        // rows. Collect every member's key rather than trusting the first
        // fix's: they all describe the same venue, and any one of them carries
        // the address components.
        group.cacheHashes.add(GeocodeService.hashReverseQuery(lat, lng));
      }
    }

    if (groups.size === 0) {
      return results;
    }

    await this.attachCachedResolutions([...groups.values()]);

    /** Resolved links, keyed by position id, awaiting the one bulk UPDATE. */
    const links = new Map<string, string>();
    /** Fixes already pointing at the place we resolved: `done`, nothing to write. */
    const alreadyLinked = new Map<string, string>();

    // Sequential, not `Promise.all`. `findOrCreateForGeocode` is
    // INSERT ... ON CONFLICT DO NOTHING followed by SELECT, which is safe under
    // concurrency but resolves a race by doing the work twice; the grouping
    // above has already removed the only contention this slice can create with
    // itself.
    for (const group of groups.values()) {
      let placeEntityId: string;

      try {
        ({ id: placeEntityId } = await this.placeService.findOrCreateForGeocode(ctx, {
          name: group.name,
          lat: group.lat,
          lng: group.lng,
          placeId: group.cached?.place_id ?? null,
          components: group.cached?.components ?? null,
        }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        // FAILED, not skipped: `findOrCreateForGeocode` throws on a unique-index
        // race it could not resolve and on a transport failure, and both are
        // worth retrying on the ledger's own schedule. Scoped to this group's
        // ids — one unresolvable venue must not charge the other 199 fixes an
        // attempt.
        for (const positionId of group.positionIds) {
          results.set(positionId, {
            outcome: 'failed',
            reason: 'place_resolve_failed',
            detail: { message, place: group.name },
          });
        }

        this.logger.warn('Place resolution failed', { place: group.name, message });

        continue;
      }

      for (const positionId of group.positionIds) {
        const existing = byId.get(positionId)?.location_entity_id ?? null;

        if (existing === placeEntityId) {
          // Already ours-or-equivalent. Recorded `done` without a write: the
          // link is the promotion, and re-issuing an UPDATE that changes
          // nothing would decompress a TimescaleDB chunk for no reason.
          alreadyLinked.set(positionId, placeEntityId);

          continue;
        }

        if (existing != null) {
          // A link pointing somewhere ELSE: an importer's, or one this stage
          // wrote under a rule it can no longer prove it wrote (class
          // docblock). Left exactly as its writer set it, and COUNTED — this is
          // the number that tells an operator a generation bump needs a manual
          // withdrawal to take effect.
          results.set(positionId, {
            outcome: 'skipped',
            reason: 'place_link_not_owned',
            detail: { locationEntityId: existing },
          });

          continue;
        }

        links.set(positionId, placeEntityId);
      }
    }

    for (const [positionId, placeEntityId] of alreadyLinked) {
      results.set(positionId, { outcome: 'done', detail: { placeEntityId, unchanged: true } });
    }

    if (links.size === 0) {
      return results;
    }

    try {
      await this.writePositionLinks(ctx.userId, links, byId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // One statement means one outcome: it committed or it did not, so every
      // row in it shares the verdict. Attributing it to one id would be a guess.
      for (const positionId of links.keys()) {
        results.set(positionId, {
          outcome: 'failed',
          reason: 'place_link_write_failed',
          detail: { message },
        });
      }

      this.logger.error(
        `Position place link write failed for ${links.size} fixes`,
        err instanceof Error ? err : new Error(message),
      );

      return results;
    }

    for (const [positionId, placeEntityId] of links) {
      results.set(positionId, { outcome: 'done', detail: { placeEntityId } });
    }

    return results;
  }

  /**
   * Everything decidable without touching another table.
   *
   * Returns a terminal result, or `null` when the row should be promoted.
   */
  private decideLocally(row: CandidateRow): StageResult | null {
    const lat = Number(row.lat);
    const lng = Number(row.lng);

    if (row.lat == null || row.lng == null) {
      // The applicability predicate requires a non-NULL `location`, so this is
      // one cleared mid-flight, or a dead letter replayed weeks later carrying
      // stale ids.
      return { outcome: 'skipped', reason: 'no_coordinates' };
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      // A geography that failed to project — corrupt, or NULL arriving as NaN
      // through the driver. Re-reading the same bytes cannot help.
      return { outcome: 'skipped', reason: 'invalid_coordinates' };
    }

    if (row.name == null || row.name.trim().length === 0) {
      // Named between the sweep and the slice, then cleared — or a re-import
      // rewrote the fix. A place needs a name.
      return { outcome: 'skipped', reason: 'no_location_name' };
    }

    // An EXISTING `location_entity_id` is deliberately NOT decided here.
    // `promote.place` can refuse a foreign link before doing any work because
    // `ci.events.metadata` tells it who wrote one; `ci.position` has no such
    // bag (class docblock), so the only way to tell "already promoted to the
    // place we would choose" from "another writer's answer" is to resolve the
    // place and compare. Deciding it up front would make every version bump
    // report `place_link_not_owned` for the whole corpus — including the rows
    // that are already exactly right. Resolution is one round trip per DISTINCT
    // venue per slice, which is what buys the difference.
    return null;
  }

  /**
   * The slice's fixes, in one statement.
   *
   * Raw SQL rather than `PositionService`, for the reason `PlacePromoteStage`
   * gives about `CalendarEventService`: the columns wanted are a strict subset of a
   * ~30-column row, at 200 rows a slice.
   *
   * `time` comes back because it is half of `ci.position`'s `(time, user_id)`
   * primary key and the only cheap way to address a row for UPDATE — see
   * {@link writePositionLinks}. lat/lng are projected out of the geography
   * Point with ST_Y/ST_X, exactly as `PositionReverseStage.loadRows` does
   * (PostGIS orders coordinates X, Y — so `ST_Y` is the LATITUDE, and it is
   * spelled that way everywhere in this subsystem precisely because the
   * transposition is the classic bug in this neighbourhood).
   *
   * User-scoped even though the sweep already was: a slice can arrive from a
   * dead letter replayed weeks later, and re-scoping is the difference between
   * "this id is not yours" and writing a place link onto someone else's
   * movements.
   */
  private loadRows(userId: string, ids: string[]): Promise<CandidateRow[]> {
    return this.dataSource.query<CandidateRow[]>(
      `SELECT p.id,
              p.time,
              p.name,
              ST_Y(p.location::geometry) AS lat,
              ST_X(p.location::geometry) AS lng,
              p.location_entity_id
         FROM ci.position p
        WHERE p.id = ANY($1::uuid[])
          AND p.user_id = $2::uuid`,
      [ids, userId],
    );
  }

  /**
   * Attach each group's `ci.geocode_cache` row, if `enrich.position_reverse`
   * already paid for one.
   *
   * READ-ONLY, BY PRIMARY KEY, AND NEVER A PROVIDER CALL.
   * `GeocodeService.hashReverseQuery` is the public static that computes the
   * reverse cache key — called here rather than re-implemented, so a hit is
   * guaranteed to be the same row `GeocodeService.reverseGeocode` wrote. (The
   * forward `hashQuery` would be WRONG here: its `canonicalize()` strips '-',
   * '.' and ',', which collapses all four coordinate quadrants onto one row.)
   *
   * A miss yields no hierarchy and no precision class, which is a legitimate
   * outcome and not an error; see the class docblock.
   *
   * A failure is swallowed to a warning: the cache is an ENRICHMENT input, and
   * a place with no hierarchy is strictly better than no place at all. Failing
   * the slice over it would make an unavailable cache table look like an
   * unpromotable corpus.
   */
  private async attachCachedResolutions(groups: PlaceGroup[]): Promise<void> {
    const byHash = new Map<string, PlaceGroup[]>();

    for (const group of groups) {
      for (const hash of group.cacheHashes) {
        const bucket = byHash.get(hash);

        if (bucket == null) {
          byHash.set(hash, [group]);
        } else {
          bucket.push(group);
        }
      }
    }

    try {
      const rows = await this.dataSource.query<Array<CachedResolution & { query_hash: string }>>(
        `SELECT c.query_hash, c.place_id, c.components
           FROM ci.geocode_cache c
          WHERE c.query_hash = ANY($1::text[])
            AND c.status = 'OK'`,
        [[...byHash.keys()]],
      );

      for (const row of rows) {
        for (const group of byHash.get(row.query_hash) ?? []) {
          // FIRST hit wins. Every cache row a group collected describes a point
          // inside the same 0.001-degree cell, so they agree about the city,
          // region and country this stage actually reads; taking the first is
          // stable and saves a comparison nobody could adjudicate.
          if (group.cached != null) {
            continue;
          }

          group.cached = { place_id: row.place_id, components: row.components };
        }
      }
    } catch (err: unknown) {
      this.logger.warn('Geocode cache lookup failed; promoting without hierarchy', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Link every promoted fix in ONE statement.
   *
   * `unnest()` over parallel arrays, one round trip per slice — the same shape
   * `PositionReverseStage.writeAddresses` uses, and for the same reason: the
   * per-row version of this is what made the old participant backfill never
   * finish over a 22-year history, and `ci.position` is the largest table on
   * the appliance.
   *
   * The row is addressed by its PRIMARY KEY (`time`, `user_id`) rather than by
   * `id`, plus `id` as a correctness check, and bounded by the slice's own time
   * range. That is not a micro-optimisation: `ci.position` is a hypertable with
   * ~95 monthly chunks, so the `time BETWEEN` bound is what lets TimescaleDB
   * exclude every chunk the slice does not touch. Ids are uuid v7, so a keyset
   * sweep in id order hands out roughly insertion-ordered slices and the bound
   * is usually tight; when it is not, it is merely wider, never wrong.
   *
   * Fixes older than the compression policy's 7 days live in compressed chunks.
   * TimescaleDB 2 handles DML against them by decompressing the affected
   * segments, which is correct but not free — another reason the write is
   * batched, time-bounded, and skipped entirely for a fix already pointing at
   * the right place.
   *
   * The final predicate re-asserts the ownership rule rather than trusting the
   * read: `decideLocally` ran against a snapshot taken before
   * `findOrCreateForGeocode`'s round trips, so a concurrent writer could have
   * claimed the link in between. Re-asserting it here makes the guarantee
   * transactional instead of advisory — and a row that lost the race is left
   * exactly as the other writer set it.
   */
  private async writePositionLinks(
    userId: string,
    links: Map<string, string>,
    byId: Map<string, CandidateRow>,
  ): Promise<void> {
    const entries = [...links.entries()];

    // Defensive: `new Date(value)` clones a Date and parses the ISO string the
    // driver hands back if `timestamptz` ever arrives unparsed.
    const times = entries.map(([id]) => new Date(byId.get(id)!.time));
    const epochs = times.map((time) => time.getTime());

    await this.dataSource.query(
      `UPDATE ci.position p
          SET location_entity_id = u.place_entity_id
         FROM unnest($1::uuid[], $2::timestamptz[], $3::uuid[])
              AS u(position_id, fix_time, place_entity_id)
        WHERE p.id = u.position_id
          AND p.time = u.fix_time
          AND p.user_id = $4::uuid
          AND p.time >= $5::timestamptz
          AND p.time <= $6::timestamptz
          AND ( p.location_entity_id IS NULL
             OR p.location_entity_id = u.place_entity_id )`,
      [
        entries.map(([positionId]) => positionId),
        times,
        entries.map(([, placeEntityId]) => placeEntityId),
        userId,
        new Date(Math.min(...epochs)),
        new Date(Math.max(...epochs)),
      ],
    );
  }
}
