import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { PIPELINE_QUEUES } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, type StageVersion } from '../../versions';

// Intra-domain, by path rather than through `../../index` — `no-intra-domain-via-barrel`
// in `.dependency-cruiser.mjs`. The import exists because an estimate COPIES a
// donor's coordinate, and the donor pool includes every event this stage's
// sibling geocoded; see {@link ESTIMATE_LOCATION_VERSION}.
import { FORWARD_GEOCODE_PROVIDER_GENERATION } from './GeocodeStage';

/**
 * This stage's id.
 *
 * Declared here ahead of its `STAGE_IDS` entry, exactly as `INDEX_EMBED_STAGE_ID`
 * and `ENRICH_POSITION_REVERSE_STAGE_ID` were; it becomes
 * `STAGE_IDS.ENRICH_ESTIMATE_LOCATION` in the change that lands the four central
 * entries, and `__tests__/stageWiring.spec.ts` fails by name until it does.
 *
 * IDS ARE PERMANENT — the id is the third component of `ci.pipeline_state`'s
 * primary key, so renaming it abandons every ledger row written under the old
 * name.
 */
export const ENRICH_ESTIMATE_LOCATION_STAGE_ID = 'enrich.estimate_location';

/** The ledger `entity_type` this stage records under. */
const ENTITY_TYPE = 'event';

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/**
 * `source_system`s eligible for temporal location estimation — events that
 * represent the user BEING somewhere.
 *
 * DUPLICATED from `DEFAULT_ESTIMATE_SOURCE_SYSTEMS` in
 * `domains/maintenance/services/LocationEstimateService.ts`, which the
 * maintenance barrel does not export (and reaching past a domain's `index.ts` is
 * a `no-cross-domain-internals` error). The duplication is deliberate and
 * short-lived: this stage replaces that service's sweep, the later phase that
 * deletes it deletes the other copy, and THIS list is the one the version guards.
 *
 * Messages and social posts are deliberately excluded: a post or an email carries
 * no inherent "where I was", so estimating its location would pollute the map and
 * the home/work clustering (a 3am email must not snap to yesterday's restaurant).
 * On the appliance this was written against that exclusion is most of the corpus
 * — 309,689 of 324,044 events are `google_voice`.
 *
 * Editing this list changes which rows are APPLICABLE, not what the stage
 * decides. Adding a system makes its rows candidates on the next sweep with no
 * bump needed; removing one leaves whatever estimates were already written in
 * place, because a row that is no longer applicable is a row the sweep no longer
 * offers. If that matters, the removal wants a companion clean-up, not a bump.
 */
export const ESTIMATE_SOURCE_SYSTEMS: readonly string[] = [
  'calendar',
  'apple_photos',
  'google_photos',
  'apple_health',
  'google_fit',
  'fitbit',
  'strava',
  'garmin',
  'withings',
  'uber',
  'lyft',
  'flighty',
  'amazon',
  'paypal',
  'venmo',
  'google_purchases',
  'google_maps_places',
  'google_location',
];

/**
 * How far in time a donor may be from the event it lends its coordinate to.
 *
 * A DECLARED CONSTANT, where `LocationEstimateService` takes it as a per-request
 * `maxGapHours` option (defaulting to 24). That is not a feature being removed,
 * it is the same lever moved somewhere it can be reasoned about: the gap is part
 * of the estimation RULE, so a request that quietly used 72 hours produced rows
 * indistinguishable from the ones produced at 24, and nothing recorded which. Now
 * widening the window is an edit here plus a bump of
 * {@link ESTIMATE_RULE_GENERATION}, which re-estimates the corpus under the new
 * window and stamps the version that produced each answer.
 *
 * The value still lands in `inference_sources.max_gap_hours` on every row, so an
 * individual estimate stays self-describing.
 */
export const ESTIMATE_MAX_GAP_HOURS = 24;

/**
 * Confidence written onto an estimated coordinate.
 *
 * Unchanged from `LocationEstimateService.ESTIMATED_CONFIDENCE`. An estimate is a
 * copy of somebody else's fix, so it must be discounted relative to a measured or
 * geocoded coordinate by HBPE, RAG and known-place clustering. It is also the
 * value `GeocodeService` calls `APPROXIMATE` — a coincidence, but a useful one:
 * 0.4 means "roughly, somewhere near here" throughout the appliance.
 */
export const ESTIMATED_CONFIDENCE = 0.4;

/**
 * `metadata.location_source` this stage writes, and the ONLY value whose
 * coordinates it will overwrite.
 *
 * Load-bearing twice over: it is the ownership marker (below) AND the donor-side
 * exclusion that stops an estimate being seeded from another estimate (see
 * {@link ESTIMATE_INVARIANT}).
 */
const LOCATION_SOURCE_ESTIMATED = 'estimated';

// ---------------------------------------------------------------------------
// The version, DERIVED rather than chosen
// ---------------------------------------------------------------------------

/**
 * Generation of THIS stage's estimation rule.
 *
 * Bump when the answer for an unchanged corpus changes: the donor preference
 * order, {@link ESTIMATE_MAX_GAP_HOURS}, {@link ESTIMATED_CONFIDENCE}, or the
 * decision about which coordinates may be overwritten. Not for a refactor of the
 * SQL that produces the same donor.
 */
export const ESTIMATE_RULE_GENERATION = 1;

/**
 * The stage version, derived from this stage's rule AND the forward-geocode
 * provider generation.
 *
 * The second term is the interesting one, and it is not decoration. An estimate
 * is a COPY of a donor's coordinate, and the donor pool is `ci.position` fixes
 * plus events with real coordinates — which, on a calendar-heavy corpus, are
 * overwhelmingly events `enrich.geocode` resolved. Improving the geocoder
 * therefore moves the coordinates this stage hands out, and an estimate copied
 * from a pre-improvement donor is stale in exactly the sense
 * `ci.pipeline_state.stage_version` exists to express. Deriving the version this
 * way means one bump of the geocode provider re-runs BOTH stages, in the right
 * order, with no operator remembering the dependency.
 *
 * The alternative — a hand-maintained integer — makes that dependency a fact
 * living only in someone's head, which is the class of mechanism this whole
 * subsystem was built to replace.
 *
 * A SUM (offset so that both-at-1 gives 1, because `versions.ts` refuses a
 * version below 1), so the version is monotone in each term and can only ever go
 * UP. `EmbedStage` explains at length why a hash would be dangerous here.
 */
export const ESTIMATE_LOCATION_VERSION = ESTIMATE_RULE_GENERATION + FORWARD_GEOCODE_PROVIDER_GENERATION - 1;

/**
 * The version this stage reports, cross-checked against `STAGE_VERSIONS`.
 *
 * Same shape, and same argument, as `geocodeStageVersion` and
 * `positionReverseStageVersion`: the derivation is the authority, the
 * `STAGE_VERSIONS` entry is its reviewable mirror, and a disagreement throws HERE
 * — where the fix is a one-line diff — rather than surfacing at the first sweep
 * as `StageRegistry` complaining about a hardcoded version, which is not what
 * happened.
 *
 * A missing entry is not an error: this file is imported by its own spec before
 * the `constants.ts` / `versions.ts` declarations land.
 */
export function estimateLocationStageVersion(
  versions: Record<string, StageVersion> = STAGE_VERSIONS,
): number {
  const declared = versions[ENRICH_ESTIMATE_LOCATION_STAGE_ID];

  if (typeof declared === 'number' && declared !== ESTIMATE_LOCATION_VERSION) {
    throw new Error(
      `STAGE_VERSIONS["${ENRICH_ESTIMATE_LOCATION_STAGE_ID}"] declares ${declared} but the stage derives ` +
        `${ESTIMATE_LOCATION_VERSION} from ESTIMATE_RULE_GENERATION (${ESTIMATE_RULE_GENERATION}) + ` +
        `FORWARD_GEOCODE_PROVIDER_GENERATION (${FORWARD_GEOCODE_PROVIDER_GENERATION}) - 1. Bumping a ` +
        `generation is only half the change: update versions.ts in the same commit, or the two disagree ` +
        `about what has already been written.`,
    );
  }

  return ESTIMATE_LOCATION_VERSION;
}

// At module load, for the reason `StageRegistry`'s completeness guard runs there:
// a generation bumped without the matching one-line diff to `versions.ts` is a
// programming error, and the earliest failure is the cheapest one.
estimateLocationStageVersion();

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Every source system, single-quoted for the applicability predicate.
 *
 * The predicate is interpolated VERBATIM into the staleness sweep (see
 * `StageSource.predicate`), so it must be a trusted in-repo literal. It is — the
 * list above is a hardcoded array — and this guard exists anyway, as the same
 * kind of tripwire `PipelineStateService.assertIdentifier` is: if a later change
 * ever computes this list from data, the failure is a legible throw at boot
 * rather than a syntactically valid sweep over the wrong rows.
 */
function quotedSourceSystems(systems: readonly string[] = ESTIMATE_SOURCE_SYSTEMS): string {
  for (const system of systems) {
    if (!/^[a-z0-9_]+$/.test(system)) {
      throw new Error(
        `ESTIMATE_SOURCE_SYSTEMS contains "${system}", which is not a plain [a-z0-9_] token. The list is ` +
          `interpolated verbatim into the staleness sweep's applicability predicate and must never carry ` +
          `anything that could change the shape of that query.`,
      );
    }
  }

  return systems.map((system) => `'${system}'`).join(', ');
}

/**
 * Where the sweep looks for candidates, and which of those rows this stage
 * APPLIES to.
 *
 * ── READ THIS BEFORE ADDING `s.location_coordinates IS NULL` ───────────────
 *
 * `LocationEstimateService.candidatePredicate` has it, and it is doing TWO jobs
 * that this conversion has to pull apart, because only one of them survives:
 *
 *  1. **Candidate selection** — "this row still needs an estimate". That is the
 *     ratchet. A row that got an estimate leaves the candidate set permanently,
 *     so a better donor pool, a wider window or a fixed donor preference could
 *     never repair one. The service's answer to that is the `forced` flag, a
 *     per-request boolean that relaxes the filter — a re-run lever that is not
 *     recorded anywhere, so nothing can say which rows were estimated under which
 *     rule. `stage_version` replaces it outright, and `forced` is deleted.
 *  2. **"Never overwrite a real coordinate"** — a genuine correctness rule, and
 *     it MUST NOT be lost with the filter that happened to carry it. It moves
 *     into the stage's own decision as `skipped: has_own_location` (see
 *     {@link decideLocally}), where it is recorded per row instead of being an
 *     invisible consequence of a WHERE clause.
 *
 * The same split applies to the service's `metadata->>'location_source' <>
 * 'estimated'` clause: on the CANDIDATE side it is job (1) and is deleted; on the
 * DONOR side it is {@link ESTIMATE_INVARIANT} and is kept verbatim.
 *
 * What remains here says only what a row IS:
 *
 *  - a live event (`is_deleted = false`) —
 *    applicability, not completion: estimating a tombstone's position is pure
 *    cost;
 *  - not a PREDICTION. `ci.events` carries a CHECK constraint
 *    (`valid_prediction_inference`: `NOT (is_predicted AND is_inferred)`) and the
 *    write below sets `is_inferred = true`, so one predicted row in a slice would
 *    violate the constraint and abort the ENTIRE statement, failing every other
 *    id with it. Predicted future events should not be retro-located anyway.
 *  - a physical-presence `source_system` — see {@link ESTIMATE_SOURCE_SYSTEMS}.
 *
 * ── What is NOT here, and why that is an improvement ───────────────────────
 *
 * The service additionally requires a donor to EXIST inside the gap, as two
 * correlated `EXISTS` subqueries, and its own comment explains why: it orders by
 * `start_time DESC` and takes a `LIMIT`, so without that clause a run of recent
 * donor-less events would fill every slot and permanently shadow older fillable
 * ones. That starvation cannot happen here — the sweep is a KEYSET over the whole
 * candidate set in id order, so every applicable row is offered exactly once per
 * sweep regardless of how many of its neighbours have donors. The donor lookup
 * therefore happens once, in the write, instead of twice per row in the
 * predicate; a candidate with no donor is recorded as `skipped:
 * no_donor_in_window` and becomes a number instead of a silence.
 *
 * (The predicate also cannot express it: it is spliced into the sweep as a bare
 * SQL clause with no bind parameters for the window, and
 * `StageRegistry.assertApplicabilityPredicate` rejects a predicate that aliases
 * `p.` — the alias `ci.position` conventionally uses — because that is how a
 * predicate reaches into the ledger.)
 */
export const ESTIMATE_LOCATION_SOURCE: StageSource = {
  schema: 'ci',
  table: 'events',
  idColumn: 'event_id',
  userColumn: 'user_id',
  predicate:
    `COALESCE(s.is_deleted, false) = false ` +
    `AND COALESCE(s.is_predicted, false) = false ` +
    `AND s.source_system IN (${quotedSourceSystems()})`,
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INVARIANT: AN ESTIMATE IS NEVER SEEDED FROM ANOTHER ESTIMATE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `LocationEstimateService` documents it in its class comment — *"estimated rows
 * are excluded as both candidates and donors … so re-runs never chain an estimate
 * off another estimate"* — and enforces it with
 * `COALESCE(n.metadata->>'location_source', '') <> 'estimated'` on the donor
 * subquery. That clause is COPIED VERBATIM into {@link writeEstimates} and this
 * constant is the reason it must never be dropped:
 *
 *  - **Error compounds and nothing records how far.** An estimate is already up
 *    to {@link ESTIMATE_MAX_GAP_HOURS} away from its donor in time, and a human
 *    can cross a continent in that window. Chaining lets a row be estimated from
 *    a row that was estimated from a row that was estimated — a random walk away
 *    from any measurement, with `confidence_score` pinned at 0.4 the whole way
 *    down, so nothing on the row says which link of the chain it is.
 *  - **It is order-dependent, so it is not reproducible.** Which estimate lands
 *    first depends on slice order, worker interleaving and sweep timing, so the
 *    same corpus swept twice would produce different maps. That is worse than
 *    being wrong.
 *
 * The service enforced it on BOTH sides (candidates and donors) and only the
 * donor side is the invariant. The candidate-side exclusion was the RATCHET —
 * see {@link ESTIMATE_LOCATION_SOURCE} — and this stage deliberately re-admits
 * previously-estimated rows as candidates, which is precisely what the service's
 * `forced` flag existed to do by hand. Re-estimating an estimate is fine and
 * intended: the row is recomputed FROM REAL DONORS, at the current rule. Chaining
 * one off another is not, and the donor clause is what keeps the two apart.
 */
export const ESTIMATE_INVARIANT =
  "donors must satisfy COALESCE(metadata->>'location_source', '') <> 'estimated'";

/** A slice row: identity, and everything {@link decideLocally} needs. */
interface CandidateRow {
  id: string;
  has_coordinates: boolean;
  location_source: string | null;
  is_deleted: boolean | null;
  is_predicted: boolean | null;
}

/** One row the write actually filled, as `RETURNING` hands it back. */
interface EstimatedRow {
  event_id: string;
  donor: string;
  donor_id: string | null;
  delta_seconds: number | string | null;
}

/**
 * Fills `ci.events.location_coordinates` from the nearest-in-time REAL location.
 *
 * LifeScope-style temporal estimation, converted onto the ledger: a
 * physical-presence event with no location of its own borrows the coordinate of
 * the closest `ci.position` GPS fix, or failing that the closest located event,
 * within a bounded window. The algorithm — donor preference, tie-break, window,
 * confidence, the rich `inference_sources` detail — is
 * `LocationEstimateService.estimateBatch`'s, unchanged. What changed is
 * everything around it.
 *
 * ── What this replaces ─────────────────────────────────────────────────────
 *
 * `LocationEstimateService` remains in place; a later phase retires it (and
 * `EstimateLocationBatchListener`, and `POST /api/maintenance/estimate-locations`
 * with its `forced` flag). The two differ in what "already estimated" means: the
 * service asks the row (`location_coordinates IS NULL`, plus
 * `location_source <> 'estimated'`), this asks `ci.pipeline_state` (this stage,
 * at this version, recorded an outcome). Three consequences:
 *
 *  - `forced` disappears. It was a request-scoped "pretend the filter isn't
 *    there" flag whose effect nothing recorded; a version bump does the same job,
 *    on the record, for every row.
 *  - `limit` and `maxGapHours` disappear as request parameters. Slice size is the
 *    pipeline's, and the window is a declared constant folded into the version.
 *  - A row with no donor is no longer invisible. The service counts candidates
 *    and counts rows filled and the difference is a number with no ids attached;
 *    here each unfilled row carries `skipped: no_donor_in_window`.
 *
 * ── Outcomes ───────────────────────────────────────────────────────────────
 *
 * There is no external provider on this stage, so the transient/permanent split
 * lands differently from its geo siblings — but it lands in the same place:
 *
 *  - `no_donor_in_window` — nothing real within {@link ESTIMATE_MAX_GAP_HOURS}.
 *    SKIPPED, the counterpart of a geocoder's `ZERO_RESULTS`: an answer, not a
 *    failure, and one that will not change until the corpus does. **A wave of
 *    newly-imported GPS positions does not re-open these rows by itself** — that
 *    is what a version bump is for, and it is the honest replacement for
 *    `forced`. Keying the version off a donor-corpus watermark instead would
 *    re-open them automatically; it is speculative, and not built.
 *  - `has_own_location` — the row already has a real (non-estimated) coordinate.
 *    Skipped, and the surviving half of `location_coordinates IS NULL`.
 *  - `estimate_write_failed` — the one statement did not commit. FAILED, so the
 *    retry gate and the attempt budget apply: a locked table or a dead connection
 *    reads as a failure count going UP rather than a coverage number that quietly
 *    stops climbing.
 *  - `source_row_missing` / `event_deleted` / `predicted_event` — skips: nothing
 *    to retry, and each says which.
 */
@Injectable()
export class EstimateLocationStage implements Stage {
  readonly id = ENRICH_ESTIMATE_LOCATION_STAGE_ID;

  /**
   * The DERIVED version — see {@link estimateLocationStageVersion}. Resolved ONCE,
   * at construction: a getter would let the version move under a slice that is
   * mid-flight, so ids claimed at version 1 and completed at version 2 would never
   * be re-processed by the improvement that bump was for.
   */
  readonly version = estimateLocationStageVersion();

  /**
   * `pipeline-enrich`, not `pipeline-index`, even though every byte this stage
   * touches is in Postgres.
   *
   * The queues split by RESOURCE CLASS, and the resource here is a correlated
   * nearest-neighbour search per candidate over `ci.position` — a hypertable that
   * is the largest on the appliance. That is a slow, bursty query, and
   * `pipeline-index` is documented as the cheap high-throughput lane that also
   * carries the pipeline's OWN housekeeping (sweeps, dead-letter reaps). Parking
   * a full-corpus estimation there would let it starve the machinery that
   * dispatches everything else.
   */
  readonly queue = PIPELINE_QUEUES.ENRICH;

  readonly entityTypes = [ENTITY_TYPE] as const;

  readonly source = ESTIMATE_LOCATION_SOURCE;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EstimateLocationStage.name);
  }

  /**
   * Estimate one slice of events.
   *
   * Idempotent, as the stage contract requires: the donor lookup is a pure
   * function of the corpus, so two dispatchers racing the same id write the same
   * coordinate twice.
   *
   * Two round trips for a 200-id slice: one SELECT to decide what must not be
   * touched, and ONE set-based UPDATE that finds each remaining row's donor and
   * writes it. The per-row version of this pattern is why the communication-link
   * backfill never finished over a 22-year history.
   */
  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    const rows = await this.loadRows(ctx.userId, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Answer for the ids that came back with no row FIRST, so the map is complete
    // even if the write throws in a way this does not model.
    // `PipelineSliceListener` records anything missing as
    // `failed: stage_returned_no_result`, which is correct but uninformative.
    for (const id of ids) {
      if (!byId.has(id)) {
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    const estimable: string[] = [];

    for (const row of rows) {
      const local = this.decideLocally(row);

      if (local != null) {
        results.set(row.id, local);

        continue;
      }

      estimable.push(row.id);
    }

    if (estimable.length === 0) {
      return results;
    }

    let filled: EstimatedRow[];

    try {
      filled = await this.writeEstimates(ctx.userId, estimable);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // One statement means one outcome: it committed or it did not, so every row
      // in it shares the verdict. Attributing the failure to one id would be a
      // guess, and a guess is what the reason column exists to replace.
      for (const id of estimable) {
        results.set(id, { outcome: 'failed', reason: 'estimate_write_failed', detail: { message } });
      }

      this.logger.error(
        `Location estimation failed for ${estimable.length} events`,
        err instanceof Error ? err : new Error(message),
      );

      return results;
    }

    const filledById = new Map(filled.map((row) => [row.event_id, row]));

    for (const id of estimable) {
      const row = filledById.get(id);

      if (row == null) {
        // Not returned by the UPDATE, so the LATERAL found no donor inside the
        // window. (It also covers a row that flipped to `is_predicted` between the
        // load and the write, which the statement's own guard excludes — rare
        // enough that a shared reason is better than a second round trip to tell
        // the two apart.)
        results.set(id, { outcome: 'skipped', reason: 'no_donor_in_window' });

        continue;
      }

      results.set(id, {
        outcome: 'done',
        // A real, honestly-low number rather than a fabricated one: an estimate is
        // a copy of a neighbour's fix and must never outrank a measurement. See
        // `StageResult.confidence` on why inventing a value here would be the one
        // way to make a worse answer permanently destroy a better one.
        confidence: ESTIMATED_CONFIDENCE,
        detail: {
          donor: row.donor,
          donorId: row.donor_id,
          deltaSeconds: row.delta_seconds == null ? null : Number(row.delta_seconds),
        },
      });
    }

    return results;
  }

  /**
   * Everything that can be decided without looking for a donor.
   *
   * Returns a terminal result, or `null` when the row should be estimated.
   */
  private decideLocally(row: CandidateRow): StageResult | null {
    if (row.is_deleted === true) {
      // Soft-deleted between the sweep and the slice. Distinct from
      // `source_row_missing` because the row is still there.
      return { outcome: 'skipped', reason: 'event_deleted' };
    }

    if (row.is_predicted === true) {
      // The applicability predicate excludes these, so this is a mid-flight flip
      // or a replayed dead letter carrying stale ids. Skipped rather than written:
      // `is_inferred = true` on a predicted row violates `valid_prediction_inference`
      // and would abort the whole slice's statement.
      return { outcome: 'skipped', reason: 'predicted_event' };
    }

    if (row.has_coordinates && row.location_source !== LOCATION_SOURCE_ESTIMATED) {
      // THE SURVIVING HALF of `location_coordinates IS NULL`. The row has a real
      // location — measured, imported, or geocoded from its own text — and an
      // estimate is strictly weaker than all three. Never overwrite it; record
      // that we looked.
      //
      // A row whose coordinates ARE an estimate falls through and is recomputed
      // from real donors at the current rule, which is what the service's `forced`
      // flag existed to do by hand.
      return {
        outcome: 'skipped',
        reason: 'has_own_location',
        detail: { locationSource: row.location_source },
      };
    }

    return null;
  }

  /**
   * The slice's rows, in one statement.
   *
   * Raw SQL rather than `EventService`, for the reason `EmbedStage` gives about
   * `ContentService`: the columns wanted are a strict subset of ~40, and going
   * through the memory domain's barrel from inside `domains/pipeline` would couple
   * the pipeline's module graph to it for a projection.
   *
   * User-scoped even though the sweep already was: a slice can arrive from a dead
   * letter replayed weeks later, and re-scoping is the difference between "this id
   * is not yours" and writing someone else's whereabouts onto this user's event.
   */
  private loadRows(userId: string, ids: string[]): Promise<CandidateRow[]> {
    return this.dataSource.query<CandidateRow[]>(
      `SELECT e.event_id AS id,
              (e.location_coordinates IS NOT NULL) AS has_coordinates,
              e.metadata->>'location_source' AS location_source,
              e.is_deleted,
              e.is_predicted
         FROM ci.events e
        WHERE e.event_id = ANY($1::uuid[])
          AND e.user_id = $2::uuid`,
      [ids, userId],
    );
  }

  /**
   * Find each candidate's donor and write the estimate — ONE statement.
   *
   * The body is `LocationEstimateService.estimateBatch`'s, with its `candidate`
   * CTE (a `start_time DESC` page under a `LIMIT`) replaced by the slice's own
   * ids. That substitution is the conversion in miniature: the service had to
   * choose an ORDER and a LIMIT because it was its own scheduler, and this does
   * not because the sweep already paged the corpus by keyset.
   *
   * Returns the rows it actually filled. Everything else the caller asked for had
   * no donor — which is why `RETURNING` carries the donor detail rather than the
   * statement being fire-and-forget.
   *
   * ── Why the UPDATE is wrapped in a CTE ─────────────────────────────────────
   *
   * `WITH updated AS (UPDATE … RETURNING …) SELECT * FROM updated`, not a bare
   * `UPDATE … RETURNING`, and the reason is a TypeORM behaviour that is invisible
   * until it silently inverts this stage's output. `DataSource.query()` returns
   * the driver's rows for a SELECT and for an `INSERT … RETURNING` (which is what
   * `PipelineStateService` uses, hence its immunity), but for an
   * `UPDATE … RETURNING` it returns the PAIR `[rows, rowCount]`. Measured against
   * the dev database, TypeORM 0.3:
   *
   * ```text
   * UPDATE … RETURNING   => [[{event_id: …}], 1]
   * WITH … SELECT        =>  [{event_id: …}]
   * INSERT … RETURNING   =>  [{event_id: …}]
   * ```
   *
   * The bare form therefore hands this method an array whose first element is an
   * ARRAY of rows and whose second is a number, so `filledById` is keyed on
   * `undefined`, no candidate is ever found in it, and EVERY row this statement
   * successfully filled is reported to the ledger as
   * `skipped: no_donor_in_window`. Nothing throws, the coordinates are written,
   * and the ledger says the opposite of what happened — the precise class of
   * silent disagreement this subsystem exists to delete. Wrapping the statement
   * makes the command a SELECT and the return shape a plain row array.
   *
   * Points of the donor query worth keeping intact:
   *
   *  - **Each UNION branch is parenthesized** so its `ORDER BY` / `LIMIT` binds to
   *    that branch rather than to the whole union. Without the parentheses the
   *    query still runs and quietly returns the wrong donor.
   *  - **Nearest-in-time wins; a GPS fix only breaks a TIE.** `ORDER BY
   *    delta_seconds ASC, (donor <> 'position')` — do NOT promote a distant
   *    position fix over a temporally closer located event just because it is more
   *    precise. Precision about the wrong hour is not precision.
   *  - **The donor window is a sargable `BETWEEN`**, not `abs(...) < x`, so the
   *    planner can use the `(user_id, time)` and `(user_id, start_time)` indexes —
   *    and, on `ci.position`, exclude every hypertable chunk outside the window.
   *  - **{@link ESTIMATE_INVARIANT}** — the `<> 'estimated'` clause on the event
   *    donor branch. Read that constant before touching this statement.
   */
  private async writeEstimates(userId: string, ids: string[]): Promise<EstimatedRow[]> {
    const maxGapSeconds = Math.round(ESTIMATE_MAX_GAP_HOURS * 3600);

    return this.dataSource.query<EstimatedRow[]>(
      `WITH estimated AS (
        UPDATE ci.events tgt
          SET location_coordinates = d.coords,
              is_inferred          = true,
              confidence_score     = LEAST(COALESCE(tgt.confidence_score, 1.0), $4::float8),
              metadata             = COALESCE(tgt.metadata, '{}'::jsonb)
                                     || jsonb_build_object('location_source', $5::text),
              inference_sources    = jsonb_build_object(
                                       'method', 'temporal_nn',
                                       'donor', d.donor,
                                       'donor_id', d.donor_id,
                                       'delta_seconds', round(d.delta_seconds)::int,
                                       'accuracy_meters', d.accuracy_meters,
                                       'max_gap_hours', $6::numeric
                                     ),
              updated_at           = now()
         FROM (
                SELECT e.event_id, e.start_time
                  FROM ci.events e
                 WHERE e.event_id = ANY($1::uuid[])
                   AND e.user_id = $2::uuid
              ) c
         CROSS JOIN LATERAL (
           SELECT coords, donor, donor_id, delta_seconds, accuracy_meters
             FROM (
               (
                 SELECT p.location AS coords, 'position' AS donor, p.id::text AS donor_id,
                        abs(extract(epoch FROM (p.time - c.start_time))) AS delta_seconds,
                        p.accuracy_meters AS accuracy_meters
                   FROM ci.position p
                  WHERE p.user_id = $2::uuid
                    AND p.location IS NOT NULL
                    AND p.time BETWEEN c.start_time - make_interval(secs => $3::float8)
                                   AND c.start_time + make_interval(secs => $3::float8)
                  ORDER BY abs(extract(epoch FROM (p.time - c.start_time))) ASC
                  LIMIT 1
               )
               UNION ALL
               (
                 SELECT n.location_coordinates AS coords, 'event' AS donor, n.event_id::text AS donor_id,
                        abs(extract(epoch FROM (n.start_time - c.start_time))) AS delta_seconds,
                        NULL::double precision AS accuracy_meters
                   FROM ci.events n
                  WHERE n.user_id = $2::uuid
                    AND n.location_coordinates IS NOT NULL
                    AND n.event_id <> c.event_id
                    AND n.is_deleted = false
                    AND COALESCE(n.metadata->>'location_source', '') <> $5::text
                    AND n.start_time BETWEEN c.start_time - make_interval(secs => $3::float8)
                                         AND c.start_time + make_interval(secs => $3::float8)
                  ORDER BY abs(extract(epoch FROM (n.start_time - c.start_time))) ASC
                  LIMIT 1
               )
             ) donors
            ORDER BY delta_seconds ASC, (donor <> 'position')
            LIMIT 1
         ) d
        WHERE tgt.event_id = c.event_id
          AND COALESCE(tgt.is_predicted, false) = false
       RETURNING tgt.event_id,
                 d.donor,
                 d.donor_id,
                 round(d.delta_seconds)::int AS delta_seconds
       )
       SELECT event_id, donor, donor_id, delta_seconds FROM estimated`,
      [ids, userId, maxGapSeconds, ESTIMATED_CONFIDENCE, LOCATION_SOURCE_ESTIMATED, ESTIMATE_MAX_GAP_HOURS],
    );
  }
}
