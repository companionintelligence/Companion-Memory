import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import plimit, { type LimitFunction } from 'p-limit';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
// The geocode domain's PUBLIC barrel, not its internals: `no-cross-domain-internals`
// in `.dependency-cruiser.mjs` allows exactly `index.ts` and `events.ts` across a
// domain boundary. `GeocodeService` is the cache-aware orchestration —
// canonicalize, read `ci.geocode_cache`, apply the virtual-location denylist, call
// the provider only on a miss, branch on the provider STATUS (never an HTTP code),
// write the possibly-negative cache row. This stage adds none of that and must
// never re-implement any of it.
import { GeocodeService } from '@ci/domains/geocode';

import { PIPELINE_QUEUES } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, type StageVersion } from '../../versions';

/**
 * This stage's id.
 *
 * Declared here ahead of its `STAGE_IDS` entry, exactly as `INDEX_EMBED_STAGE_ID`
 * and `ENRICH_POSITION_REVERSE_STAGE_ID` were: the central wiring
 * (`constants.ts`, `versions.ts`, `StageRegistry`, `stageProviders`) is one
 * reviewable change and this file is another. It becomes
 * `STAGE_IDS.ENRICH_GEOCODE` — and this const its alias — in the change that
 * lands the four entries. `__tests__/stageWiring.spec.ts` fails, by name, for as
 * long as the two are apart, which is the point of that file.
 *
 * IDS ARE PERMANENT — the id is the third component of `ci.pipeline_state`'s
 * primary key, so renaming it abandons every ledger row written under the old
 * name: the sweep stops finding them, coverage silently drops to zero, and the
 * whole corpus is re-geocoded — against a metered provider — under the new id.
 */
export const ENRICH_GEOCODE_STAGE_ID = 'enrich.geocode';

/** The ledger `entity_type` this stage records under. */
const ENTITY_TYPE = 'event';

// ---------------------------------------------------------------------------
// The version, DERIVED rather than chosen
// ---------------------------------------------------------------------------

/**
 * Generation of the forward-geocode PROVIDER — what a free-text location
 * resolves to.
 *
 * Bump when the answer for an unchanged string changes: a different
 * implementation behind the `GEOCODE_PROVIDER` token (Portal → a self-hosted
 * Nominatim, or back), or a change to which of the provider's candidate results
 * is selected. Not for a transport, key or base-URL change — those do not change
 * the answer.
 *
 * ── The one thing a bump here does NOT do ──────────────────────────────────
 *
 * It re-opens the LEDGER, not the CACHE. `ci.geocode_cache`'s primary key is
 * `sha256(canonicalize(raw))` and carries neither the provider nor a rule
 * version, so a `ZERO_RESULTS` row written by the old provider answers the new
 * one and the corpus is re-swept to the same conclusion for free. Adding
 * `provider` / `rule_version` to that key is the correct fix (it is in the
 * rebuild plan, §5, as a migration against `ci.geocode_cache`) and belongs with
 * the change that owns that table. Until then, a PROVIDER swap wants the
 * affected cache rows cleared alongside the bump; a change to how THIS stage
 * interprets a result needs no such thing, because the interpretation happens
 * here.
 */
export const FORWARD_GEOCODE_PROVIDER_GENERATION = 1;

/**
 * Generation of THIS stage's interpretation rule — which provider outcome
 * becomes which write.
 *
 * Covers {@link OVERWRITABLE_LOCATION_SOURCES} (whose coordinates this stage may
 * replace), the `location_source` provenance vocabulary it writes, and the
 * decision to record `GeocodeService`'s precision-derived confidence verbatim.
 * Bump it in the same commit that edits any of them.
 */
export const GEOCODE_RESULT_RULE_GENERATION = 1;

/**
 * The stage version, derived from the two generations above so that improving
 * EITHER re-runs history.
 *
 * This is the whole reason the stage does not carry a hand-chosen integer.
 * `GeocodeBatchListener` selects on `location_coordinates IS NULL` and states the
 * consequence in its own comment — *"a resolved coordinate is never re-billed"* —
 * so every coarse `APPROXIMATE` city-centroid hit it ever wrote is frozen for the
 * life of the appliance. A better provider could not repair one of them.
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
export const GEOCODE_VERSION = FORWARD_GEOCODE_PROVIDER_GENERATION + GEOCODE_RESULT_RULE_GENERATION - 1;

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
 * A missing entry is not an error — this file is imported by its own spec before
 * the `constants.ts` / `versions.ts` declarations land.
 *
 * `versions` is a parameter only so a test can prove the cross-check without
 * mutating the production declaration.
 *
 * A `STAGE_VERSIONS` entry may also be a THUNK (see `versions.ts`), and this
 * checks only the literal form — deliberately, and for the same reason
 * `PositionReverseStage` does: the thunk for this stage could only be this very
 * function, so invoking one here would recurse forever, and a derivation that IS
 * the declaration cannot disagree with itself.
 */
export function geocodeStageVersion(versions: Record<string, StageVersion> = STAGE_VERSIONS): number {
  const declared = versions[ENRICH_GEOCODE_STAGE_ID];

  if (typeof declared === 'number' && declared !== GEOCODE_VERSION) {
    throw new Error(
      `STAGE_VERSIONS["${ENRICH_GEOCODE_STAGE_ID}"] declares ${declared} but the stage derives ` +
        `${GEOCODE_VERSION} from FORWARD_GEOCODE_PROVIDER_GENERATION ` +
        `(${FORWARD_GEOCODE_PROVIDER_GENERATION}) + GEOCODE_RESULT_RULE_GENERATION ` +
        `(${GEOCODE_RESULT_RULE_GENERATION}) - 1. Bumping a generation is only half the change: update ` +
        `versions.ts in the same commit, or the two disagree about what has already been written.`,
    );
  }

  return GEOCODE_VERSION;
}

// Run at module load, not at first sweep — the same argument `StageRegistry`'s
// completeness guard makes, and the same shape as `assertEmbedModelGenerations()`
// and `positionReverseStageVersion()`. A generation bumped without the matching
// one-line diff to `versions.ts` is a programming error, and the earliest
// possible failure is the cheapest one: at boot, on the operator's terminal,
// rather than inside a worker on whichever appliance reaches this stage first.
geocodeStageVersion();

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Where the sweep looks for candidates, and which of those rows this stage
 * APPLIES to.
 *
 * ── READ THIS BEFORE ADDING `s.location_coordinates IS NULL` ───────────────
 *
 * It is what `GeocodeBatchListener.selectCandidates` does today
 * (`query.andWhere('event.location_coordinates IS NULL')`, plus a second clause
 * excluding rows a prior run tagged `virtual`), it works, and it is the exact
 * ratchet this rebuild exists to delete. `location_coordinates` is this stage's
 * OUTPUT. A predicate over an output column conflates three different facts into
 * one `NULL`:
 *
 *  - never geocoded;
 *  - geocoded, and the provider legitimately had nothing (`ZERO_RESULTS` for a
 *    misspelling, a demolished venue, a private address);
 *  - geocoded successfully, by a provider or a rule we now know was worse — the
 *    coarse `APPROXIMATE` centroids the listener tags at confidence 0.4.
 *
 * The first two are indistinguishable, so an unresolvable string is re-sent to a
 * BILLED provider on every run for as long as the appliance exists. The third is
 * unreachable: the moment a row gets a coordinate it leaves the candidate set
 * permanently, which the listener states outright — *"a resolved coordinate is
 * never re-billed"*.
 *
 * The `metadata->>'location_source' <> 'virtual'` clause is the same defect
 * wearing provenance's clothes: it exists only so a denylisted venue is not
 * re-walked every run, which is the ledger's job now, and it is relaxed by a
 * `retryNull` request flag — a per-request re-run lever that a stage version
 * replaces outright.
 *
 * Whether this stage has run lives in `ci.pipeline_state`, and nowhere else.
 * `StageRegistry.assertApplicabilityPredicate` enforces the mirror-image rule
 * (no reaching into the ledger from here); nothing can enforce the rule above,
 * which is why it is written out at this length.
 *
 * What the predicate DOES say is what a row IS: a live event carrying free text
 * in `location_name` that is worth asking a geocoder about. `is_deleted` is
 * applicability, not completion — `ci.events` is soft-deleted, and spending a
 * metered provider call on a tombstone is pure cost.
 *
 * Note what is NOT filtered here: the virtual-location denylist
 * (`domains/geocode/util/virtualLocations.ts`) is three layers of regex and a
 * heuristic, so it cannot be a SQL clause. `GeocodeService` applies it before any
 * network call, and this stage records the result as `skipped: virtual_location`
 * — countable, and re-openable when the denylist itself improves.
 */
export const GEOCODE_SOURCE: StageSource = {
  schema: 'ci',
  table: 'events',
  idColumn: 'event_id',
  userColumn: 'user_id',
  predicate:
    `s.location_name IS NOT NULL ` +
    `AND btrim(s.location_name) <> '' ` +
    `AND COALESCE(s.is_deleted, false) = false`,
};

// ---------------------------------------------------------------------------
// The interpretation rule
// ---------------------------------------------------------------------------

/**
 * `metadata.location_source` values whose coordinates this stage MAY replace.
 *
 * ── Why a stage that overwrites needs this at all ──────────────────────────
 *
 * `PositionReverseStage` writes its seven columns unconditionally, and argues
 * (correctly) that filling only NULLs would move the ratchet out of candidate
 * selection and into the UPDATE. The same argument applies here — with one
 * difference that changes the answer: `ci.position.address` has exactly one
 * writer, and `ci.events.location_coordinates` has several. Importers write it
 * from source data (Google Takeout "Maps places" rows arrive with the venue's own
 * coordinates and confidence 1.0 — 76 of the 95 named events on the appliance
 * this was written against), `LocationEstimateService` writes a temporal
 * estimate, and this stage writes a geocode. Overwriting unconditionally would
 * let a provider's city centroid at confidence 0.4 silently destroy an exact
 * imported coordinate, which is the failure `types.ts` warns about in
 * `StageResult.confidence`: *a worse answer permanently destroys a better one*.
 *
 * So the rule is ownership, not nullability: this stage replaces coordinates it
 * (or a strictly weaker producer) wrote, and refuses everything else with
 * `skipped: coordinates_not_owned` — decided BEFORE the provider call, so a row
 * it may not write is never billed for either.
 *
 * The members:
 *
 *  - `geocoded` / `approximate` — this stage's own output, at whatever
 *    generation. Replacing them is the entire point of a version bump.
 *  - `estimated` — a temporal nearest-neighbour fill by
 *    `enrich.estimate_location`, which exists precisely because the row had no
 *    location of its own. Geocoding the row's OWN text is strictly better than
 *    copying a neighbour's coordinate, and the two stages agree on the
 *    precedence: `EstimateLocationStage` refuses to overwrite anything but its
 *    own estimates.
 *  - `virtual` — tagged by the old listener; such a row has no coordinates to
 *    protect anyway.
 *
 * NOT a member, and the one worth naming: `reverse_geocoded`. Those rows have
 * MEASURED coordinates (photo EXIF, a GPS fix) and a name DERIVED from them by
 * `enrich.position_reverse`'s sibling path. Forward-geocoding that derived name
 * and writing the answer back would replace a measured fix with the provider's
 * centroid of the provider's own label — a round trip that loses precision every
 * time it runs.
 *
 * ── The honest gap ────────────────────────────────────────────────────────
 *
 * `GeocodeBatchListener` tags only its COARSE hits (`approximate`); a precise hit
 * is left untagged, indistinguishable from an importer's coordinate. Under this
 * rule those rows read as foreign and are skipped, so a bump cannot repair
 * them — the ratchet, one layer down, for exactly the corpus that predates this
 * stage. The fix belongs to the ledger-seeding migration the rebuild plan
 * requires for every conversion (§12.1: seed `enrich.geocode` from
 * `location_coordinates IS NOT NULL`), which should stamp
 * `location_source = 'geocoded'` on the rows it seeds; it is a migration and
 * belongs with the change that owns one. The real answer is `ci.derived_facts`,
 * where two writers' assertions coexist and are ranked instead of one silently
 * clobbering the other — see the pipeline README, "What is NOT built yet".
 */
export const OVERWRITABLE_LOCATION_SOURCES: ReadonlySet<string> = new Set([
  'geocoded',
  'approximate',
  'estimated',
  'virtual',
]);

/**
 * Provenance written onto a row this stage resolves.
 *
 * `approximate` is the existing token — `GeocodeBatchListener` writes it, and
 * `GeocodeService.LOW_CONFIDENCE_THRESHOLD` defines it as a hit at confidence
 * <= 0.4, i.e. a city/region centroid rather than a real venue. `geocoded` is
 * new, and it is what closes the ownership rule above: without it a precise hit
 * is untagged, and an untagged coordinate is indistinguishable from an
 * importer's.
 */
const LOCATION_SOURCE_PRECISE = 'geocoded';
const LOCATION_SOURCE_APPROXIMATE = 'approximate';

/**
 * Provider statuses that are PERMANENT for a given query string, and the ledger
 * reason each becomes. All are `skipped`, never `failed`, because a retry cannot
 * produce a different answer — `GeocodeService` negative-caches every one of them
 * in `ci.geocode_cache`, so a retry would not even reach the provider.
 *
 * `REQUEST_DENIED` deserves its own note, because "the API key is missing" feels
 * transient. It is not, from this stage's point of view: the negative cache row
 * is already written, so every retry re-reads the same denial. Fixing the key (or
 * the Portal credential) is an operator action, and re-opening the corpus
 * afterwards is a version bump — far better than every named event quietly
 * burning its five attempts into quarantine. The failure is also legible at a
 * glance: `12,004 skipped: provider_denied`.
 *
 * DUPLICATED, in effect, from `NON_RETRYABLE_STATUSES` in `GeocodeService` —
 * which the geocode barrel does not export, and reaching past a domain's
 * `index.ts` is a `no-cross-domain-internals` error. Exporting it (and
 * {@link VIRTUAL_STATUS} below) is the correct fix and belongs with the change
 * that owns that file; until then this comment is the link between the two
 * copies. The mapping here is richer anyway: the service knows only
 * retryable-or-not, and the ledger wants a distinct reason per cause.
 */
const PERMANENT_STATUS_REASONS: Readonly<Record<string, string>> = {
  ZERO_RESULTS: 'zero_results',
  REQUEST_DENIED: 'provider_denied',
  INVALID_REQUEST: 'invalid_request',
};

/**
 * The synthetic status `GeocodeService` returns for a denylisted non-physical
 * venue ("Zoom", "TBD", a dial-in number, `https://…`).
 *
 * DUPLICATED from `GeocodeService.VIRTUAL_STATUS` for the reason above. The two
 * MUST stay identical: a drift means every virtual venue falls through to the
 * unrecognised-status branch and is FAILED, retried five times and quarantined,
 * instead of being skipped for free.
 */
const VIRTUAL_STATUS = 'virtual';

/**
 * Provider calls in flight per slice.
 *
 * Bounded by the same two numbers `GeocodeBatchListener` respects — a hard
 * ceiling and the configured QPS — so a slice of cache misses cannot burst past
 * the provider's rate limit and turn into `OVER_QUERY_LIMIT` for everything else
 * on the appliance.
 *
 * NOTE: this is a per-slice bound, and `pipeline-enrich` can work several slices
 * at once, so the appliance-wide rate is not enforced here. It cannot be: the QPS
 * throttle lives in `GeocodeBatchListener` (a private `RateLimiter` in another
 * domain's listener), where no second caller can share it. Moving that throttle
 * into `GeocodeService`, next to the cache it already shares — or into the
 * cross-process `BackpressureService` the plan describes — is the correct fix and
 * belongs with the change that owns that file.
 */
const MAX_PROVIDER_CONCURRENCY = 4;

/** A slice row: the identity, the text to resolve, and what is already there. */
interface CandidateRow {
  id: string;
  location_name: string | null;
  /** True when the row already carries coordinates from SOME writer. */
  has_coordinates: boolean;
  /** `metadata->>'location_source'`, i.e. which writer claims them. */
  location_source: string | null;
  is_deleted: boolean | null;
}

/** What one resolved event writes back. */
interface CoordinatePatch {
  lat: number;
  lng: number;
  /** From `confidenceForLocationType`: 0.95 rooftop, 0.8 venue, 0.4 centroid. */
  confidence: number;
  /** `geocoded` or `approximate`; the ownership marker as well as provenance. */
  locationSource: string;
}

/**
 * Resolves `ci.events.location_name` into `location_coordinates`.
 *
 * The forward half of the geo conversion: this replaces
 * `GeocodeBatchListener`'s SWEEP (its candidate query, its batch loop, its
 * per-batch counters and its `retryNull` flag), not its provider handling, which
 * lives in `GeocodeService` and is untouched.
 *
 * ── The cost, stated up front ──────────────────────────────────────────────
 *
 * Like `enrich.position_reverse`, A SWEEP OF THIS STAGE IS A BILL. Three things
 * hold it down, and only the first two are automatic:
 *
 *  1. `GeocodeService`'s cache. A personal corpus repeats home / office / a
 *    handful of venues, so the hit rate is high and a hit costs nothing.
 *  2. This stage resolves ONE call per distinct canonical query per slice (see
 *    {@link queryKey}). Without it, 200 concurrent events at the same address
 *    would all miss the cache in the same instant and fire 200 identical billed
 *    calls, because the cache row is only written after the first one returns.
 *  3. Nothing here bounds a full-corpus sweep. Get the candidate count before you
 *    get the bill — the query is in the pipeline README under "Blast radius".
 *
 * ── Outcomes ───────────────────────────────────────────────────────────────
 *
 * Every id gets exactly one answer, and every non-`done` answer carries a stable
 * greppable reason. The transient/permanent split is the one that matters —
 * getting it backwards costs money in one direction and coverage in the other:
 *
 *  - `zero_results` — the provider knows nothing at this string. SKIPPED, so it
 *    is never re-billed, and countable: "how many of my events name a place that
 *    does not resolve?" becomes a number instead of a silence. A version bump
 *    re-opens it, which is the point.
 *  - `virtual_location` — a Zoom link, "TBD", a dial-in. Never sent to a
 *    provider at all. Skipped, and re-openable when the denylist improves, which
 *    is what `retryNull` used to be for.
 *  - `provider_denied` / `invalid_request` — permanent for this string; see
 *    {@link PERMANENT_STATUS_REASONS}.
 *  - `provider_unavailable` — `OVER_QUERY_LIMIT`, or a transport failure
 *    `GeocodeService` already caught and reported as retryable `UNKNOWN_ERROR`.
 *    FAILED, so the retry gate and the attempt budget apply and a rate-limited or
 *    unreachable provider reads as a failure count going UP rather than a
 *    coverage number that quietly stops climbing.
 *  - `coordinate_write_failed` — the answer arrived, the UPDATE did not. Failed,
 *    and recorded apart from a provider failure because the two have nothing in
 *    common but their timing.
 *  - `source_row_missing` / `event_deleted` / `no_location_name` /
 *    `coordinates_not_owned` / `no_coordinates_resolved` — skips: nothing to
 *    retry, and each says which.
 *
 * ── What this stage deliberately does NOT do ───────────────────────────────
 *
 * `GeocodeBatchListener` also calls `PlaceService.findOrCreateForGeocode` and
 * writes `location_entity_id`, linking the event into the place graph. That is a
 * SEPARATE decision at a separate version — a better place-dedupe rule should be
 * re-runnable without re-billing the geocoder, and folding it in here would make
 * one integer unable to address the two independently. It belongs in a
 * `promote.place_link` stage reading the components this stage's provider answer
 * already put in `ci.geocode_cache`. **The listener must not be deleted before
 * that stage exists**, or place linking silently stops for new events; the phase
 * that owns the removal owns that check. `EmbedStage` makes the identical
 * argument about the tsvector it does not write.
 */
@Injectable()
export class GeocodeStage implements Stage {
  readonly id = ENRICH_GEOCODE_STAGE_ID;

  /**
   * The DERIVED version — see {@link geocodeStageVersion}.
   *
   * Calls the derivation rather than `stageVersion(id)`, as `EmbedStage` does and
   * for the same reason: the derivation is the authority and the `STAGE_VERSIONS`
   * entry mirrors it, cross-checked at module load, so the two cannot disagree.
   * `__tests__/stageWiring.spec.ts` asserts `stage.version === stageVersion(id)`
   * for every stage on disk, so this is held to the identical check as a
   * literal-versioned one.
   *
   * Resolved ONCE, at construction. A getter would let the version change under a
   * slice that is mid-flight: ids claimed at version 1 and completed at version 2
   * are never re-processed by the improvement that bump was for.
   */
  readonly version = geocodeStageVersion();

  /**
   * `pipeline-enrich`: an external, metered, latency-bound provider. Isolated
   * from `pipeline-embed` so a full-corpus geocode cannot take the worker slots
   * Ollama-bound work needs.
   */
  readonly queue = PIPELINE_QUEUES.ENRICH;

  readonly entityTypes = [ENTITY_TYPE] as const;

  readonly source = GEOCODE_SOURCE;

  private readonly limiter: LimitFunction = plimit(
    Math.min(MAX_PROVIDER_CONCURRENCY, Math.max(1, config.geocoding.rateLimitPerSecond)),
  );

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly geocodeService: GeocodeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GeocodeStage.name);
  }

  /**
   * Geocode one slice of events.
   *
   * Idempotent, as the stage contract requires: resolving the same string twice
   * reads the same cache row and writes the same coordinate, so two dispatchers
   * racing the same id cost one redundant UPDATE and nothing else.
   *
   * Three phases, and never more than one provider call per distinct canonical
   * query: load the slice and decide locally what must not be geocoded, resolve
   * each remaining query once, write every resolved event in one statement.
   */
  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    const rows = await this.loadRows(ctx.userId, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Answer for the ids that came back with no row FIRST, so the map is complete
    // even if the work below throws in a way this does not model.
    // `PipelineSliceListener` records anything missing as
    // `failed: stage_returned_no_result`, which is correct but uninformative.
    for (const id of ids) {
      if (!byId.has(id)) {
        // Deleted outright, or re-owned, between the sweep and the slice. A skip:
        // nothing to retry.
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    // Group by the CANONICAL query before calling anything. Two rows whose
    // location_name canonicalizes the same share a `ci.geocode_cache` row by
    // construction — it is the same key `GeocodeService` would look up — so this
    // is a strict cost saving, not an approximation.
    const queries = new Map<string, { location: string; ids: string[] }>();

    for (const row of rows) {
      const local = this.decideLocally(row);

      if (local != null) {
        results.set(row.id, local);

        continue;
      }

      // Non-null by construction: `decideLocally` returned null, which it only
      // does for a row carrying non-empty text.
      const location = (row.location_name as string).trim();
      const key = queryKey(location);
      const query = queries.get(key);

      if (query == null) {
        queries.set(key, { location, ids: [row.id] });
      } else {
        query.ids.push(row.id);
      }
    }

    /** Resolved patches, keyed by event id, awaiting the one bulk UPDATE. */
    const resolved = new Map<string, CoordinatePatch>();

    await Promise.all(
      [...queries.values()].map((query) =>
        this.limiter(async () => {
          const { result, patch } = await this.resolveQuery(query.location);

          for (const id of query.ids) {
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
      await this.writeCoordinates(ctx.userId, resolved);

      for (const [id, patch] of resolved) {
        // The confidence is REAL here, unlike most stages: it comes from the
        // provider's own `location_type` (rooftop / venue / centroid) through
        // `confidenceForLocationType`. Reporting it is what lets a later promoter
        // rank this answer against another writer's instead of guessing.
        results.set(id, {
          outcome: 'done',
          confidence: patch.confidence,
          detail: { locationSource: patch.locationSource },
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // One statement means one outcome: it committed or it did not, so every row
      // in it shares the verdict. Attributing the failure to one id would be a
      // guess, and a guess is what the reason column exists to replace.
      for (const id of resolved.keys()) {
        results.set(id, {
          outcome: 'failed',
          reason: 'coordinate_write_failed',
          detail: { message },
        });
      }

      this.logger.error(
        `Coordinate write failed for ${resolved.size} events`,
        err instanceof Error ? err : new Error(message),
      );
    }

    return results;
  }

  /**
   * Everything that can be decided WITHOUT spending a provider call.
   *
   * Returns a terminal result, or `null` when the row should be geocoded. The
   * order matters only in that all three checks are free and a billed call is
   * not: a row this stage may not write must never be sent to a provider.
   */
  private decideLocally(row: CandidateRow): StageResult | null {
    if (row.is_deleted === true) {
      // Soft-deleted between the sweep and the slice. Distinct from
      // `source_row_missing` because the row is still there and will come back if
      // it is undeleted.
      return { outcome: 'skipped', reason: 'event_deleted' };
    }

    if (row.location_name == null || row.location_name.trim().length === 0) {
      // The applicability predicate requires non-empty text, so this is a name
      // cleared mid-flight, or a replayed dead letter carrying stale ids.
      return { outcome: 'skipped', reason: 'no_location_name' };
    }

    if (row.has_coordinates && !OVERWRITABLE_LOCATION_SOURCES.has(row.location_source ?? '')) {
      // The row already has coordinates this stage did not write and must not
      // destroy — see {@link OVERWRITABLE_LOCATION_SOURCES}. Skipped BEFORE the
      // provider call, so the protection is also a cost saving.
      return {
        outcome: 'skipped',
        reason: 'coordinates_not_owned',
        detail: { locationSource: row.location_source },
      };
    }

    return null;
  }

  /**
   * Resolve one canonical query.
   *
   * Returns either a `patch` (the event resolved and is ready to write) or a
   * terminal `result`. Never throws: `GeocodeService.geocode` turns transport
   * failures into `status: 'UNKNOWN_ERROR', retryable: true` rather than
   * rejecting, and a throw out of here would take the whole slice down —
   * `PipelineSliceListener` fails every claimed id with one shared reason, so one
   * bad string would charge 199 healthy events an attempt.
   *
   * No `bustCache`. That option exists for `GeocodeBatchListener`'s `retryNull`
   * flag — a per-request "re-attempt what a prior run negative-cached" lever that
   * the stage version replaces. Re-running the provider on every sweep would
   * defeat the cache the cost argument rests on; see
   * {@link FORWARD_GEOCODE_PROVIDER_GENERATION} for what a bump does and does not
   * re-open.
   */
  private async resolveQuery(
    location: string,
  ): Promise<{ result: StageResult; patch: CoordinatePatch | null }> {
    const outcome = await this.geocodeService.geocode(location);

    if (outcome.status === 'OK') {
      const point = outcome.point;

      if (point == null || outcome.confidence == null) {
        // `GeocodeService` only reports OK with a Point and a confidence, so this
        // is a contract break rather than an empty answer. Recorded rather than
        // silently dropped.
        return { result: { outcome: 'skipped', reason: 'no_coordinates_resolved' }, patch: null };
      }

      // PostGIS / GeoJSON order coordinates [lng, lat] (X, Y). The transposition
      // is the classic bug in this file's neighbourhood, which is why
      // `GeocodeService.toPoint` guards the ranges on the way in and this
      // destructuring is spelled the same way everywhere it appears.
      const [lng, lat] = point.coordinates;

      return {
        result: { outcome: 'done' },
        patch: {
          lat,
          lng,
          confidence: outcome.confidence,
          // A coarse `APPROXIMATE` centroid — likely a label that slipped past the
          // denylist resolving to a city center — is tagged so it stays
          // distinguishable from a precise street/venue hit, exactly as the
          // listener does today.
          locationSource:
            outcome.lowConfidence === true ? LOCATION_SOURCE_APPROXIMATE : LOCATION_SOURCE_PRECISE,
        },
      };
    }

    if (outcome.status === VIRTUAL_STATUS) {
      // A denylisted non-physical venue. Never sent to the provider, so this is
      // free — and permanent until the denylist itself improves, which is a
      // version bump rather than the `retryNull` flag it used to be.
      return { result: { outcome: 'skipped', reason: 'virtual_location' }, patch: null };
    }

    if (outcome.retryable) {
      // OVER_QUERY_LIMIT, or a transport failure the service already caught.
      // FAILED, not skipped: the retry gate, the attempt budget and quarantine
      // only apply to failures, and a throttled provider must come back on its
      // own schedule rather than being written off as "nothing there".
      this.logger.warn('Geocode provider unavailable', { status: outcome.status });

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
      // The unresolvable-string case, and its siblings. A SKIP WITH A REASON —
      // never a silent no-op, and never a row that stays NULL and gets re-billed
      // forever.
      return {
        result: { outcome: 'skipped', reason: permanent, detail: { cached: outcome.cached } },
        patch: null,
      };
    }

    // A status the provider abstraction did not previously produce. Failed, so it
    // retries a bounded number of times and then quarantines visibly, rather than
    // being classed as permanent on a guess.
    this.logger.warn('Geocode returned an unrecognised status', { status: outcome.status });

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
   * Raw SQL rather than `EventService`, for the reason `EmbedStage` gives about
   * `ContentService`: the columns wanted are a strict subset (a `ci.events` row
   * carries ~40 columns including jsonb blobs, at 200 rows a slice), and going
   * through the memory domain's barrel from inside `domains/pipeline` would
   * couple the pipeline's module graph to it for a projection.
   *
   * `is_deleted` and the existing coordinate/provenance come back because
   * {@link decideLocally} needs them, and needs them BEFORE a billed call.
   *
   * User-scoped even though the sweep already was: a slice can arrive from a dead
   * letter replayed weeks later, and re-scoping is the difference between "this id
   * is not yours" and geocoding — and billing — someone else's calendar.
   */
  private loadRows(userId: string, ids: string[]): Promise<CandidateRow[]> {
    return this.dataSource.query<CandidateRow[]>(
      `SELECT e.event_id AS id,
              e.location_name,
              (e.location_coordinates IS NOT NULL) AS has_coordinates,
              e.metadata->>'location_source' AS location_source,
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
   * `unnest()` over parallel arrays, one round trip per slice. The per-row version
   * of this pattern — `EventService.update` in a loop, as the listener does — is
   * why a 200-row geocode batch is 200 round trips plus 200 more for the
   * provenance tag.
   *
   * `ci.events` is an ordinary table with a primary key on `event_id` (unlike
   * `ci.position`, which is a hypertable and forces `PositionReverseStage` to key
   * its write on `(time, user_id)`), so the id is the whole of the addressing.
   *
   * `confidence_score` is ASSIGNED, not `LEAST(...)`-ed as the estimator does.
   * That is deliberate and it is the same argument as overwriting the coordinate:
   * a bump that improves a 0.4 city centroid into a 0.95 rooftop must be able to
   * raise the number, and `LEAST` would freeze the first — worst — value forever.
   * The honest cost is that `ci.events.confidence_score` is an EVENT-level column
   * carrying a LOCATION-level fact; separating them is what `ci.derived_facts` is
   * for, and that table does not exist yet.
   *
   * `metadata` is merged (`||`), never replaced: it is a shared jsonb bag and
   * this stage owns exactly one key in it.
   *
   * No `RETURNING`, and the return value is discarded: the statement either
   * commits for the whole slice or throws, and which ids it touched is already
   * known. That is also why this can stay a bare `UPDATE` while
   * `EstimateLocationStage` has to wrap its own in a CTE — TypeORM hands back
   * `[rows, rowCount]` rather than rows for an `UPDATE … RETURNING`, which only
   * matters to a caller that reads them.
   */
  private async writeCoordinates(userId: string, resolved: Map<string, CoordinatePatch>): Promise<void> {
    const entries = [...resolved.entries()];

    await this.dataSource.query(
      `UPDATE ci.events e
          SET location_coordinates = ST_SetSRID(ST_MakePoint(u.lng, u.lat), 4326)::geography,
              confidence_score     = u.confidence,
              metadata             = COALESCE(e.metadata, '{}'::jsonb)
                                     || jsonb_build_object('location_source', u.location_source),
              updated_at           = now()
         FROM unnest($1::uuid[], $2::float8[], $3::float8[], $4::float8[], $5::text[])
              AS u(entity_id, lat, lng, confidence, location_source)
        WHERE e.event_id = u.entity_id
          AND e.user_id = $6::uuid`,
      [
        entries.map(([id]) => id),
        entries.map(([, patch]) => patch.lat),
        entries.map(([, patch]) => patch.lng),
        entries.map(([, patch]) => patch.confidence),
        entries.map(([, patch]) => patch.locationSource),
        userId,
      ],
    );
  }
}

/**
 * The `ci.geocode_cache` row a free-text location will land in.
 *
 * `GeocodeService.canonicalize` is the real normalization rule (trim, lowercase,
 * NFKD, strip punctuation, collapse whitespace) and it is called here rather than
 * re-implemented, so two ids grouped together are GUARANTEED to hit the same
 * cache row — which is what makes resolving one of them and reusing the answer
 * exact rather than approximate. `PositionReverseStage.cellKey` has to duplicate
 * its key builder because the reverse key is assembled inline in `GeocodeService`;
 * the forward one is a public static, so this one does not.
 */
export function queryKey(location: string): string {
  return GeocodeService.canonicalize(location);
}
