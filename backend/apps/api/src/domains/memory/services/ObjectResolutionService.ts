import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ObjectIdentifierService } from '@ci/domains/graph/services/ObjectIdentifierService';
import type { ObjectIdentifierNamespace } from '@ci/domains/graph/utils/normalizeObjectIdentifier';

import type { ObjectObservation, ObservationResolutionMethod } from '../entities/ObjectObservationEntity';

import { ObjectObservationService } from './ObjectObservationService';

/**
 * Confidence declared by each rung of the ladder.
 *
 * DECLARED, not measured — except `embedding`, which reports the cosine
 * similarity it actually computed. The distinction matters: a fabricated
 * measurement teaches every downstream consumer to prefer a worse answer over a
 * better one, so a rung that cannot measure states a fixed tier instead and the
 * number is versioned with the rule that produced it.
 *
 *  - `identifier` 0.95 — a barcode or serial read off the thing. Not 1.0: the
 *    code was read by a machine from pixels, and 1.0 is reserved for a human
 *    saying so ({@link ObjectObservationService.confirm}).
 *  - `place_prior` 0.6  — the only unit of that kind known to be at this place.
 *    Real evidence, but circumstantial.
 *  - `label`      0.45 — the only unit whose name matches the detector's word.
 *    Deliberately below every auto-apply threshold anyone would set: it is a
 *    suggestion for a human, not a decision.
 */
export const IDENTIFIER_CONFIDENCE = 0.95;
export const PLACE_PRIOR_CONFIDENCE = 0.6;
export const LABEL_CONFIDENCE = 0.45;

/**
 * Cosine DISTANCE ceiling for the embedding rung, matching `SearchService`'s
 * semantic floor.
 *
 * Distance, not similarity, because that is the form the HNSW index accelerates
 * — see the ORDER BY note in {@link buildEmbeddingQuery}. A distance of 0.5 is a
 * similarity of 0.5; above it the "nearest" neighbour in a sparse index is
 * noise, and returning it as a 0.3-confidence match would still pollute the
 * review queue with pairs no human would consider.
 */
export const EMBEDDING_DISTANCE_FLOOR = 0.5;

/**
 * Minimum confidence at which a resolution is written WITHOUT a human.
 *
 * Above it, {@link ObjectResolutionService.resolveAndApply} records the link;
 * below it the candidate is returned for review and the observation stays
 * unresolved. 0.8 admits the identifier rung and a strong embedding match, and
 * excludes both circumstantial rungs — which is the intended shape: a place
 * prior or a bare label is a suggestion.
 */
export const AUTO_RESOLVE_CONFIDENCE_THRESHOLD = 0.8;

/** Attribute keys a sighting may carry a scanned code under. */
const IDENTIFIER_ATTRIBUTE_KEYS = ['identifier_codes', 'identifierCodes', 'codes'] as const;

/** A single-value attribute key holding an unknown-kind scan. */
const SCAN_ATTRIBUTE_KEYS = ['barcode', 'scan', 'qr'] as const;

/** Which key means which namespace, when the sighting says. */
const CODE_KEY_NAMESPACES: Readonly<Record<string, ObjectIdentifierNamespace>> = {
  gtin: 'gtin',
  upc: 'gtin',
  ean: 'gtin',
  isbn: 'isbn',
  asin: 'asin',
  mpn: 'mpn',
  sku: 'sku',
  serial: 'serial',
  imei: 'imei',
  vin: 'vin',
};

/** What the ladder concluded about one sighting. */
export interface ObjectResolutionCandidate {
  observationId: string;
  /** Which rung fired. `'none'` when nothing did. */
  method: ObservationResolutionMethod;
  confidence: number | null;
  objectId: string | null;
  productId: string | null;
  /** Why, in one line, for the review UI and the logs. */
  reason: string;
}

/** A candidate plus what was done with it. */
export interface ObjectResolutionOutcome extends ObjectResolutionCandidate {
  /** True when the resolution was written to the observation. */
  applied: boolean;
  observation: ObjectObservation | null;
}

export interface ResolveOptions {
  /** Confidence at or above which the resolution is written. Defaults to {@link AUTO_RESOLVE_CONFIDENCE_THRESHOLD}. */
  threshold?: number;
}

/**
 * Matches a SIGHTING to an owned unit — the missing half of the object-identity
 * loop `ObjectObservationService` documents as "does not exist yet".
 *
 * ── The ladder ─────────────────────────────────────────────────────────────
 *
 * Strictly ordered, first match wins, and the rung that fired is recorded in
 * the observation's `resolution_method` so the answer is always auditable back
 * to the evidence that produced it:
 *
 *   identifier -> embedding -> place_prior -> label -> none
 *
 * The order is by kind of evidence, not by convenience. A barcode IDENTIFIES;
 * an embedding says two images look alike; a place says the thing is where the
 * thing usually is; a label says the words match. Running them in any other
 * order would let a weak rung answer a question a strong one could have
 * answered correctly.
 *
 * ── What it never does ─────────────────────────────────────────────────────
 *
 * It never CREATES a `ci.objects` row from a sighting. That was the retired
 * inventory listener's behaviour and it is precisely what
 * `ci.object_observations` was introduced to stop: a vision guess is evidence
 * that an object was VISIBLE, never evidence that it is OWNED, and writing one
 * puts every object that ever appeared in frame into the user's possessions.
 * Minting has two legitimate triggers, neither of them inference: a purchase
 * ({@link ObjectMintService}) and a user who explicitly said "these are my
 * things" on the upload (`ThingVisionListener`, which asks this ladder FIRST
 * and mints only what it declines to match). The auto-apply threshold below
 * therefore gates the only automatic write there is: linking a sighting to a
 * unit that already exists.
 *
 * It also never sets `confirmed_by_user`, and never overwrites a resolution a
 * human confirmed — both guarantees come from routing every write through
 * {@link ObjectObservationService.resolve}, which refuses `'user'` outright.
 */
@Injectable()
export class ObjectResolutionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly observationService: ObjectObservationService,
    private readonly objectIdentifierService: ObjectIdentifierService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ObjectResolutionService.name);
  }

  /**
   * Run the ladder for one sighting WITHOUT writing anything.
   *
   * Separate from {@link resolveAndApply} so a review UI can show what the
   * resolver would do, and so the rungs are testable without a write path.
   */
  async resolve(
    context: UserServiceContext,
    observation: ObjectObservation,
  ): Promise<ObjectResolutionCandidate> {
    const none = (reason: string): ObjectResolutionCandidate => ({
      observationId: observation.id,
      method: 'none',
      confidence: null,
      objectId: null,
      productId: null,
      reason,
    });

    return (
      (await this.byIdentifier(context, observation)) ??
      (await this.byEmbedding(context, observation)) ??
      (await this.byPlacePrior(context, observation)) ??
      (await this.byLabel(context, observation)) ??
      none('no rung matched')
    );
  }

  /**
   * Run the ladder and WRITE the result when it clears the threshold.
   *
   * A below-threshold candidate is returned unapplied rather than written at
   * low confidence: an unresolved observation is a question, while a wrong
   * resolution is an answer, and a wrong answer costs more to undo than a
   * question costs to leave open.
   */
  async resolveAndApply(
    context: UserServiceContext,
    observationId: string,
    options: ResolveOptions = {},
  ): Promise<ObjectResolutionOutcome | null> {
    const observation = await this.observationService.findById(context, observationId);

    if (observation == null) {
      return null;
    }

    if (observation.confirmedByUser || observation.resolutionMethod === 'user') {
      // A human's answer is not a machine's to revise. Reported, not thrown, so
      // a sweep skips it instead of aborting. Method `user` without the flag is
      // a "no" (`rejectObservation`, which also clears the link) or a
      // retraction that kept its link (`confirm(id, false)`). Both are answers.
      const unlinked = observation.resolvedObjectId == null && observation.resolvedProductId == null;

      return {
        observationId,
        method: observation.resolutionMethod,
        confidence: observation.resolutionConfidence,
        objectId: observation.resolvedObjectId,
        productId: observation.resolvedProductId,
        reason: observation.confirmedByUser
          ? 'user-confirmed; left untouched'
          : unlinked
            ? 'user-rejected; left untouched'
            : 'user-retracted; left untouched',
        applied: false,
        observation,
      };
    }

    const candidate = await this.resolve(context, observation);
    const threshold = options.threshold ?? AUTO_RESOLVE_CONFIDENCE_THRESHOLD;
    const applied = candidate.method !== 'none' && (candidate.confidence ?? 0) >= threshold;

    if (!applied) {
      return { ...candidate, applied: false, observation };
    }

    const updated = await this.observationService.resolve(context, observationId, {
      resolvedObjectId: candidate.objectId,
      resolvedProductId: candidate.productId,
      // 'user' is unreachable here — the ladder never produces it, and
      // ObjectObservationService.resolve rejects it anyway.
      resolutionMethod: candidate.method as Exclude<ObservationResolutionMethod, 'user'>,
      resolutionConfidence: candidate.confidence,
    });

    if (candidate.objectId != null) {
      await this.touchLastSeen(context, candidate.objectId, observation);
    }

    return { ...candidate, applied: true, observation: updated };
  }

  /**
   * Sweep the review queue: unresolved, unconfirmed sightings, newest first.
   *
   * Returns every outcome, applied or not, so the caller can report both the
   * links it made and the queue it left behind.
   */
  async resolveUnresolved(
    context: UserServiceContext,
    options: ResolveOptions & { limit?: number } = {},
  ): Promise<ObjectResolutionOutcome[]> {
    const pending = await this.observationService.findForReview(context, options.limit ?? 100);
    const outcomes: ObjectResolutionOutcome[] = [];

    for (const observation of pending) {
      const outcome = await this.resolveAndApply(context, observation.id, options);

      if (outcome != null) {
        outcomes.push(outcome);
      }
    }

    return outcomes;
  }

  // -------------------------------------------------------------------------
  // Rung 1 — identifier
  // -------------------------------------------------------------------------

  /**
   * A code read off the object itself.
   *
   * Every value goes through `ObjectIdentifierService`, never a local
   * uppercase-and-compare: a value normalized by a second rule is a claim that
   * can never be found again, and GTIN padding / ISBN-10 upconversion / IMEI
   * Luhn are exactly the parts a second implementation gets wrong.
   *
   * A claim held by a product MODEL resolves to a unit only when the user owns
   * exactly ONE live unit of that model. Two units of the same model are
   * indistinguishable by their shared barcode — that is what a serial is for —
   * so the product is reported and the object is left null rather than picking
   * one at random.
   */
  private async byIdentifier(
    context: UserServiceContext,
    observation: ObjectObservation,
  ): Promise<ObjectResolutionCandidate | null> {
    for (const { namespace, value } of this.codesOf(observation)) {
      const match =
        namespace == null
          ? await this.objectIdentifierService.resolveScan(context.userId, value)
          : await this.objectIdentifierService.resolve(context.userId, namespace, value);

      if (match == null) {
        continue;
      }

      if (match.subjectType === 'object_instance') {
        return {
          observationId: observation.id,
          method: 'identifier',
          confidence: IDENTIFIER_CONFIDENCE,
          objectId: match.subjectId,
          productId: null,
          reason: `identifier ${match.namespace}:${match.valueNormalized} claimed by this unit`,
        };
      }

      const units = await this.dataSource.query<Array<{ object_id: string }>>(
        `SELECT object_id
           FROM ci.objects
          WHERE user_id = $1::uuid
            AND product_id = $2::uuid
            AND merged_into_object_id IS NULL
          LIMIT 2`,
        [context.userId, match.subjectId],
      );

      return {
        observationId: observation.id,
        method: 'identifier',
        confidence: IDENTIFIER_CONFIDENCE,
        objectId: units.length === 1 ? units[0].object_id : null,
        productId: match.subjectId,
        reason:
          units.length === 1
            ? `identifier ${match.namespace}:${match.valueNormalized} names the only owned unit of this model`
            : `identifier ${match.namespace}:${match.valueNormalized} names the model; ${units.length === 0 ? 'no' : 'several'} owned units match`,
      };
    }

    return null;
  }

  /** Every code the sighting carries, in the order they should be tried. */
  private codesOf(
    observation: ObjectObservation,
  ): Array<{ namespace: ObjectIdentifierNamespace | null; value: string }> {
    const out: Array<{ namespace: ObjectIdentifierNamespace | null; value: string }> = [];
    const attributes = observation.attributes ?? {};

    for (const key of IDENTIFIER_ATTRIBUTE_KEYS) {
      const bag = attributes[key];

      if (bag == null || typeof bag !== 'object' || Array.isArray(bag)) {
        continue;
      }

      for (const [codeKey, codeValue] of Object.entries(bag as Record<string, unknown>)) {
        const namespace = CODE_KEY_NAMESPACES[codeKey.trim().toLowerCase()];

        if (namespace != null && codeValue != null && String(codeValue).trim() !== '') {
          out.push({ namespace, value: String(codeValue) });
        }
      }
    }

    for (const key of SCAN_ATTRIBUTE_KEYS) {
      const value = attributes[key];

      if (typeof value === 'string' && value.trim() !== '') {
        // Namespace unknown — detectObjectIdentifier reads it from the value's
        // own grammar, which only works for the globally-unique namespaces.
        out.push({ namespace: null, value });
      }
    }

    return out;
  }

  // -------------------------------------------------------------------------
  // Rung 2 — embedding
  // -------------------------------------------------------------------------

  /**
   * Nearest owned unit in vector space.
   *
   * The query vector is the OBSERVATION's own `embedding` column — `vector(768)`
   * and deliberately unmapped by the entity, so it is read in SQL and never
   * dragged through an ordinary find. A sighting without one simply skips this
   * rung; that is the common case until the CV pass embeds crops.
   *
   * Confidence IS the cosine similarity, the one rung that reports a measured
   * number rather than a declared tier.
   */
  private async byEmbedding(
    context: UserServiceContext,
    observation: ObjectObservation,
  ): Promise<ObjectResolutionCandidate | null> {
    const rows = await this.dataSource.query<Array<{ object_id: string; score: string }>>(
      this.buildEmbeddingQuery(),
      [context.userId, observation.id, EMBEDDING_DISTANCE_FLOOR],
    );

    const best = rows[0];

    if (best == null) {
      return null;
    }

    const score = Number(best.score);

    return {
      observationId: observation.id,
      method: 'embedding',
      confidence: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : null,
      objectId: best.object_id,
      productId: null,
      reason: `nearest owned unit in vector space (cosine ${score.toFixed(3)})`,
    };
  }

  /**
   * The nearest-neighbour statement, in the ONE shape an HNSW index can serve.
   *
   * Two rules, and both were broken before — the second silently, because the
   * SQL looked right.
   *
   * ── 1. ORDER BY the raw distance operator ASCENDING ────────────────────────
   *
   * Not `1 - (a <=> b) DESC`. HNSW only accelerates `ORDER BY col <=> const ASC
   * LIMIT k`; ordering by the derived score is mathematically identical and
   * opaque to the planner. Same finding as `SearchService.semanticSearch`.
   *
   * `<=>` (cosine), never `<->` (L2): these embeddings are unnormalised, so L2
   * distance is not a similarity and `1 - L2` produces large negative "scores".
   *
   * ── 2. The probe must be a PSEUDOCONSTANT, not a joined column ─────────────
   *
   * This is the half the previous version got wrong. It read the probe through
   * `WITH probe AS (…) … JOIN probe ON TRUE`, which makes `probe.embedding` an
   * ordinary column of a joined relation. `col <=> other_relation.col` is not
   * an indexable order-by expression at all, so no HNSW index could be used no
   * matter which ones existed — the docblock claimed acceleration the plan
   * never had. Measured on a dev corpus of 1.28M embeddings (2,006 of them
   * `item`):
   *
   *     Limit -> Sort -> Nested Loop -> … Index Scan using
   *     embeddings_entity_type_entity_id_key            129.8 ms
   *
   * `resolveUnresolved` runs this once per observation, up to 100 per sweep.
   *
   * As a scalar subquery the planner folds it to an InitPlan — evaluated once,
   * then a constant — and the ORDER BY becomes indexable. With
   * `embeddings_item_embedding_hnsw_idx` (migration
   * `20260819173813_add_item_embedding_hnsw_index.sql`, scoped to
   * `entity_type = 'item'` so the walk never wades through the 99.8% of the
   * corpus this rung can never match) the same query plans and runs as:
   *
   *     Limit -> Nested Loop -> Index Scan using embeddings_item_embedding_hnsw_idx
   *       Order By: (embedding <=> (InitPlan 1).col1)     0.78 ms
   *
   * Both halves are load-bearing: with the index present but the old joined
   * probe, the plan is still `Sort`.
   *
   * ── Why the distance floor moved outside ───────────────────────────────────
   *
   * As a WHERE predicate on the ANN scan it is a post-filter the planner cannot
   * push into the index, and it made the old plan's `Nested Loop` compute every
   * distance anyway. The inner query asks the index for the single nearest live
   * unit; the outer `WHERE` then decides whether that one is near ENOUGH. Same
   * answer, one distance comparison instead of N.
   *
   * The join back to `ci.objects` is what keeps a TOMBSTONE from answering: a
   * merged-away unit keeps its embedding until the merge deletes it, and a
   * resolver that matched one would re-create the duplicate the merge removed.
   * It sits INSIDE the limit, so the index keeps yielding neighbours until one
   * is live rather than the query returning nothing.
   */
  private buildEmbeddingQuery(): string {
    // Repeated verbatim in the SELECT list and the ORDER BY. Postgres folds the
    // two identical uncorrelated subqueries into one InitPlan; writing it once
    // in a CTE is what broke this in the first place.
    const probe =
      '(SELECT o.embedding FROM ci.object_observations o ' +
      'WHERE o.observation_id = $2::uuid AND o.user_id = $1::uuid AND o.embedding IS NOT NULL)';

    return `
      SELECT nearest.object_id, 1 - nearest.distance AS score
        FROM (
          SELECT e.entity_id AS object_id,
                 e.embedding <=> ${probe} AS distance
            FROM ci_search.embeddings e
            JOIN ci.objects inv
              ON inv.object_id = e.entity_id
             AND inv.merged_into_object_id IS NULL
           WHERE e.user_id = $1::uuid
             AND e.entity_type = 'item'
             AND e.embedding IS NOT NULL
           ORDER BY e.embedding <=> ${probe}
           LIMIT 1
        ) nearest
       WHERE nearest.distance < $3::double precision
    `;
  }

  // -------------------------------------------------------------------------
  // Rung 3 — place prior
  // -------------------------------------------------------------------------

  /**
   * The only unit of that kind known to be at this place.
   *
   * The migration calls this the strongest prior an image-based resolver has,
   * and the asymmetry is the point: a "mug" at home resolves against a small
   * set of things known to be there; the same label in a cafe resolves against
   * nothing and correctly stays an unresolved observation.
   *
   * "Known to be there" is two things — a confirmed last sighting
   * (`last_seen_place_entity_id`) or a purchase made there (the mint provenance
   * bag, since `ci.objects` has no acquisition-place column). AMBIGUITY IS
   * NOT A MATCH: two candidates mean the place told us nothing that separates
   * them, so the rung declines rather than guessing.
   */
  private async byPlacePrior(
    context: UserServiceContext,
    observation: ObjectObservation,
  ): Promise<ObjectResolutionCandidate | null> {
    if (observation.placeEntityId == null) {
      return null;
    }

    const label = observation.label.trim().toLowerCase();

    if (label === '') {
      return null;
    }

    const rows = await this.dataSource.query<Array<{ object_id: string }>>(
      `SELECT inv.object_id
         FROM ci.objects inv
         JOIN ci.entities base ON base.entity_id = inv.object_id
        WHERE inv.user_id = $1::uuid
          AND inv.merged_into_object_id IS NULL
          AND (
            inv.last_seen_place_entity_id = $2::uuid
            OR inv.metadata->'mint'->>'place_entity_id' = $2::text
          )
          AND (
            lower(btrim(base.name)) = $3
            OR lower(btrim(inv.category)) = $3
            OR lower(btrim(inv.subcategory)) = $3
          )
        LIMIT 2`,
      [context.userId, observation.placeEntityId, label],
    );

    if (rows.length !== 1) {
      return null;
    }

    return {
      observationId: observation.id,
      method: 'place_prior',
      confidence: PLACE_PRIOR_CONFIDENCE,
      objectId: rows[0].object_id,
      productId: null,
      reason: `only "${label}" known to be at this place`,
    };
  }

  // -------------------------------------------------------------------------
  // Rung 4 — label
  // -------------------------------------------------------------------------

  /**
   * The only owned unit whose name is the detector's word.
   *
   * The weakest rung by a distance, and deliberately below any threshold worth
   * setting: "cup" matching the one thing called "cup" is a coincidence often
   * enough that acting on it unattended would fill the possessions list with
   * wrong links. It exists so the review queue can offer a human a starting
   * point, which is the same job `PersonDuplicateService`'s name rung does.
   */
  private async byLabel(
    context: UserServiceContext,
    observation: ObjectObservation,
  ): Promise<ObjectResolutionCandidate | null> {
    const label = observation.label.trim().toLowerCase();

    if (label === '') {
      return null;
    }

    const rows = await this.dataSource.query<Array<{ object_id: string }>>(
      `SELECT inv.object_id
         FROM ci.objects inv
         JOIN ci.entities base ON base.entity_id = inv.object_id
        WHERE inv.user_id = $1::uuid
          AND inv.merged_into_object_id IS NULL
          AND lower(btrim(base.name)) = $2
        LIMIT 2`,
      [context.userId, label],
    );

    if (rows.length !== 1) {
      return null;
    }

    return {
      observationId: observation.id,
      method: 'label',
      confidence: LABEL_CONFIDENCE,
      objectId: rows[0].object_id,
      productId: null,
      reason: `exactly one owned unit is named "${label}"`,
    };
  }

  /**
   * Denormalize the sighting onto the unit it resolved to.
   *
   * `last_seen_at` / `last_seen_place_entity_id` exist so the things list can
   * sort and filter without a per-row subquery over observations. Guarded on
   * the timestamp so an out-of-order backfill of old photos cannot walk a
   * unit's "last seen" backwards.
   */
  private async touchLastSeen(
    context: UserServiceContext,
    objectId: string,
    observation: ObjectObservation,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE ci.objects
          SET last_seen_at = $3,
              last_seen_place_entity_id = COALESCE($4::uuid, last_seen_place_entity_id),
              updated_at = now()
        WHERE object_id = $2::uuid
          AND user_id = $1::uuid
          AND merged_into_object_id IS NULL
          AND (last_seen_at IS NULL OR last_seen_at < $3)`,
      [context.userId, objectId, observation.observedAt, observation.placeEntityId],
    );
  }
}
