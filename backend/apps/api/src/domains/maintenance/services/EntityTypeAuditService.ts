import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { GraphIngestService } from '@ci/domains/graph';
import {
  CONTACT_STAGED_TYPE,
  SHORT_CODE_STAGED_TYPE,
  type StagedEntity,
  entityTypeFor,
  isShortCode,
  stagedNaturalKey,
} from '@ci/domains/import';
import { PersonalizationService } from '@ci/domains/personalization';

import type { ProposalAutonomy, SearchIndexAction } from '../entities/EntityTypeProposalEntity';

/** Written to `detected_by`, so a row says which job and which rule produced it. */
export const ENTITY_TYPE_AUDIT_DETECTOR = 'maintenance.entity_type_audit:short_code';

/**
 * Bumped whenever the rule below changes what it would propose. Same purpose as
 * `DUPLICATE_SCORING_GENERATION`: a rescore under a new generation is
 * distinguishable from a stale row nobody re-examined.
 */
export const ENTITY_TYPE_AUDIT_GENERATION = 1;

/** The type the audit re-classifies OUT of. */
export const AUDITED_ENTITY_TYPE = 'Person';

/**
 * Rows one run examines per user.
 *
 * A cap, not a rotation: the candidate set is Person rows whose NAME is
 * phone-shaped, which is a few hundred on a full corpus, so this normally never
 * binds. When it does, the window is ordered least-recently-proposed first
 * (`entity_type_proposals_updated_at_idx`), so the next run resumes past what
 * this one filed rather than re-walking the same head.
 */
export const AUDIT_WINDOW_SIZE = 1_000;

/**
 * `PHONE_SHAPED` (import/staging/identity.ts) as a POSIX regex, and NOTHING
 * else — no digit count.
 *
 * The digit threshold is the part that has moved and could move again, so it
 * stays in `isShortCode` where there is exactly one of it; this restatement is
 * only a cheap index-side narrowing, and it is deliberately a strict SUPERSET
 * of what the classifier accepts. `entityTypeAudit.integration.spec.ts` asserts
 * that implication against the live database rather than trusting the two
 * regexes to look alike.
 */
export const PHONE_SHAPED_SQL = '^[-+()./[:space:]0-9]+$';

/**
 * Score for a row whose CURRENT key proves the pre-fix parser minted it — i.e.
 * `linked_id = uuidv5('contact:<lower(trim(name))>')`.
 *
 * 0.9 clears `hands_off`'s `autoPromoteThreshold` (0.7), so an appliance whose
 * owner asked for autonomy may pre-authorise the retype. `balanced` answers
 * `review` because `graph_entity` is in `GRAPH_CONNECTION_KINDS`, which that
 * branch never auto-applies; `cautious` answers `review` for a different
 * reason — it returns before the graph-kind test is reached, on
 * `hasUserInput ? 'review' : 'skip'`, and this caller always passes
 * `hasUserInput: true`. Same outcome, two mechanisms: a caller that stopped
 * passing `hasUserInput` would turn cautious into `skip`, not `review`.
 */
export const KEYED_AS_CONTACT_SCORE = 0.9;

/**
 * Score for a row the classifier flags but whose key does NOT prove how it was
 * minted, or whose proposed coordinate is already occupied.
 *
 * Below `PersonalizationService.ALWAYS_REVIEW_BELOW_CONFIDENCE` (0.7) on
 * purpose: no trust mode may pre-authorise these, including `hands_off`. This
 * is the branch that makes the gate more than decoration — the same call, on
 * the same appliance, answers `auto` for one proposal and `review` for another.
 */
export const UNPROVEN_KEY_SCORE = 0.5;

/** A `ci.entities` row the window handed to the classifier. */
export interface EntityTypeAuditCandidate {
  entityId: string;
  ownerUserId: string;
  entityType: string;
  name: string;
  linkedTable: string | null;
  linkedId: string | null;
  /** `ci.entity_identifiers` rows of kind email/phone — a way to reach a person. */
  reachableIdentifiers: number;
  /** `properties.emails` / `properties.phones` hold at least one value. */
  reachableProperties: boolean;
}

/** What the classifier says about one candidate. */
export interface EntityTypeFinding {
  proposedEntityType: string;
  proposedNaturalKey: string;
  proposedLinkedId: string;
  score: number;
  evidence: string[];
  searchIndexAction: SearchIndexAction;
  /** A row already sitting at {@link proposedLinkedId}; resolved after classification. */
  conflictingEntityId: string | null;
}

export interface EntityTypeProposalRecord extends EntityTypeFinding {
  entityId: string;
  autonomy: ProposalAutonomy;
  searchIndexRows: Record<string, number>;
}

export interface EntityTypeAuditResult {
  userId: string;
  /** Rows the window returned (phone-shaped Person names). */
  examined: number;
  /** Rows the classifier flagged. */
  findings: number;
  /**
   * Proposals written or rescored — always equal to {@link findings}.
   *
   * There is deliberately no `skipped` counterpart. The dial decides the
   * AUTONOMY a proposal is filed with, never whether it is filed at all; see
   * the gate in {@link EntityTypeAuditService.audit} for why `skip` is not a
   * reachable answer here, and `entityTypeAuditGate.spec.ts` for the real
   * `PersonalizationService` being asked and never giving one.
   */
  proposed: number;
  records: EntityTypeProposalRecord[];
}

/** `entityTypeFor` reads only `type`; going through it keeps ONE staged→graph type map. */
function graphTypeForStagedType(stagedType: string): string {
  return entityTypeFor({ type: stagedType } as unknown as StagedEntity);
}

/**
 * Re-run the short-code classifier over one `ci.entities` row and say what,
 * if anything, is wrong with its type. Pure — every rule below is testable
 * without a database.
 *
 * Returns null when the row is fine, which includes the case that matters most:
 * a `Person` whose name happens to be a full phone number is a person reachable
 * on that number, and {@link isShortCode} says so by refusing anything
 * `normalizeHandle` will key.
 */
export function classifyShortCodePerson(candidate: EntityTypeAuditCandidate): EntityTypeFinding | null {
  if (candidate.entityType !== AUDITED_ENTITY_TYPE) {
    return null;
  }

  if (!isShortCode(candidate.name)) {
    return null;
  }

  // Contradicting evidence outranks the name. A row carrying an email or a real
  // phone is reachable, whatever it happens to be called, and retyping it out
  // of the address book would lose a person.
  if (candidate.reachableIdentifiers > 0 || candidate.reachableProperties) {
    return null;
  }

  const proposedNaturalKey = stagedNaturalKey(SHORT_CODE_STAGED_TYPE, null, candidate.name);

  if (proposedNaturalKey == null) {
    return null;
  }

  const proposedEntityType = graphTypeForStagedType(SHORT_CODE_STAGED_TYPE);

  if (proposedEntityType === candidate.entityType) {
    return null;
  }

  const contactKey = stagedNaturalKey(CONTACT_STAGED_TYPE, null, candidate.name);
  const keyedAsContact =
    contactKey != null &&
    candidate.linkedId != null &&
    candidate.linkedId === GraphIngestService.linkedIdFor(contactKey);

  const evidence = [
    `name is a short code (phone-shaped, too short for normalizeHandle to key): ${candidate.name}`,
    'no email or phone identifier, and no properties.emails / properties.phones entry',
  ];

  if (keyedAsContact) {
    evidence.push(`linked_id equals uuidv5('${contactKey}') — minted by the pre-fix contact path`);
  } else {
    evidence.push('linked_id does not match the pre-fix contact key: how this row was minted is unproven');
  }

  return {
    proposedEntityType,
    proposedNaturalKey,
    proposedLinkedId: GraphIngestService.linkedIdFor(proposedNaturalKey),
    score: keyedAsContact ? KEYED_AS_CONTACT_SCORE : UNPROVEN_KEY_SCORE,
    evidence,
    // From the TYPE TRANSITION, not from the counts: leaving `Person` is what
    // strands the person index, whether or not it happens to hold rows today.
    searchIndexAction:
      candidate.entityType === AUDITED_ENTITY_TYPE && proposedEntityType !== AUDITED_ENTITY_TYPE
        ? 'purge_person_index'
        : 'none',
    conflictingEntityId: null,
  };
}

/**
 * Fold the occupancy of the proposed coordinate into a finding.
 *
 * `entities_linked_uniq` means a re-key onto a taken coordinate cannot be
 * applied at all — the apply would have to MERGE instead, which is a different
 * operation with a different executor. So the proposal still gets filed (the
 * mis-type is real and a human should see it), but the score drops below the
 * autonomy floor so no trust mode can pre-authorise it.
 */
export function withCoordinateConflict(
  finding: EntityTypeFinding,
  conflictingEntityId: string | null,
): EntityTypeFinding {
  if (conflictingEntityId == null) {
    return finding;
  }

  return {
    ...finding,
    conflictingEntityId,
    score: Math.min(finding.score, UNPROVEN_KEY_SCORE),
    evidence: [
      ...finding.evidence,
      `entity ${conflictingEntityId} already occupies the proposed coordinate — ` +
        'applying this needs a merge, not a re-key',
    ],
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WEEKLY RE-CLASSIFICATION. IT PROPOSES; IT NEVER RETYPES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Six hand-written retype migrations landed in 48 hours because a parser fix
 * repairs the NEXT import and leaves the corpus, and nothing re-applies the
 * shared classifier to rows already in `ci.entities`. This service is that
 * missing re-application.
 *
 * It issues no UPDATE against `ci.entities`, `ci_search.*` or
 * `ci.pipeline_state` — not under any trust mode, not at any confidence. Its
 * entire output is rows in `ci.entity_type_proposals`. Two facts make that the
 * only defensible shape for an unattended job:
 *
 *  1. **A retype moves the natural key**, so applying one means writing
 *     `entity_type` AND `linked_id` together; either alone leaves a row that
 *     matches neither the old shape nor the new one.
 *  2. **A retype out of `Person` strands the person search index**, whose rows
 *     must be deleted in the SAME transaction or they answer searches forever.
 *
 * The proposal carries both, so whoever applies it has what the atomic
 * transaction needs; nothing here performs it.
 */
@Injectable()
export class EntityTypeAuditService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly personalization: PersonalizationService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EntityTypeAuditService.name);
  }

  async audit(userId: string, windowSize: number = AUDIT_WINDOW_SIZE): Promise<EntityTypeAuditResult> {
    const candidates = await this.loadWindow(userId, windowSize);
    const records: EntityTypeProposalRecord[] = [];
    let findings = 0;

    for (const candidate of candidates) {
      const classified = classifyShortCodePerson(candidate);

      if (classified == null) {
        continue;
      }

      findings += 1;

      const finding = withCoordinateConflict(
        classified,
        await this.findCoordinateOccupant(candidate, classified),
      );

      // ── The gate, and the two answers it can give. ──────────────────────
      //
      // `review` — cautious and balanced at any confidence, because
      //   `graph_entity` is in GRAPH_CONNECTION_KINDS and neither mode ever
      //   auto-applies one; and `hands_off` below its 0.7 autoPromoteThreshold,
      //   which is exactly where UNPROVEN_KEY_SCORE sits.
      // `auto`   — `hands_off` at or above 0.7, so KEYED_AS_CONTACT_SCORE only.
      //
      // `skip` is the third answer and this call cannot produce it. For
      // `graph_entity` the dial has exactly one skip branch — cautious's
      // `hasUserInput ? review : skip` fall-through, reserved for
      // machine-authored work — and this evidence is the user's own imported
      // data, the same reading DerivationRunListener takes of the same dial.
      // (The dial's other skip branches belong to `feed_action` and
      // `insights_generation`, kinds this service never asks about.)
      //
      // Nor would suppression be the right outcome: the proposal is inert, so a
      // cautious appliance wants the row to LOOK at, not silence. Every finding
      // is therefore filed, which is why the result has no `skipped` counter to
      // report a zero nobody could distinguish from approval.
      const decision = await this.personalization.decideAction(userId, {
        kind: 'graph_entity',
        confidence: finding.score,
        hasUserInput: true,
      });

      const searchIndexRows = await this.countIndexRows(candidate.entityId);
      const record: EntityTypeProposalRecord = {
        ...finding,
        entityId: candidate.entityId,
        // Recorded, not obeyed. `auto` says a hands_off appliance has
        // pre-authorised the change; nothing on this appliance applies it, and
        // this service is not what would.
        autonomy: decision === 'auto' ? 'auto' : 'review',
        searchIndexRows,
      };

      await this.upsertProposal(candidate, record);
      records.push(record);
    }

    this.logger.log('Entity type audit complete', {
      userId,
      examined: candidates.length,
      findings,
      proposed: records.length,
    });

    return {
      userId,
      examined: candidates.length,
      findings,
      proposed: records.length,
      records,
    };
  }

  /**
   * The window: `Person` rows under an import source whose name is phone-shaped
   * and whose proposal, if any, is still open.
   *
   * A row with a settled proposal is excluded rather than rescored — that is
   * `ci.merge_candidates`' contract restated: a human's `rejected` is not
   * something a weekly timer gets to reopen.
   */
  private async loadWindow(userId: string, windowSize: number): Promise<EntityTypeAuditCandidate[]> {
    const rows = (await this.dataSource.query(
      `SELECT e.entity_id                                    AS "entityId",
              e.owner_user_id                                AS "ownerUserId",
              e.entity_type                                  AS "entityType",
              e.name                                         AS "name",
              e.linked_table                                 AS "linkedTable",
              e.linked_id                                    AS "linkedId",
              (SELECT count(*)
                 FROM ci.entity_identifiers ei
                WHERE ei.entity_id = e.entity_id
                  AND ei.kind IN ('email', 'phone'))         AS "reachableIdentifiers",
              (jsonb_array_length(COALESCE(e.properties->'emails', '[]'::jsonb)) > 0
               OR jsonb_array_length(COALESCE(e.properties->'phones', '[]'::jsonb)) > 0)
                                                             AS "reachableProperties"
         FROM ci.entities e
         LEFT JOIN ci.entity_type_proposals p
                ON p.entity_id = e.entity_id
        WHERE e.owner_user_id = $1::uuid
          AND e.entity_type = $2
          AND e.merged_into_entity_id IS NULL
          AND e.linked_table LIKE 'import:%'
          AND e.name IS NOT NULL
          AND btrim(e.name, E' \\t\\r\\n') ~ $3
          AND (p.status IS NULL OR p.status = 'pending')
        ORDER BY p.updated_at ASC NULLS FIRST, e.entity_id
        LIMIT $4`,
      [userId, AUDITED_ENTITY_TYPE, PHONE_SHAPED_SQL, windowSize],
    )) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      entityId: String(row.entityId),
      ownerUserId: String(row.ownerUserId),
      entityType: String(row.entityType),
      name: String(row.name),
      linkedTable: row.linkedTable == null ? null : String(row.linkedTable),
      linkedId: row.linkedId == null ? null : String(row.linkedId),
      reachableIdentifiers: Number(row.reachableIdentifiers ?? 0),
      reachableProperties: row.reachableProperties === true,
    }));
  }

  /**
   * The entity, if any, already sitting where this candidate would move to.
   *
   * `entities_linked_uniq` is (owner, entity_type, linked_table, linked_id), so
   * the occupant is looked for at the PROPOSED type as well as the proposed
   * linked_id — a row of some third type at the same linked_id is not in the
   * way. Merge tombstones count: `upsertEntities` resolves a coordinate through
   * `merged_into_entity_id`, so a tombstone there is still the row a re-import
   * would find.
   */
  private async findCoordinateOccupant(
    candidate: EntityTypeAuditCandidate,
    finding: EntityTypeFinding,
  ): Promise<string | null> {
    const rows = (await this.dataSource.query(
      `SELECT t.entity_id AS "entityId"
         FROM ci.entities t
        WHERE t.owner_user_id IS NOT DISTINCT FROM $1::uuid
          AND t.linked_table IS NOT DISTINCT FROM $2
          AND t.entity_type = $3
          AND t.linked_id = $4::uuid
          AND t.entity_id <> $5::uuid
        LIMIT 1`,
      [
        candidate.ownerUserId,
        candidate.linkedTable,
        finding.proposedEntityType,
        finding.proposedLinkedId,
        candidate.entityId,
      ],
    )) as Array<{ entityId: string }>;

    return rows.length > 0 ? String(rows[0].entityId) : null;
  }

  /**
   * Index rows the retype would strand. Counted per table because they are
   * deleted per table, and recorded so the proposal's claim about the index is
   * checkable instead of asserted.
   */
  private async countIndexRows(entityId: string): Promise<Record<string, number>> {
    const [row] = (await this.dataSource.query(
      `SELECT (SELECT count(*) FROM ci_search.vectors      WHERE entity_id = $1::uuid) AS vectors,
              (SELECT count(*) FROM ci_search.embeddings   WHERE entity_id = $1::uuid) AS embeddings,
              (SELECT count(*) FROM ci_search.index_skips  WHERE entity_id = $1::uuid) AS index_skips,
              (SELECT count(*) FROM ci.pipeline_state      WHERE entity_id = $1::uuid) AS pipeline_state`,
      [entityId],
    )) as Array<Record<string, unknown>>;

    return {
      vectors: Number(row?.vectors ?? 0),
      embeddings: Number(row?.embeddings ?? 0),
      index_skips: Number(row?.index_skips ?? 0),
      pipeline_state: Number(row?.pipeline_state ?? 0),
    };
  }

  /**
   * File or rescore one proposal.
   *
   * `status` is deliberately absent from the DO UPDATE list, matching
   * `DuplicateDetectStage`'s contract against `ci.merge_candidates`: a re-run
   * refreshes the evidence and the score, and never resurrects a decision a
   * human already made.
   */
  private async upsertProposal(
    candidate: EntityTypeAuditCandidate,
    record: EntityTypeProposalRecord,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO ci.entity_type_proposals (
              owner_user_id, entity_id,
              current_entity_type, proposed_entity_type,
              current_linked_id, proposed_linked_id, proposed_natural_key, linked_table,
              conflicting_entity_id,
              search_index_action, search_index_rows,
              score, autonomy, evidence, detected_by, detector_version)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7, $8, $9::uuid,
               $10, $11::jsonb, $12, $13, $14::jsonb, $15, $16)
       ON CONFLICT (owner_user_id, entity_id) DO UPDATE
          SET proposed_entity_type  = EXCLUDED.proposed_entity_type,
              current_entity_type   = EXCLUDED.current_entity_type,
              current_linked_id     = EXCLUDED.current_linked_id,
              proposed_linked_id    = EXCLUDED.proposed_linked_id,
              proposed_natural_key  = EXCLUDED.proposed_natural_key,
              linked_table          = EXCLUDED.linked_table,
              conflicting_entity_id = EXCLUDED.conflicting_entity_id,
              search_index_action   = EXCLUDED.search_index_action,
              search_index_rows     = EXCLUDED.search_index_rows,
              score                 = EXCLUDED.score,
              autonomy              = EXCLUDED.autonomy,
              evidence              = EXCLUDED.evidence,
              detected_by           = EXCLUDED.detected_by,
              detector_version      = EXCLUDED.detector_version,
              updated_at            = now()`,
      [
        candidate.ownerUserId,
        candidate.entityId,
        candidate.entityType,
        record.proposedEntityType,
        candidate.linkedId,
        record.proposedLinkedId,
        record.proposedNaturalKey,
        candidate.linkedTable,
        record.conflictingEntityId,
        record.searchIndexAction,
        JSON.stringify(record.searchIndexRows),
        record.score,
        record.autonomy,
        JSON.stringify(record.evidence),
        ENTITY_TYPE_AUDIT_DETECTOR,
        ENTITY_TYPE_AUDIT_GENERATION,
      ],
    );
  }
}
