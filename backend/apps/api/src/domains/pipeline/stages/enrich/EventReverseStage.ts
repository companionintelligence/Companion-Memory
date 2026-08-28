import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import plimit, { type LimitFunction } from 'p-limit';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { EventService } from '@ci/domains/events';
// The geocode domain's PUBLIC barrel, not its internals: `no-cross-domain-internals`
// in `.dependency-cruiser.mjs` allows exactly `index.ts` and `events.ts` across a
// domain boundary. `GeocodeService` is the cache-aware orchestration — canonicalize,
// read `ci.geocode_cache`, call the provider only on a miss, branch on the provider
// STATUS (never an HTTP code), write the possibly-negative cache row. This stage
// adds none of that and must never re-implement any of it.
import { GeocodeService } from '@ci/domains/geocode';
import { EventUpdatedEvent } from '@ci/domains/memory/events';

import { PIPELINE_QUEUES, STAGE_IDS } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, stageVersion, type StageVersion } from '../../versions';

// Intra-domain relative import, exactly as `PlacePromoteStage` imports
// `FORWARD_GEOCODE_PROVIDER_GENERATION` from `GeocodeStage`. The dependency is
// real in both directions: this stage asks a coordinate what it is called, which
// is the same question `enrich.position_reverse` asks one table over, of the
// same provider (hence the shared generation — see {@link EVENT_REVERSE_VERSION})
// and through the same cache cells (hence the shared {@link cellKey}).
import { cellKey, REVERSE_GEOCODE_PROVIDER_GENERATION } from './PositionReverseStage';

/** The ledger `entity_type` this stage records under. */
const ENTITY_TYPE = 'event';

// ---------------------------------------------------------------------------
// The version, DERIVED rather than chosen
// ---------------------------------------------------------------------------

/**
 * Generation of THIS stage's interpretation rule — which provider outcome
 * becomes which write.
 *
 * Covers {@link NAME_OWNERSHIP_SOURCES} (whose `location_name` this stage may
 * replace), the refusal to name an ESTIMATED coordinate (see
 * {@link decideLocally}), and the `location_source` provenance token it stamps.
 * Bump it in the same commit that edits any of them.
 *
 * The PROVIDER half of the derivation is not declared here: it is
 * {@link REVERSE_GEOCODE_PROVIDER_GENERATION}, imported from
 * `PositionReverseStage`, because "what does this coordinate resolve to?" is one
 * question with one answer and two callers. Declaring a second copy here would
 * let a provider swap re-open `ci.position`'s history and silently not
 * `ci.events`'.
 */
export const EVENT_REVERSE_RULE_GENERATION = 1;

/**
 * The stage version, derived from the two generations so that improving EITHER
 * re-runs history.
 *
 * That is the whole reason this stage does not carry a hand-chosen integer, and
 * it is the defect `GeocodeBatchListener.selectReverseCandidates` still has:
 * it selects on `location_name IS NULL` and states the consequence in its own
 * comment — *"a resolved row now HAS a name and drops out of the candidate
 * set"* — so the first label any provider ever produced for a coordinate is
 * frozen for the life of the appliance.
 *
 * The derivation is a SUM (offset so that both-at-1 gives 1, because
 * `versions.ts` refuses a version below 1). A sum is monotone in each term, so
 * the version can only ever go UP — the invariant `versions.ts` states, and the
 * reason `EmbedStage` argues at length against `version = hash(...)`: a hash is
 * uniformly distributed, so half of all changes move the version DOWN, and a
 * version that goes down leaves every processed row looking stale-forward and
 * permanently invisible to the sweep.
 *
 * Both terms must stay integers >= 1.
 */
export const EVENT_REVERSE_VERSION = REVERSE_GEOCODE_PROVIDER_GENERATION + EVENT_REVERSE_RULE_GENERATION - 1;

/**
 * The version this stage reports, cross-checked against `STAGE_VERSIONS`.
 *
 * `StageRegistry.assertConsistent` requires `stage.version` to equal
 * `STAGE_VERSIONS[id]`, because a hardcoded version would make bumping the
 * constant — the one re-processing lever this subsystem provides — a silent
 * no-op. A DERIVED version has the mirror-image failure: bump a generation
 * above, forget the one-line diff to `versions.ts`, and the registry throws at
 * the first sweep with a message about hardcoding that is not what happened.
 *
 * So: the derivation is the authority, the `STAGE_VERSIONS` entry is its
 * reviewable mirror, and a disagreement throws HERE, where the fix is obvious.
 *
 * `versions` is a parameter only so a test can prove the cross-check without
 * mutating the production declaration. A `STAGE_VERSIONS` entry may also be a
 * THUNK (see `versions.ts`) and this checks only the literal form, deliberately,
 * for the reason `PositionReverseStage` gives: the thunk for this stage could
 * only be this very function, so invoking one here would recurse forever, and a
 * derivation that IS the declaration cannot disagree with itself.
 */
export function eventReverseStageVersion(versions: Record<string, StageVersion> = STAGE_VERSIONS): number {
  const declared = versions[STAGE_IDS.ENRICH_EVENT_REVERSE];

  if (typeof declared === 'number' && declared !== EVENT_REVERSE_VERSION) {
    throw new Error(
      `STAGE_VERSIONS["${STAGE_IDS.ENRICH_EVENT_REVERSE}"] declares ${declared} but the stage derives ` +
        `${EVENT_REVERSE_VERSION} from REVERSE_GEOCODE_PROVIDER_GENERATION ` +
        `(${REVERSE_GEOCODE_PROVIDER_GENERATION}) + EVENT_REVERSE_RULE_GENERATION ` +
        `(${EVENT_REVERSE_RULE_GENERATION}) - 1. Bumping a generation is only half the change: update ` +
        `versions.ts in the same commit, or the two disagree about what has already been written.`,
    );
  }

  return EVENT_REVERSE_VERSION;
}

// Run at module load, not at first sweep — the same argument `StageRegistry`'s
// completeness guard makes, and the same shape as `positionReverseStageVersion()`
// and `geocodeStageVersion()`. A generation bumped without the matching one-line
// diff to `versions.ts` is a programming error, and the earliest possible failure
// is the cheapest one: at boot, on the operator's terminal, rather than inside a
// worker on whichever appliance reaches this stage first.
eventReverseStageVersion();

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Where the sweep looks for candidates, and which of those rows this stage
 * APPLIES to.
 *
 * ── READ THIS BEFORE ADDING `s.location_name IS NULL` ──────────────────────
 *
 * It is what `GeocodeBatchListener.selectReverseCandidates` does today, it is
 * the obvious thing to write, and it is exactly the ratchet this rebuild exists
 * to delete. `location_name` is this stage's OUTPUT. A predicate over it
 * conflates three different facts into one `NULL`:
 *
 *  - never reverse-geocoded;
 *  - reverse-geocoded and the provider legitimately returned nothing (a photo
 *    taken mid-ocean, a fix in an unmapped desert);
 *  - reverse-geocoded successfully, by a provider we now know was worse.
 *
 * The first two are indistinguishable, so an unnameable coordinate would be
 * re-sent to a BILLED provider on every run for as long as the appliance exists.
 * The third is unreachable: the moment a row gets a name it leaves the candidate
 * set permanently, so a better provider could only ever apply to events imported
 * afterwards — never to the history already here.
 *
 * Whether this stage has run lives in `ci.pipeline_state`, and nowhere else.
 * `StageRegistry.assertApplicabilityPredicate` enforces the mirror-image rule
 * (no reaching into the ledger from here); nothing can enforce the rule above,
 * which is why it is written out at this length.
 *
 * What the predicate DOES say is what a row IS: a live event that carries a
 * coordinate worth asking a geocoder to name. `is_deleted` is applicability, not
 * completion — `ci.events` is soft-deleted, and spending a metered provider call
 * on a tombstone is pure cost.
 *
 * Note what is NOT filtered here and is decided in {@link decideLocally}
 * instead: an event whose name this stage does not own, and an event whose
 * coordinate is an ESTIMATE rather than a measurement. Both are properties this
 * stage's RULE reads (they live in the `metadata` jsonb bag alongside the
 * ownership marker it writes), so both are re-openable by a generation bump —
 * and both are decided before any provider call, so neither is ever billed.
 */
export const EVENT_REVERSE_SOURCE: StageSource = {
  schema: 'ci',
  table: 'events',
  idColumn: 'event_id',
  userColumn: 'user_id',
  predicate: `s.location_coordinates IS NOT NULL AND COALESCE(s.is_deleted, false) = false`,
};

// ---------------------------------------------------------------------------
// The interpretation rule
// ---------------------------------------------------------------------------

/**
 * Provenance written onto a row this stage names.
 *
 * NOT a new token. `GeocodeBatchListener.handleReverseBatch` already tags every
 * event it reverse-names `reverse_geocoded`, and `GeocodeStage` already names
 * that token as the one deliberately ABSENT from
 * `OVERWRITABLE_LOCATION_SOURCES`: a row so tagged has MEASURED coordinates and
 * a name DERIVED from them, and forward-geocoding that derived name back into
 * the coordinate column would replace a measured fix with the provider's
 * centroid of the provider's own label — a round trip that loses precision every
 * time it runs.
 *
 * So stamping it is load-bearing in two directions at once. It is this stage's
 * ownership marker (see {@link NAME_OWNERSHIP_SOURCES}), and it is what stops
 * `enrich.geocode` — whose applicability predicate is satisfied the instant this
 * stage writes a name — from undoing the measurement that produced it.
 */
const LOCATION_SOURCE_REVERSE = 'reverse_geocoded';

/**
 * `metadata.location_source` values whose `location_name` this stage MAY
 * replace.
 *
 * ── Why a stage that overwrites needs this at all ──────────────────────────
 *
 * `PositionReverseStage` writes its seven address columns unconditionally and
 * argues (correctly) that filling only NULLs would move the ratchet out of
 * candidate selection and into the UPDATE. The same argument applies here — with
 * the difference that changes the answer, and it is the same difference
 * `GeocodeStage` found: `ci.position.address` has exactly one writer, and
 * `ci.events.location_name` has many. Calendar invites arrive with a room name,
 * Takeout "Maps places" rows with a venue, a user types "Mum's". Every one of
 * those is a BETTER name than a provider's formatted address, and overwriting
 * unconditionally would silently destroy all of them the first night this stage
 * ran — the failure `types.ts` warns about in `StageResult.confidence`.
 *
 * So the rule is ownership, not nullability: this stage replaces names it (or
 * its pre-ledger predecessor, `GeocodeBatchListener`'s reverse leg, which stamps
 * the identical token) wrote, and refuses everything else with
 * `skipped: name_not_owned` — decided BEFORE the provider call, so a row it may
 * not write is never billed for either.
 *
 * The set has exactly one member and that is not an oversight. The other
 * `location_source` tokens — `geocoded`, `approximate`, `estimated`, `virtual` —
 * are all claims about the COORDINATE column, written by stages that read the
 * name rather than producing it. A row carrying one of them either has a name
 * this stage did not write, or has no name at all and is caught by the blank
 * check instead.
 *
 * ── The honest gap ────────────────────────────────────────────────────────
 *
 * An event whose name arrived from an importer is indistinguishable, in this
 * column, from one an unknown writer set — both read as "not mine", and both are
 * correctly refused. But a row this stage COULD safely improve (a provider's
 * older, coarser formatted address written before `GeocodeBatchListener` began
 * tagging) is refused too, so a bump cannot repair it. The real answer is
 * `ci.derived_facts`, where two writers' assertions coexist and are ranked
 * instead of one silently clobbering the other — see the pipeline README, "What
 * is NOT built yet".
 */
export const NAME_OWNERSHIP_SOURCES: ReadonlySet<string> = new Set([LOCATION_SOURCE_REVERSE]);

/**
 * The `metadata.location_source` marking a coordinate that was INFERRED from a
 * neighbouring event rather than measured.
 *
 * Duplicated, in effect, from `EstimateLocationStage`'s own
 * `LOCATION_SOURCE_ESTIMATED`; it is a private const there and this file must
 * not reach into another stage for a string. The two MUST stay identical: a
 * drift means estimated coordinates start being named, which is the failure
 * {@link decideLocally} exists to prevent.
 */
const LOCATION_SOURCE_ESTIMATED = 'estimated';

/**
 * Provider statuses that are PERMANENT for a given coordinate, and the ledger
 * reason each becomes. All are `skipped`, never `failed`, because a retry cannot
 * produce a different answer — `GeocodeService` negative-caches every one of
 * them in `ci.geocode_cache`, so a retry would not even reach the provider.
 *
 * `REQUEST_DENIED` deserves its own note, because "the API key is missing" feels
 * transient. It is not, from this stage's point of view: the negative cache row
 * is already written, so every retry re-reads the same denial. Fixing the key
 * (or the Portal credential) is an operator action, and re-opening the corpus
 * afterwards is a version bump — far better than every geotagged event quietly
 * burning its five attempts into quarantine. The failure is also legible at a
 * glance: `79 skipped: provider_denied`.
 *
 * DUPLICATED from `GeocodeService`'s `NON_RETRYABLE_STATUSES`, which the geocode
 * barrel does not export — reaching past a domain's `index.ts` is a
 * `no-cross-domain-internals` error. Both sibling stages carry the same copy and
 * the same note; exporting it is the correct fix and belongs with the change
 * that owns that file.
 */
const PERMANENT_STATUS_REASONS: Readonly<Record<string, string>> = {
  ZERO_RESULTS: 'zero_results',
  REQUEST_DENIED: 'provider_denied',
  INVALID_REQUEST: 'invalid_request',
};

/**
 * Provider calls in flight per slice.
 *
 * Bounded by the same two numbers `GeocodeBatchListener` respects — a hard
 * ceiling and the configured QPS — so a slice of cache misses cannot burst past
 * the provider's rate limit and turn into `OVER_QUERY_LIMIT` for everything else
 * on the appliance.
 *
 * NOTE: this is a per-slice bound, and `pipeline-enrich` can work several slices
 * at once, so the appliance-wide rate is not enforced here. It cannot be: the
 * QPS throttle lives in `GeocodeBatchListener` (a private `RateLimiter` in
 * another domain's listener), where no second caller can share it. Moving that
 * throttle into `GeocodeService`, next to the cache it already shares, is the
 * correct fix and belongs with the change that owns that file.
 */
const MAX_PROVIDER_CONCURRENCY = 4;

/** A slice row: the identity, the point to name, and what is already there. */
interface CandidateRow {
  id: string;
  /** NULL when the geography failed to project, or was cleared mid-flight. */
  lat: number | string | null;
  lng: number | string | null;
  /** The stage's OUTPUT column, read only by {@link decideLocally}. */
  location_name: string | null;
  /** `metadata->>'location_source'`, i.e. which writer claims the row. */
  location_source: string | null;
  is_deleted: boolean | null;
}

/** What one resolved event writes back. */
interface NamePatch {
  /** The provider's formatted address for the coordinate. */
  locationName: string;
}

/**
 * Resolves `ci.events.location_coordinates` into `location_name`.
 *
 * ── The hole this fills ────────────────────────────────────────────────────
 *
 * `enrich.geocode` runs one direction only — name to coordinates — so an event
 * that arrived with a MEASUREMENT and no label (photo EXIF GPS, a GPX-derived
 * check-in, a geotagged post) had no scheduled path to a name at all. The only
 * coords-to-name path over `ci.events` was operator-triggered:
 * `MaintenanceOrchestratorService.runGeocodeLeg` with `direction: 'reverse'`,
 * and the `reverse_geocode` CLI backfill leg. Neither is on a cron and neither
 * is chained from an import, so on an appliance nobody drove by hand those rows
 * were stranded permanently.
 *
 * Stranded is the operative word, because the consequence is not merely a
 * missing label. `promote.place` requires BOTH a coordinate and a non-blank name
 * (a place needs a name to be a place — see `PROMOTE_PLACE_SOURCE`), so an
 * unnamed geotagged event never enters its candidate set, never gets a
 * `location_entity_id`, and never reaches the map. `PlacePromoteStage`'s own
 * comment says those rows *"become candidates the moment `enrich.position_reverse`
 * gives them a name"* — but that stage is sourced from `ci.position`, and it can
 * never name anything in `ci.events`. THIS is the stage that comment describes.
 *
 * ── The cost, stated up front ──────────────────────────────────────────────
 *
 * Like both of its siblings, A SWEEP OF THIS STAGE IS A BILL. Three things hold
 * it down, and only the first two are automatic:
 *
 *  1. `GeocodeService`'s cache keys reverse lookups on the coordinate rounded to
 *     4 decimals (~11 m), so every event at a place already resolved is free. A
 *     personal corpus repeats home / office / a handful of venues, and a burst
 *     of photos from one afternoon collapses onto a handful of cells.
 *  2. This stage resolves ONE call per distinct cell per slice (see
 *     {@link cellKey}, imported from `PositionReverseStage` rather than
 *     re-derived). Without it, 200 photos taken in one room would all miss the
 *     cache in the same instant and fire 200 identical billed calls, because the
 *     cache row is only written after the first one returns.
 *  3. Nothing here bounds a full-corpus sweep; `STAGE_SCHEDULES`' `perRunCap`
 *     does. Get the candidate count before you get the bill — the query is in
 *     the pipeline README under "Blast radius".
 *
 * ── Outcomes ───────────────────────────────────────────────────────────────
 *
 * Every id gets exactly one answer, and every non-`done` answer carries a stable
 * greppable reason. The transient/permanent split is the one that matters —
 * getting it backwards costs money in one direction and coverage in the other:
 *
 *  - `zero_results` — the provider knows this coordinate and has nothing there.
 *    SKIPPED, so it is never re-billed, and countable. A version bump re-opens
 *    it, which is the point: a provider with better rural coverage should get to
 *    answer again.
 *  - `provider_denied` / `invalid_request` — permanent for this coordinate; see
 *    {@link PERMANENT_STATUS_REASONS}.
 *  - `provider_unavailable` — `OVER_QUERY_LIMIT` or a transport failure. FAILED,
 *    so a rate-limited or unreachable provider reads as a failure count going UP
 *    rather than a coverage number that quietly stops climbing — and declared
 *    TRANSIENT (`TRANSIENT_FAILURE_REASONS`), so it backs off on the long
 *    schedule and never spends the quarantine budget. That declaration is not
 *    decoration: before it existed on the sibling stage, a brief provider outage
 *    left 12,237 position fixes — 19 % of that corpus — permanently quarantined.
 *  - `name_write_failed` — the answer arrived, the UPDATE did not. Failed, and
 *    recorded apart from a provider failure because the two have nothing in
 *    common but their timing.
 *  - `source_row_missing` / `event_deleted` / `no_coordinates` /
 *    `invalid_coordinates` / `coordinates_estimated` / `name_not_owned` /
 *    `no_name_resolved` — skips: nothing to retry, and each says which.
 *
 * ── What this stage deliberately does NOT do ───────────────────────────────
 *
 * `GeocodeBatchListener`'s reverse leg also calls
 * `PlaceService.findOrCreateForGeocode` and writes `location_entity_id`. That is
 * a SEPARATE decision at a separate version — a better place-dedupe rule should
 * be re-runnable without re-billing the geocoder — and it already has a stage:
 * `promote.place`, which this stage feeds. `GeocodeStage` makes the identical
 * argument about the link it does not write, and `EmbedStage` about the tsvector
 * it does not write.
 *
 * The honest consequence, and it is worth stating because it is invisible
 * otherwise: `promote.place` looks its hierarchy up in `ci.geocode_cache` under
 * the FORWARD key, `hashQuery(name)`, and a name this stage derived was cached
 * under the REVERSE key, `hashReverseQuery(lat, lng)`. So a reverse-named event
 * promotes to a real, correctly-deduped place node with NO city → region →
 * country parents, exactly as `PositionPlacePromoteStage` describes for a cold
 * cache: *"a `done` at version N whose hierarchy arrives when the cache is warm
 * and a generation is bumped past N — not a failure"*. Teaching `promote.place`
 * to try the reverse key as well is a `PLACE_PROMOTION_RULE_GENERATION` bump and
 * belongs with the change that owns that file.
 */
@Injectable()
export class EventReverseStage implements Stage {
  readonly id = STAGE_IDS.ENRICH_EVENT_REVERSE;

  /**
   * Read from `STAGE_VERSIONS`, and cross-checked against the derivation at
   * module load (see the `eventReverseStageVersion()` call above).
   *
   * Both halves are needed and neither substitutes for the other, the same
   * argument `PositionReverseStage` makes: `stageVersion()` is what makes
   * `STAGE_VERSIONS` the number the ledger and this stage agree on; the
   * module-load cross-check is what stops a bumped generation from silently
   * disagreeing with it.
   *
   * Resolved ONCE, at construction. A getter would let the version change under
   * a slice that is mid-flight: ids claimed at version 1 and completed at
   * version 2 are never re-processed by the improvement that bump was for.
   */
  readonly version = stageVersion(STAGE_IDS.ENRICH_EVENT_REVERSE);

  /**
   * `pipeline-enrich`: an external, metered, latency-bound provider. Isolated
   * from `pipeline-embed` so a full-corpus reverse-geocode cannot take the
   * worker slots Ollama-bound work needs.
   */
  readonly queue = PIPELINE_QUEUES.ENRICH;

  readonly entityTypes = [ENTITY_TYPE] as const;

  readonly source = EVENT_REVERSE_SOURCE;

  private readonly limiter: LimitFunction = plimit(
    Math.min(MAX_PROVIDER_CONCURRENCY, Math.max(1, config.geocoding.rateLimitPerSecond)),
  );

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly geocodeService: GeocodeService,
    private readonly logger: LoggerService,
    private readonly eventService: EventService,
  ) {
    this.logger.setContext(EventReverseStage.name);
  }

  /**
   * Name one slice of events.
   *
   * Idempotent, as the stage contract requires: resolving the same coordinate
   * twice reads the same cache row and writes the same name, so two dispatchers
   * racing the same id cost one redundant UPDATE and nothing else.
   *
   * Three phases, and never more than one provider call per distinct cell: load
   * the slice and decide locally what must not be named, resolve each remaining
   * cell once, write every resolved event in one statement.
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
        // Deleted outright, or re-owned, between the sweep and the slice. A
        // skip: nothing to retry.
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    // Group by cache cell BEFORE calling anything. Ids sharing a cell share an
    // answer by construction — it is the same key `GeocodeService` would look up
    // — so this is a strict cost saving, not an approximation.
    const cells = new Map<string, { lat: number; lng: number; ids: string[] }>();

    for (const row of rows) {
      const local = this.decideLocally(row);

      if (local != null) {
        results.set(row.id, local);

        continue;
      }

      // Finite by construction: `decideLocally` returned null, which it only
      // does for a row whose coordinates projected to two finite numbers.
      const lat = Number(row.lat);
      const lng = Number(row.lng);
      const key = cellKey(lat, lng);
      const cell = cells.get(key);

      if (cell == null) {
        cells.set(key, { lat, lng, ids: [row.id] });
      } else {
        cell.ids.push(row.id);
      }
    }

    /** Resolved patches, keyed by event id, awaiting the one bulk UPDATE. */
    const resolved = new Map<string, NamePatch>();

    await Promise.all(
      [...cells.values()].map((cell) =>
        this.limiter(async () => {
          const { result, patch } = await this.resolveCell(cell.lat, cell.lng);

          for (const id of cell.ids) {
            if (patch == null) {
              results.set(id, result);
            } else {
              resolved.set(id, patch);
            }
          }
        }),
      ),
    );

    if (resolved.size === 0) {
      return results;
    }

    try {
      await this.writeNames(ctx.userId, resolved);
      await this.enqueueNamedSearch(resolved);

      for (const [id, patch] of resolved) {
        // No `confidence`. `ReverseGeocodeOutcome` carries no precision signal
        // (the forward path's `location_type` is not surfaced on it), and
        // inventing a number here would teach `promote.place` to prefer a guess
        // over a genuinely-measured value.
        results.set(id, { outcome: 'done', detail: { locationName: patch.locationName } });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // One statement means one outcome: it committed or it did not, so every
      // row in it shares the verdict. Attributing the failure to one id would be
      // a guess, and a guess is what the reason column exists to replace.
      for (const id of resolved.keys()) {
        results.set(id, { outcome: 'failed', reason: 'name_write_failed', detail: { message } });
      }

      this.logger.error(
        `Location name write failed for ${resolved.size} events`,
        err instanceof Error ? err : new Error(message),
      );
    }

    return results;
  }

  /**
   * Everything that can be decided WITHOUT spending a provider call.
   *
   * Returns a terminal result, or `null` when the row should be named. All five
   * checks are free and a billed call is not, so a row this stage may not write
   * must never reach a provider. The ORDER only decides which reason a row that
   * fails more than one check is recorded under, and it runs input-validity
   * before output-ownership deliberately: "this coordinate is not a measurement"
   * is a fact about the row, and it stays true whatever is in the name column.
   */
  private decideLocally(row: CandidateRow): StageResult | null {
    if (row.is_deleted === true) {
      // Soft-deleted between the sweep and the slice. Distinct from
      // `source_row_missing` because the row is still there and will come back
      // if it is undeleted.
      return { outcome: 'skipped', reason: 'event_deleted' };
    }

    if (row.lat == null || row.lng == null) {
      // Cleared between the sweep and the slice. Checked BEFORE the coercion
      // below and not folded into it, because `Number(null)` is `0` — a finite
      // number, and the coordinates of Null Island. A NULL that slipped through
      // a `Number.isFinite` guard would be reverse-geocoded to a point in the
      // Gulf of Guinea, written onto the event as its location, and promoted
      // into a place there. The applicability predicate makes this unreachable
      // today; a guard that does not actually guard is worse than none, because
      // the next person reads it and believes it.
      return { outcome: 'skipped', reason: 'no_coordinates' };
    }

    const lat = Number(row.lat);
    const lng = Number(row.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      // A geography that failed to project, or a numeric that arrived from the
      // driver as something unparseable. Skipped: re-reading the same bytes
      // cannot help.
      return { outcome: 'skipped', reason: 'invalid_coordinates' };
    }

    if (row.location_source === LOCATION_SOURCE_ESTIMATED) {
      // The coordinate is a COPY of a temporally-neighbouring event's, written
      // by `enrich.estimate_location` precisely because this row had none of its
      // own. Naming it would turn "you were probably somewhere near here" into
      // "you were at this venue" — and then `promote.place` would mint a place
      // link off the back of it, which is a fabricated visit that nothing
      // downstream could tell from a measured one.
      //
      // `EstimateLocationStage` refuses estimated coordinates as DONORS for the
      // same reason (an estimate must never be the evidence for another
      // estimate). This is that invariant, one derivation further out.
      return {
        outcome: 'skipped',
        reason: 'coordinates_estimated',
        detail: { locationSource: row.location_source },
      };
    }

    const existingName = row.location_name?.trim() ?? '';

    if (existingName !== '' && !NAME_OWNERSHIP_SOURCES.has(row.location_source ?? '')) {
      // The row already has a name this stage did not write and must not
      // destroy — see {@link NAME_OWNERSHIP_SOURCES}. Skipped BEFORE the
      // provider call, so the protection is also a cost saving.
      return {
        outcome: 'skipped',
        reason: 'name_not_owned',
        detail: { locationSource: row.location_source },
      };
    }

    return null;
  }

  /**
   * Resolve one coordinate cell.
   *
   * Returns either a `patch` (the event resolved and is ready to write) or a
   * terminal `result`. Never throws: `GeocodeService.reverseGeocode` turns
   * transport failures into `status: 'UNKNOWN_ERROR', retryable: true` rather
   * than rejecting, and a throw out of here would take the whole slice down —
   * `PipelineSliceListener` fails every claimed id with one shared reason, so
   * one bad coordinate would charge 199 healthy events an attempt.
   */
  private async resolveCell(
    lat: number,
    lng: number,
  ): Promise<{ result: StageResult; patch: NamePatch | null }> {
    const outcome = await this.geocodeService.reverseGeocode(lat, lng);

    if (outcome.status === 'OK') {
      const placeName = outcome.placeName?.trim();

      if (!placeName) {
        // `GeocodeService` only reports OK with a name, so this is a contract
        // break rather than an empty place. Recorded rather than silently
        // dropped — and a blank name written here would satisfy neither
        // `promote.place`'s predicate nor a reader, while still marking the row
        // done.
        return { result: { outcome: 'skipped', reason: 'no_name_resolved' }, patch: null };
      }

      return { result: { outcome: 'done' }, patch: { locationName: placeName } };
    }

    if (outcome.retryable) {
      // OVER_QUERY_LIMIT, or a transport failure the service already caught.
      //
      // FAILED, not skipped: only a failure gets a retry gate, and a throttled
      // provider must come back on its own schedule rather than being written
      // off as "nothing there". The reason token is load-bearing — it is in
      // `TRANSIENT_FAILURE_REASONS`, which is what tells the ledger to refund
      // the attempt instead of counting it toward quarantine. Renaming it here
      // without renaming it there silently restores the defect where fifteen
      // minutes of outage terminally parked a fifth of a corpus.
      this.logger.warn('Reverse-geocode provider unavailable', { lat, lng, status: outcome.status });

      return {
        result: {
          outcome: 'failed',
          reason: 'provider_unavailable',
          detail: { status: outcome.status },
        },
        patch: null,
      };
    }

    const permanent = PERMANENT_STATUS_REASONS[outcome.status];

    if (permanent != null) {
      // The open-ocean case, and its siblings. A SKIP WITH A REASON — never a
      // silent no-op, and never a row that stays NULL and gets re-billed
      // forever.
      return {
        result: { outcome: 'skipped', reason: permanent, detail: { cached: outcome.cached } },
        patch: null,
      };
    }

    // A status the provider abstraction did not previously produce. Failed, so
    // it retries a bounded number of times and then quarantines visibly, rather
    // than being classed as permanent on a guess.
    this.logger.warn('Reverse-geocode returned an unrecognised status', {
      lat,
      lng,
      status: outcome.status,
    });

    return {
      result: {
        outcome: 'failed',
        reason: 'provider_status_unrecognized',
        detail: { status: outcome.status },
      },
      patch: null,
    };
  }

  /**
   * The slice's events, in one statement.
   *
   * Raw SQL rather than `EventService`, for the reason `GeocodeStage` gives: the
   * columns wanted are a strict subset (a `ci.events` row carries ~40 columns
   * including jsonb blobs, at 200 rows a slice), and going through the memory
   * domain's barrel from inside `domains/pipeline` would couple the pipeline's
   * module graph to it for a projection.
   *
   * lat/lng are projected out of the geography Point with ST_Y/ST_X, exactly as
   * `GeocodeBatchListener.selectReverseCandidates` and `PositionReverseStage` do
   * (PostGIS stores [lng, lat], so the two are easy to transpose; keeping the
   * same spelling everywhere keeps them wrong or right together).
   *
   * `location_name`, `location_source` and `is_deleted` come back because
   * {@link decideLocally} needs them, and needs them BEFORE a billed call.
   *
   * User-scoped even though the sweep already was: a slice can arrive from a
   * dead letter replayed weeks later, and re-scoping is the difference between
   * "this id is not yours" and geocoding — and billing — someone else's
   * movements.
   */
  private loadRows(userId: string, ids: string[]): Promise<CandidateRow[]> {
    return this.dataSource.query<CandidateRow[]>(
      `SELECT e.event_id                                AS id,
              ST_Y(e.location_coordinates::geometry)    AS lat,
              ST_X(e.location_coordinates::geometry)    AS lng,
              e.location_name,
              e.metadata->>'location_source'            AS location_source,
              e.is_deleted
         FROM ci.events e
        WHERE e.event_id = ANY($1::uuid[])
          AND e.user_id = $2::uuid`,
      [ids, userId],
    );
  }

  /**
   * Write every resolved event in ONE statement.
   *
   * `unnest()` over parallel arrays, one round trip per slice. The per-row
   * version of this — `EventService.update` in a loop, plus a second call to
   * `tagLocationSource`, which is exactly what `GeocodeBatchListener`'s reverse
   * leg does — is two round trips per event.
   *
   * `ci.events` is an ordinary table with a primary key on `event_id` (unlike
   * `ci.position`, which is a hypertable and forces `PositionReverseStage` to
   * key its write on `(time, user_id)`), so the id is the whole of the
   * addressing.
   *
   * `location_name` is assigned unconditionally rather than `COALESCE`-filled:
   * filling only NULLs would freeze the first answer any provider ever wrote and
   * make a version bump re-run the provider only to discard its improved answer
   * at the write — the ratchet again, moved from selection into the UPDATE. What
   * protects a name this stage does not own is {@link decideLocally}, which
   * refused the row before it ever reached a provider.
   *
   * `metadata` is merged (`||`), never replaced: it is a shared jsonb bag and
   * this stage owns exactly one key in it. `location_coordinates` and
   * `confidence_score` are NOT touched — this stage read the coordinate and has
   * nothing to say about it, and `confidence_score` is an EVENT-level column
   * that a name derived from a coordinate cannot speak to either way.
   */
  private async writeNames(userId: string, resolved: Map<string, NamePatch>): Promise<void> {
    const entries = [...resolved.entries()];

    await this.dataSource.query(
      `UPDATE ci.events e
          SET location_name = u.location_name,
              metadata      = COALESCE(e.metadata, '{}'::jsonb)
                              || jsonb_build_object('location_source', $2::text),
              updated_at    = now()
         FROM unnest($3::uuid[], $4::text[]) AS u(entity_id, location_name)
        WHERE e.event_id = u.entity_id
          AND e.user_id = $1::uuid`,
      [
        userId,
        LOCATION_SOURCE_REVERSE,
        entries.map(([id]) => id),
        entries.map(([, patch]) => patch.locationName),
      ],
    );
  }

  /**
   * Re-index the events this stage just named.
   *
   * `searchTexts.ts` weights `event.locationName` at 4 and folds it into the
   * event's display title, so a name that lands AFTER `index.vector_event` has
   * recorded `done` is a name search can never return — the ledger's own
   * correctness (do not redo finished work) is what makes a late-arriving
   * enrichment invisible. `PositionReverseStage` solves the identical problem
   * for `ci.position` the identical way: one `sendMany` onto `search-index`,
   * same pattern as `SearchIndexBackfillService`, not a per-row fan-out through
   * every queue.
   *
   * `EventSearchIndexListener` consumes `EventUpdatedEvent` on that queue and
   * re-upserts both the vector and the embedding.
   *
   * Swallowed to a warning: the name is already committed, and failing the slice
   * over the index would re-bill the provider for every id in it on the retry.
   */
  private async enqueueNamedSearch(resolved: Map<string, NamePatch>): Promise<void> {
    const ids = [...resolved.keys()];

    if (ids.length === 0) {
      return;
    }

    try {
      await this.eventService.sendMany(
        'search-index',
        ids.map((eventId) => ({ name: EventUpdatedEvent, data: { eventId } })),
      );
    } catch (err: unknown) {
      this.logger.warn('Could not enqueue event search re-index after reverse geocode', {
        count: ids.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * The cache cell a coordinate falls in.
 *
 * IMPORTED from `PositionReverseStage` rather than re-derived, so the two
 * reverse stages group by exactly the same key `GeocodeService.reverseGeocode`
 * looks up (`reverse:${lat.toFixed(4)},${lng.toFixed(4)}`, ~11 m). A second copy
 * of that rounding is a second thing to forget when it changes, and the moment
 * the two disagree this stage's de-duplication silently becomes an
 * approximation — it would still be correct, just quietly billed twice.
 *
 * Re-exported because this stage's spec asserts on it, and importing it from the
 * sibling in a test about THIS file would hide the coupling rather than state
 * it.
 */
export { cellKey };
