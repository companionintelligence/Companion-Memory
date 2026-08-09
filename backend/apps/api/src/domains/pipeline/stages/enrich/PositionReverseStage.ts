import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import plimit, { type LimitFunction } from 'p-limit';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
// The geocode domain's PUBLIC barrel, not its internals: `no-cross-domain-internals`
// in `.dependency-cruiser.mjs` allows exactly `index.ts` and `events.ts` across a
// domain boundary. `GeocodeService` is the cache-aware orchestration — canonicalize,
// read `ci.geocode_cache`, call the provider only on a miss, branch on the provider
// STATUS (never an HTTP code), write the possibly-negative cache row. This stage
// adds none of that and must never re-implement any of it.
import { GeocodeService } from '@ci/domains/geocode';

import { PIPELINE_QUEUES, STAGE_IDS } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, stageVersion, type StageVersion } from '../../versions';

/**
 * Alias for {@link STAGE_IDS.ENRICH_POSITION_REVERSE}, which is now the sole
 * declaration.
 *
 * This used to be a local string literal, landed ahead of the `constants.ts`
 * entry. It survives only as an alias because `__tests__/PositionReverseStage.spec.ts`
 * imports the name; new code reads `STAGE_IDS.ENRICH_POSITION_REVERSE`, and the
 * alias goes away with the change that owns that spec.
 *
 * IDS ARE PERMANENT — the id is the third component of `ci.pipeline_state`'s
 * primary key, so renaming it abandons every ledger row written under the old
 * name: the sweep stops finding them, coverage silently drops to zero, and the
 * whole corpus is re-processed under the new id.
 */
export const ENRICH_POSITION_REVERSE_STAGE_ID = STAGE_IDS.ENRICH_POSITION_REVERSE;

/** The ledger `entity_type` this stage records under. */
const ENTITY_TYPE = 'position';

// ---------------------------------------------------------------------------
// The version, DERIVED rather than chosen
// ---------------------------------------------------------------------------

/**
 * Generation of the reverse-geocode PROVIDER — what a coordinate resolves to.
 *
 * Bump when the answer for an unchanged coordinate changes: a different
 * implementation behind the `GEOCODE_PROVIDER` token (a local Nominatim, a
 * Portal-routed provider), or a change to which of the provider's candidate
 * results is selected. Not for a transport or key change — those do not change
 * the answer.
 */
export const REVERSE_GEOCODE_PROVIDER_GENERATION = 1;

/**
 * Generation of THIS stage's interpretation rule — which provider component
 * lands in which `ci.position` column. See {@link ADDRESS_COMPONENT_RULE}; bump
 * this in the same commit that edits it.
 */
export const POSITION_ADDRESS_RULE_GENERATION = 1;

/**
 * The stage version, derived from the two generations above so that improving
 * EITHER re-runs history. That is the entire reason this stage does not carry a
 * hand-chosen integer: the coarse, wrong or empty addresses a first-generation
 * provider wrote are repairable, and under the old `address IS NULL` style of
 * candidate selection they never would have been.
 *
 * The derivation is a SUM (offset so that both-at-1 gives 1, because
 * `versions.ts` refuses a version below 1). A sum is monotone in each term, so
 * the version can only ever go UP — which is the invariant `versions.ts` states
 * and the reason `EmbedStage` argues at length against `version = hash(...)`: a
 * hash is uniformly distributed, so half of all changes move the version DOWN,
 * and a version that goes down leaves every processed row looking stale-forward
 * and permanently invisible to the sweep.
 *
 * Both terms must stay integers >= 1. `versions.ts`'s own boot guard checks the
 * DECLARED value; {@link positionReverseStageVersion} checks that the two agree.
 */
export const POSITION_REVERSE_VERSION =
  REVERSE_GEOCODE_PROVIDER_GENERATION + POSITION_ADDRESS_RULE_GENERATION - 1;

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
 * checks only the literal form — deliberately. The thunk for this stage could
 * only be this very function, so invoking one here would recurse forever; and a
 * thunk needs no cross-check anyway, because a derivation that IS the
 * declaration cannot disagree with itself. `versions.ts` explains why this entry
 * is a literal rather than a thunk in the first place.
 */
export function positionReverseStageVersion(versions: Record<string, StageVersion> = STAGE_VERSIONS): number {
  const declared = versions[ENRICH_POSITION_REVERSE_STAGE_ID];

  if (typeof declared === 'number' && declared !== POSITION_REVERSE_VERSION) {
    throw new Error(
      `STAGE_VERSIONS["${ENRICH_POSITION_REVERSE_STAGE_ID}"] declares ${declared} but the stage derives ` +
        `${POSITION_REVERSE_VERSION} from REVERSE_GEOCODE_PROVIDER_GENERATION ` +
        `(${REVERSE_GEOCODE_PROVIDER_GENERATION}) + POSITION_ADDRESS_RULE_GENERATION ` +
        `(${POSITION_ADDRESS_RULE_GENERATION}) - 1. Bumping a generation is only half the change: update ` +
        `versions.ts in the same commit, or the two disagree about what has already been written.`,
    );
  }

  return POSITION_REVERSE_VERSION;
}

// Run at module load, not at first sweep — the same argument `StageRegistry`'s
// completeness guard makes, and the same shape as `assertEmbedModelGenerations()`
// in `stages/index/EmbedStage.ts`. A generation bumped without the matching
// one-line diff to `versions.ts` is a programming error, and the earliest
// possible failure is the cheapest one: at boot, on the operator's terminal,
// rather than inside a worker on whichever appliance reaches this stage first.
positionReverseStageVersion();

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Where the sweep looks for candidates, and which of those rows this stage
 * APPLIES to.
 *
 * ── READ THIS BEFORE ADDING `s.address IS NULL` ────────────────────────────
 *
 * It is the obvious thing to write here, it would work, and it is exactly the
 * ratchet this whole rebuild exists to delete. `ci.position`'s seven address
 * columns are the stage's OUTPUT. A predicate over an output column conflates
 * three different facts into one `NULL`:
 *
 *  - never reverse-geocoded;
 *  - reverse-geocoded and the provider legitimately returned nothing (a fix in
 *    the middle of the Pacific, an unmapped desert track);
 *  - reverse-geocoded successfully, by a version we now know was wrong.
 *
 * The first two are indistinguishable, so an open-ocean fix would be re-sent to
 * a BILLED provider on every run for as long as the appliance exists. The third
 * is unreachable: the moment a row gets an address it leaves the candidate set
 * permanently, so a better provider, a Portal-routed one, or a fixed
 * component-to-column mapping could only ever apply to fixes recorded
 * afterwards — never to the 25 years of history already here.
 *
 * Whether this stage has run lives in `ci.pipeline_state`, and nowhere else.
 * `StageRegistry.assertApplicabilityPredicate` enforces the mirror-image rule
 * (no reaching into the ledger from here); nothing can enforce the rule above,
 * which is why it is written out at this length.
 *
 * What the predicate DOES say is what a row IS:
 *
 *  - `s.location IS NOT NULL` — the fix has absolute coordinates. `ci.position`
 *    also carries RELATIVE fixes (`reference_entity_id` + `relative_coordinates`,
 *    see the `valid_positioning` CHECK), which have no lat/lng to reverse and are
 *    not this stage's to interpret.
 *  - `s.id IS NOT NULL` — `ci.position.id` is nullable (added by
 *    `20251205185102_add_id_to_position` and backfilled, never constrained), and
 *    `ci.pipeline_state.entity_id` is a typed uuid. A row with no id cannot be
 *    recorded in the ledger at all, so it is not a candidate — that is a fact
 *    about the row, not about the work.
 */
export const POSITION_REVERSE_SOURCE: StageSource = {
  schema: 'ci',
  table: 'position',
  idColumn: 'id',
  userColumn: 'user_id',
  predicate: 's.location IS NOT NULL AND s.id IS NOT NULL',
};

// ---------------------------------------------------------------------------
// The interpretation rule
// ---------------------------------------------------------------------------

/** One Google-style address component (`{long_name, short_name, types[]}`). */
interface AddressComponent {
  long_name?: string;
  short_name?: string;
  types?: string[];
}

/** The five columns filled from address components. `address` comes whole. */
type ComponentColumn = 'city' | 'region' | 'country' | 'postalCode' | 'name' | 'description';

/**
 * Provider address component → `ci.position` column, most-preferred type first.
 *
 * **Edit this and bump {@link POSITION_ADDRESS_RULE_GENERATION} in the same
 * commit**, or the improvement applies only to fixes that arrive afterwards —
 * which is the defect, one layer down from candidate selection.
 *
 * Choices worth stating:
 *
 *  - `city` has fallbacks because `locality` is a US-shaped assumption.
 *    `postal_town` is what the UK returns, `sublocality` is common across Asia,
 *    and `PlaceService.findOrCreateAdminPlace` already carries a comment about
 *    partial component sets being normal outside the US.
 *  - `long_name`, not `short_name`, matching `PlaceService`'s hierarchy
 *    extraction. "United States" and "US" in the same column across two writers
 *    is a dedupe problem nobody would find until a GROUP BY looked wrong.
 *  - `name` is a venue, not a repeat of the address. Falling back to the
 *    formatted address would make the column carry no information the `address`
 *    column does not already have, and would make "this fix is at a named place"
 *    unqueryable. Most GPS fixes have no venue, and that is a correct NULL.
 *  - `description` carries the sub-city context (neighbourhood) that none of the
 *    other six columns hold. It is a component read like every other one — this
 *    stage never composes prose into a data column.
 */
export const ADDRESS_COMPONENT_RULE: ReadonlyArray<{
  column: ComponentColumn;
  componentTypes: readonly string[];
}> = [
  { column: 'city', componentTypes: ['locality', 'postal_town', 'sublocality'] },
  { column: 'region', componentTypes: ['administrative_area_level_1'] },
  { column: 'country', componentTypes: ['country'] },
  { column: 'postalCode', componentTypes: ['postal_code'] },
  { column: 'name', componentTypes: ['point_of_interest', 'establishment', 'premise'] },
  { column: 'description', componentTypes: ['neighborhood', 'sublocality_level_1'] },
];

/** What one resolved fix writes back. Every field is nullable; most fixes fill some. */
type AddressPatch = Record<ComponentColumn, string | null> & { address: string };

/**
 * Provider statuses that are PERMANENT for a given coordinate, and the ledger
 * reason each becomes. All are `skipped`, never `failed`, because a retry cannot
 * produce a different answer — `GeocodeService` negative-caches every one of
 * them in `ci.geocode_cache`, so a retry would not even reach the provider.
 *
 * `REQUEST_DENIED` deserves its own note, because "the API key is missing" feels
 * transient. It is not, from this stage's point of view: the negative cache row
 * is already written, so every retry re-reads the same denial. Fixing the key is
 * an operator action, and re-opening the corpus afterwards is a version bump —
 * which is precisely the lever this subsystem provides, and is far better than
 * 861k rows quietly burning their five attempts into quarantine. The failure is
 * also legible at a glance: `861,402 skipped: provider_denied`.
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

/** A slice row: the identity, the chunk key, and the point to reverse. */
interface CandidateRow {
  id: string;
  /** Part of `ci.position`'s `(time, user_id)` PK — the only cheap way to UPDATE it. */
  time: Date | string;
  lat: number | string;
  lng: number | string;
}

/**
 * Fills `ci.position`'s seven address columns by reverse-geocoding each fix.
 *
 * ── What this stage is for ─────────────────────────────────────────────────
 *
 * `address`, `city`, `region`, `country`, `postal_code`, `name` and
 * `description` have existed on `ci.position` since
 * `20251111000000_add_position_fields` and a schema audit found that NO CODE
 * WRITES THEM. They are accepted on the bulk-import wire (`createPositionSchema`)
 * and returned by the read path, so a fix imported with an Apple placemark keeps
 * one — but nothing has ever derived one. Every GPS point the appliance
 * collected itself is a bare pair of coordinates. This is that missing writer.
 *
 * ── The cost, stated up front ──────────────────────────────────────────────
 *
 * Unlike `enrich.media_dimensions`, A SWEEP OF THIS STAGE IS A BILL. Reverse
 * geocoding is a metered external call, and `ci.position` is the largest table on
 * the appliance — an import running while this was written carries ~861k rows.
 * Three things hold the cost down, and only the first two are automatic:
 *
 *  1. `GeocodeService`'s cache keys reverse lookups on the coordinate rounded to
 *     4 decimals (~11 m), so every fix at a place already resolved is free. For
 *     stationary time — which is most of a human's GPS history — that is nearly
 *     all of them.
 *  2. This stage resolves ONE call per distinct cell per slice (see
 *     {@link cellKey}). Without it, 200 concurrent fixes standing still in one
 *     room would all miss the cache in the same instant and fire 200 identical
 *     billed calls, because the cache row is only written after the first one
 *     returns.
 *  3. Nothing here bounds a full-history sweep. Motion produces a fresh cell
 *     every ~11 m, so a driven route genuinely costs one call per fix.
 *     Down-sampling a trace to its stops belongs in a `clean.*` stage, and until
 *     one exists this stage should be swept deliberately, not nightly. Get the
 *     candidate count before you get the bill — the query is in the pipeline
 *     README under "Blast radius".
 *
 * ── Outcomes ───────────────────────────────────────────────────────────────
 *
 * Every id gets exactly one answer, and every non-`done` answer carries a stable
 * greppable reason. The transient/permanent split is the one that matters:
 *
 *  - `zero_results` — the provider knows this coordinate and has nothing there:
 *    open ocean, Antarctic ice, an unmapped track. SKIPPED, so it is never
 *    re-billed, and countable — "how much of my history is nowhere?" becomes a
 *    number instead of a silence. A version bump re-opens it, which is the point:
 *    a provider with better rural coverage should get to answer again.
 *  - `provider_denied` / `invalid_request` — permanent for this coordinate; see
 *    {@link PERMANENT_STATUS_REASONS}.
 *  - `provider_unavailable` — `OVER_QUERY_LIMIT` or a transport failure.
 *    FAILED, so the retry gate and the attempt budget apply and a rate-limited or
 *    unreachable provider reads as a failure count going UP rather than a
 *    coverage number that quietly stops climbing.
 *  - `address_write_failed` — the answer arrived, the UPDATE did not. Failed, and
 *    recorded apart from a provider failure because the two have nothing in
 *    common but their timing.
 *  - `source_row_missing` / `no_coordinates` / `invalid_coordinates` /
 *    `no_address_resolved` — skips: nothing to retry, and each says which.
 *
 * ── This stage overwrites ──────────────────────────────────────────────────
 *
 * A resolved fix's seven columns are written unconditionally, not
 * `COALESCE`-filled. Filling only NULLs would freeze the first answer ever
 * written — including a first-generation provider's — and make a version bump
 * re-run the provider only to discard its improved answer at the write. That is
 * the ratchet again, moved from selection into the UPDATE.
 *
 * The honest consequence: an address supplied by the importer is replaced by this
 * stage's. Letting two writers' assertions coexist and be ranked is what
 * `ci.derived_facts` is for, and that table does not exist yet (see the pipeline
 * README, "What is NOT built yet"). The stage version recorded in the ledger is
 * what makes the current answer attributable in the meantime.
 */
@Injectable()
export class PositionReverseStage implements Stage {
  readonly id = STAGE_IDS.ENRICH_POSITION_REVERSE;

  /**
   * Read from `STAGE_VERSIONS`, like every literal-versioned stage — and
   * cross-checked against the derivation at module load (see the
   * `positionReverseStageVersion()` call below the class).
   *
   * Both halves are needed and neither substitutes for the other.
   * `stageVersion()` is what makes `STAGE_VERSIONS` the number the ledger and
   * this stage agree on; the module-load cross-check is what stops a bumped
   * generation from silently disagreeing with it. Reading the derivation here
   * instead would satisfy `StageRegistry` (it compares the two) but would leave
   * the constant able to drift until the first sweep resolved a stage.
   *
   * Resolved ONCE, at construction. A getter would let the version change under
   * a slice that is mid-flight: ids claimed at version 1 completed at version 2
   * are never re-processed by the improvement that bump was for.
   */
  readonly version = stageVersion(STAGE_IDS.ENRICH_POSITION_REVERSE);

  /**
   * `pipeline-enrich`: an external, metered, latency-bound provider. Isolated
   * from `pipeline-embed` so a full-history reverse-geocode cannot take the
   * worker slots Ollama-bound work needs.
   */
  readonly queue = PIPELINE_QUEUES.ENRICH;

  readonly entityTypes = [ENTITY_TYPE] as const;

  readonly source = POSITION_REVERSE_SOURCE;

  private readonly limiter: LimitFunction = plimit(
    Math.min(MAX_PROVIDER_CONCURRENCY, Math.max(1, config.geocoding.rateLimitPerSecond)),
  );

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly geocodeService: GeocodeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PositionReverseStage.name);
  }

  /**
   * Reverse-geocode one slice of fixes.
   *
   * Idempotent, as the stage contract requires: resolving the same coordinate
   * twice reads the same cache row and writes the same seven values, so two
   * dispatchers racing the same id cost one redundant UPDATE and nothing else.
   *
   * Three phases, and never more than one provider call per distinct cell:
   * load the slice, resolve each cell once, write every resolved fix in one
   * statement.
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

    // Group by cache cell BEFORE calling anything. Ids sharing a cell share an
    // answer by construction — it is the same key `GeocodeService` would look up
    // — so this is a strict cost saving, not an approximation.
    const cells = new Map<string, { lat: number; lng: number; ids: string[] }>();

    for (const row of rows) {
      const lat = Number(row.lat);
      const lng = Number(row.lng);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        // The applicability predicate requires a non-NULL `location`, so this is
        // a row whose geography failed to project — corrupt, or NULL arriving as
        // NaN through the driver. Skipped: re-reading the same bytes cannot help.
        results.set(row.id, {
          outcome: 'skipped',
          reason: row.lat == null || row.lng == null ? 'no_coordinates' : 'invalid_coordinates',
        });

        continue;
      }

      const key = cellKey(lat, lng);
      const cell = cells.get(key);

      if (cell == null) {
        cells.set(key, { lat, lng, ids: [row.id] });
      } else {
        cell.ids.push(row.id);
      }
    }

    /** Resolved patches, keyed by position id, awaiting the one bulk UPDATE. */
    const resolved = new Map<string, AddressPatch>();

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
      await this.writeAddresses(ctx.userId, resolved, byId);

      for (const [id, patch] of resolved) {
        // No `confidence`. `ReverseGeocodeOutcome` carries no precision signal
        // (the forward path's `location_type` is not surfaced on it), and
        // inventing a number here would teach promotion to prefer a guess over a
        // genuinely-measured value.
        results.set(id, { outcome: 'done', detail: { address: patch.address } });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // One statement means one outcome: it committed or it did not, so every row
      // in it shares the verdict. Attributing the failure to one id would be a
      // guess, and a guess is what the reason column exists to replace.
      for (const id of resolved.keys()) {
        results.set(id, { outcome: 'failed', reason: 'address_write_failed', detail: { message } });
      }

      this.logger.error(
        `Address write failed for ${resolved.size} position fixes`,
        err instanceof Error ? err : new Error(message),
      );
    }

    return results;
  }

  /**
   * Resolve one coordinate cell.
   *
   * Returns either a `patch` (the fix resolved and is ready to write) or a
   * terminal `result`. Never throws: `GeocodeService.reverseGeocode` turns
   * transport failures into `status: 'UNKNOWN_ERROR', retryable: true` rather
   * than rejecting, and a throw out of here would take the whole slice down —
   * `PipelineSliceListener` fails every claimed id with one shared reason, so one
   * bad coordinate would charge 199 healthy fixes an attempt.
   */
  private async resolveCell(
    lat: number,
    lng: number,
  ): Promise<{ result: StageResult; patch: AddressPatch | null }> {
    const outcome = await this.geocodeService.reverseGeocode(lat, lng);

    if (outcome.status === 'OK') {
      const placeName = outcome.placeName?.trim();

      if (!placeName) {
        // `GeocodeService` only reports OK with a name, so this is a contract
        // break rather than an empty place. Recorded rather than silently dropped.
        return { result: { outcome: 'skipped', reason: 'no_address_resolved' }, patch: null };
      }

      return {
        result: { outcome: 'done' },
        patch: buildAddressPatch(placeName, outcome.components ?? null),
      };
    }

    if (outcome.retryable) {
      // OVER_QUERY_LIMIT, or a transport failure the service already caught.
      // FAILED, not skipped: the retry gate, the attempt budget and quarantine
      // only apply to failures, and a throttled provider must come back on its
      // own schedule rather than being written off as "nothing there".
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
      // silent no-op, and never a row that stays NULL and gets re-billed forever.
      return {
        result: { outcome: 'skipped', reason: permanent, detail: { cached: outcome.cached } },
        patch: null,
      };
    }

    // A status the provider abstraction did not previously produce. Failed, so it
    // retries a bounded number of times and then quarantines visibly, rather than
    // being classed as permanent on a guess.
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
   * The slice's fixes, in one statement.
   *
   * `time` comes back because it is half of `ci.position`'s `(time, user_id)`
   * primary key and the only cheap way to address a row for UPDATE — see
   * {@link writeAddresses}. lat/lng are projected out of the geography Point with
   * ST_Y/ST_X, exactly as `GeocodeBatchListener.selectReverseCandidates` does
   * (PostGIS stores [lng, lat], so the two are easy to transpose; keeping the
   * same spelling in both places keeps them wrong or right together).
   *
   * User-scoped even though the sweep already was: a slice can arrive from a dead
   * letter replayed weeks later, and re-scoping is the difference between "this
   * id is not yours" and geocoding — and billing — someone else's movements.
   *
   * PERFORMANCE: `ci.position.id` carries no index (see
   * `20260807071631_departition_position`), so this predicate scans every chunk.
   * The staleness sweep has the same problem, harder — it also `ORDER BY s.id`.
   * `CREATE INDEX position_id_idx ON ci.position (id)` is a prerequisite for
   * sweeping this stage over a real history; it is a migration and belongs with
   * the change that owns one.
   */
  private loadRows(userId: string, ids: string[]): Promise<CandidateRow[]> {
    return this.dataSource.query<CandidateRow[]>(
      `SELECT p.id,
              p.time,
              ST_Y(p.location::geometry) AS lat,
              ST_X(p.location::geometry) AS lng
         FROM ci.position p
        WHERE p.id = ANY($1::uuid[])
          AND p.user_id = $2::uuid
          AND p.location IS NOT NULL`,
      [ids, userId],
    );
  }

  /**
   * Write every resolved fix in ONE statement.
   *
   * `unnest()` over parallel arrays, one round trip per slice. The per-row
   * version of this pattern is why the communication-link backfill never finished
   * over a 22-year history, and `ci.position` is an order of magnitude larger
   * than that table.
   *
   * The row is addressed by its PRIMARY KEY (`time`, `user_id`) rather than by
   * `id`, plus `id` as a correctness check. That is not a micro-optimisation:
   * `ci.position` is a hypertable with ~300 monthly chunks and no index on `id`,
   * so keying on `id` alone would scan all of them. The `time BETWEEN` bound
   * spanning only the slice's own fixes is what lets TimescaleDB exclude every
   * chunk the slice does not touch. Ids are uuid v7, so a keyset sweep in id
   * order hands out roughly insertion-ordered slices and the bound is usually
   * tight; when it is not, it is merely wider, never wrong.
   *
   * Fixes older than the compression policy's 7 days live in compressed chunks.
   * TimescaleDB 2 (the appliance runs `timescaledb-2-postgresql-18`) handles DML
   * against them by decompressing the affected segments, which is correct but not
   * free — another reason the write is batched and time-bounded rather than
   * issued per row.
   *
   * Every one of the seven columns is assigned, including the NULLs: see the
   * class comment on why this overwrites instead of `COALESCE`-filling.
   */
  private async writeAddresses(
    userId: string,
    resolved: Map<string, AddressPatch>,
    byId: Map<string, CandidateRow>,
  ): Promise<void> {
    const entries = [...resolved.entries()];

    // Defensive: `new Date(value)` clones a Date and parses the ISO string the
    // driver hands back if `timestamptz` ever arrives unparsed.
    const times = entries.map(([id]) => new Date(byId.get(id)!.time));
    const epochs = times.map((time) => time.getTime());

    await this.dataSource.query(
      `UPDATE ci.position p
          SET address     = u.address,
              city        = u.city,
              region      = u.region,
              country     = u.country,
              postal_code = u.postal_code,
              name        = u.name,
              description = u.description
         FROM unnest($1::uuid[], $2::timestamptz[], $3::text[], $4::text[], $5::text[],
                     $6::text[], $7::text[], $8::text[], $9::text[])
              AS u(entity_id, fix_time, address, city, region, country, postal_code, name, description)
        WHERE p.id = u.entity_id
          AND p.time = u.fix_time
          AND p.user_id = $10::uuid
          AND p.time >= $11::timestamptz
          AND p.time <= $12::timestamptz`,
      [
        entries.map(([id]) => id),
        times,
        entries.map(([, patch]) => patch.address),
        entries.map(([, patch]) => patch.city),
        entries.map(([, patch]) => patch.region),
        entries.map(([, patch]) => patch.country),
        entries.map(([, patch]) => patch.postalCode),
        entries.map(([, patch]) => patch.name),
        entries.map(([, patch]) => patch.description),
        userId,
        new Date(Math.min(...epochs)),
        new Date(Math.max(...epochs)),
      ],
    );
  }
}

/**
 * The cache cell a coordinate falls in.
 *
 * DELIBERATELY IDENTICAL to the key `GeocodeService.reverseGeocode` builds
 * (`reverse:${lat.toFixed(4)},${lng.toFixed(4)}`, ~11 m). Two ids in the same
 * cell are guaranteed to hit the same cache row, which is what makes resolving
 * one of them and reusing the answer exact rather than approximate.
 *
 * The duplication is a real coupling and it is here on purpose rather than being
 * papered over: if that rounding changes, this must change with it or the
 * de-duplication silently becomes an approximation. Exporting the key builder
 * from `GeocodeService` is the correct fix and belongs with the change that owns
 * that file; until then this comment is the link between the two copies.
 */
export function cellKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

/**
 * Apply {@link ADDRESS_COMPONENT_RULE} to one provider result.
 *
 * `address` is the provider's whole formatted address; the other six are single
 * component reads, each NULL when the provider did not supply it. Partial results
 * are normal — a fix on a rural road has a country and nothing else — and a
 * partial fill is still `done`, because the provider answered.
 */
export function buildAddressPatch(
  placeName: string,
  components: Record<string, unknown> | null,
): AddressPatch {
  const list = (components as { address_components?: unknown } | null)?.address_components;
  const parsed: AddressComponent[] = Array.isArray(list) ? (list as AddressComponent[]) : [];

  const patch: AddressPatch = {
    address: placeName,
    city: null,
    region: null,
    country: null,
    postalCode: null,
    name: null,
    description: null,
  };

  for (const { column, componentTypes } of ADDRESS_COMPONENT_RULE) {
    for (const componentType of componentTypes) {
      const match = parsed.find(
        (component) =>
          Array.isArray(component.types) &&
          component.types.includes(componentType) &&
          typeof component.long_name === 'string' &&
          component.long_name.trim() !== '',
      );

      if (match != null) {
        patch[column] = match.long_name!.trim();
        break;
      }
    }
  }

  // `sublocality` can serve as the city fallback AND as the neighbourhood, so a
  // place with no `locality` would otherwise write the same string into two
  // columns and imply a hierarchy that is not there.
  if (patch.description != null && patch.description === patch.city) {
    patch.description = null;
  }

  return patch;
}
