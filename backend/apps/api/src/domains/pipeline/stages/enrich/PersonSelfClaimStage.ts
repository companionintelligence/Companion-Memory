import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
// The graph domain's PUBLIC barrel — see PersonLinkStage.ts's header note on
// why this import is the single most important one in this file: the two
// MUST stay byte-identical or a self claim's value_normalized never matches
// the one a communication/event claim resolved to the same entity.
import { normalizeEmail, normalizeName, normalizePhone } from '@ci/domains/graph';

import { PIPELINE_QUEUES } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, type StageVersion } from '../../versions';
import { toE164 } from '../clean/IdentifierNormalizeStage';

/**
 * IDS ARE PERMANENT — the third component of `ci.pipeline_state`'s primary
 * key. Renaming abandons every ledger row written under the old name.
 */
export const ENRICH_PERSON_SELF_CLAIM_STAGE_ID = 'enrich.person_self_claim';

/** `ci.identifier_claims.subject_type` / `.role` this stage writes under. */
const SUBJECT_TYPE = 'person';
const ROLE = 'self';

/** `ci.entities.entity_type` this stage sweeps. */
const ENTITY_TYPE = 'Person';

// ---------------------------------------------------------------------------
// The version
// ---------------------------------------------------------------------------

/**
 * Generation of the extraction rule: which `properties` keys are read
 * (`emails` / `email`, `phones` / `phone`) and the top-level `entities.name`
 * column, and the shared `normalizeEmail` / `normalizePhone` / `normalizeName`
 * rule applied to each. Bump in the same commit that changes any of them —
 * including the shared rule in `domains/graph` — because a change makes
 * every stored claim provisional.
 *
 * 2 — self claims TRACK the record: a claim the record no longer states is
 * retracted (see {@link PersonSelfClaimStage.retractStale}). And the record
 * now states more: staging records every email and phone a contact card
 * gives (`import/staging/identity.ts` `contactIdentifiers`), and migration
 * 20260930022046 wrote them into existing rows' `emails` / `phones`, so every
 * Person is re-read.
 *
 * 3 — `normalizePhone` refuses a value carrying an extension. Generation 2
 * already shipped for the tracking change above, so an appliance that finished
 * it would leave every self claim on a truncated key (`5550147229` from
 * `(212) 555-0147;229`) in place. Migration
 * `20260930020117_refuse_phone_extension_join_keys` deletes those, and this
 * bump re-derives the rest from the repaired `properties`.
 */
export const PERSON_SELF_CLAIM_GENERATION = 3;

export function personSelfClaimStageVersion(versions: Record<string, StageVersion> = STAGE_VERSIONS): number {
  const declared = versions[ENRICH_PERSON_SELF_CLAIM_STAGE_ID];

  if (typeof declared === 'number' && declared !== PERSON_SELF_CLAIM_GENERATION) {
    throw new Error(
      `STAGE_VERSIONS["${ENRICH_PERSON_SELF_CLAIM_STAGE_ID}"] declares ${declared} but the stage ` +
        `derives ${PERSON_SELF_CLAIM_GENERATION} from PERSON_SELF_CLAIM_GENERATION. Bumping the ` +
        `generation is only half the change: update versions.ts in the same commit.`,
    );
  }

  return PERSON_SELF_CLAIM_GENERATION;
}

// Module load, not first sweep: the earliest failure is the cheapest one.
personSelfClaimStageVersion();

/**
 * Applicability: an active, unmerged Person that has at least one raw
 * identifier to extract. Never references `ci.identifier_claims` — that
 * would recreate the one-way ratchet `StageSource.predicate`'s own contract
 * forbids (see the type's doc).
 */
export const PERSON_SELF_CLAIM_SOURCE: StageSource = {
  schema: 'ci',
  table: 'entities',
  idColumn: 'entity_id',
  userColumn: 'owner_user_id',
  predicate:
    `entity_type = '${ENTITY_TYPE}' ` +
    `AND COALESCE(is_active, true) = true ` +
    `AND merged_into_entity_id IS NULL ` +
    `AND (name IS NOT NULL OR properties ? 'emails' OR properties ? 'email' ` +
    `OR properties ? 'phones' OR properties ? 'phone')`,
};

interface SubjectRow {
  entity_id: string;
  name: string | null;
  properties: Record<string, unknown> | null;
}

interface ClaimRow {
  entityId: string;
  kind: 'email' | 'phone' | 'name';
  valueNormalized: string;
  valueE164: string | null;
  rawValue: string | null;
}

/** The string entries of a JSONB value that may be an array, a bare string, or absent. */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }

  return typeof value === 'string' ? [value] : [];
}

/**
 * A Person entity's own identifiers, as `ci.identifier_claims` rows.
 *
 * ── Why this stage exists ───────────────────────────────────────────────────
 *
 * `clean.duplicate_detect` groups `ci.identifier_claims` on `entity_id`
 * regardless of `subject_type` (see the long note on
 * `DuplicateDetectStage.loadEvidence`), so it can propose ANY two Persons
 * sharing a claim as a duplicate pair — but only if both HAVE one. Until this
 * stage, the only claim producers were `enrich.person_link` and
 * `enrich.event_person_link`, which write a claim only for a Person a
 * communication or event actually resolved TO. A Person minted straight from
 * a contact card, vCard, or Apple Contacts (never itself the resolution
 * target of a message) had zero rows in `ci.identifier_claims` — the schema's
 * own migration comment reserves exactly this shape
 * ("'person' is also valid ... the entity claiming its OWN identifier") and
 * nothing filled it.
 *
 * ── Why `ci.entities.properties`, not `ci.entity_identifiers` ──────────────
 *
 * See the long comment on `STAGE_IDS.ENRICH_PERSON_SELF_CLAIM`: the index
 * table is unique per (owner, kind, value) and collapses a genuine duplicate
 * pair's shared identifier down to whichever entity inserted first.
 * `properties` is each entity's own, undeduplicated record.
 *
 * ── Idempotent, and cheap to re-run ────────────────────────────────────────
 *
 * The upsert is keyed on `(owner_user_id, subject_type, subject_id, role,
 * kind, value_normalized)` — the same unique index every other claim writer
 * uses — so a re-sweep of an unchanged Person costs one no-op UPDATE per
 * claim, not a duplicate row.
 */
@Injectable()
export class PersonSelfClaimStage implements Stage {
  readonly id = ENRICH_PERSON_SELF_CLAIM_STAGE_ID;

  readonly version = personSelfClaimStageVersion();

  /** Two Postgres statements per slice, no external call — same reasoning as PersonLinkStage. */
  readonly queue = PIPELINE_QUEUES.INDEX;

  readonly entityTypes = [ENTITY_TYPE] as const;

  readonly source = PERSON_SELF_CLAIM_SOURCE;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PersonSelfClaimStage.name);
  }

  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    const subjects = await this.loadSubjects(ctx.userId, ids);
    const claims: ClaimRow[] = [];
    const claimCounts = new Map<string, number>();

    for (const subject of subjects) {
      const seen = new Set<string>();
      const add = (kind: ClaimRow['kind'], raw: string | null | undefined) => {
        const normalized =
          kind === 'email'
            ? normalizeEmail(raw)
            : kind === 'phone'
              ? normalizePhone(raw)
              : normalizeName(raw);
        if (normalized == null) {
          return;
        }

        const key = `${kind}:${normalized}`;
        if (seen.has(key)) {
          return;
        }

        seen.add(key);
        claims.push({
          entityId: subject.entity_id,
          kind,
          valueNormalized: normalized,
          valueE164: kind === 'phone' ? toE164(raw) : null,
          // Keep the raw form only when normalization actually changed it —
          // cheap provenance, matching writeClaims' own COALESCE-on-update.
          rawValue: raw != null && raw !== normalized ? raw : null,
        });
      };

      add('name', subject.name);

      const props = subject.properties ?? {};
      const emails = toStringArray(props.emails);
      for (const email of emails.length > 0 ? emails : toStringArray(props.email)) {
        add('email', email);
      }

      const phones = toStringArray(props.phones);
      for (const phone of phones.length > 0 ? phones : toStringArray(props.phone)) {
        add('phone', phone);
      }

      claimCounts.set(subject.entity_id, seen.size);
    }

    await this.writeClaims(ctx.userId, claims);
    await this.retractStale(
      ctx.userId,
      subjects.map((subject) => subject.entity_id),
      claims,
    );

    for (const subject of subjects) {
      results.set(subject.entity_id, {
        outcome: 'done',
        detail: { claims: claimCounts.get(subject.entity_id) ?? 0 },
      });
    }

    // Deleted, merged or re-owned between the sweep and this slice.
    for (const id of ids) {
      if (!results.has(id)) {
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    return results;
  }

  /**
   * Delete the self claims a subject's record no longer states.
   *
   * Upserting alone only ever ADDS: a number a re-import dropped from the
   * record, or a merge moved, kept its claim for good, and the duplicate
   * detector's claim pass kept proposing pairs on it — "Same phone number"
   * over a number one of the two people no longer had. The claim set is a
   * copy of the record, so it must shrink with it.
   *
   * Only this stage's rows — `stage` is its id, which it has written on every
   * row since it first ran; `subject_type = 'person'`, `role = 'self'` alone is
   * also the shape the claims table reserves for a contact importer's own
   * assertions, and those are not this stage's to take back. Only for the
   * subjects just read (live Persons of this slice), and never a claim a human
   * disposed: a confirmation or a rejection is a decision about the
   * identifier, and outlives the record that first stated it.
   */
  private async retractStale(userId: string, subjectIds: string[], kept: ClaimRow[]): Promise<void> {
    if (subjectIds.length === 0) {
      return;
    }

    await this.dataSource.query(
      `DELETE FROM ci.identifier_claims ic
        WHERE ic.owner_user_id = $1::uuid
          AND ic.subject_type = $2
          AND ic.role = $3
          AND ic.subject_id = ANY($4::uuid[])
          AND ic.stage = $8
          AND ic.disposition IS NULL
          AND NOT EXISTS (
                SELECT 1
                  FROM unnest($5::uuid[], $6::text[], $7::text[]) AS k(subject_id, kind, value_normalized)
                 WHERE k.subject_id = ic.subject_id
                   AND k.kind = ic.kind
                   AND k.value_normalized = ic.value_normalized)`,
      [
        userId,
        SUBJECT_TYPE,
        ROLE,
        subjectIds,
        kept.map((claim) => claim.entityId),
        kept.map((claim) => claim.kind),
        kept.map((claim) => claim.valueNormalized),
        this.id,
      ],
    );
  }

  private loadSubjects(userId: string, ids: string[]): Promise<SubjectRow[]> {
    return this.dataSource.query<SubjectRow[]>(
      `SELECT entity_id, name, properties
         FROM ci.entities
        WHERE entity_id = ANY($1::uuid[])
          AND owner_user_id = $2::uuid
          AND entity_type = '${ENTITY_TYPE}'
          AND COALESCE(is_active, true) = true
          AND merged_into_entity_id IS NULL`,
      [ids, userId],
    );
  }

  /**
   * Every claim in ONE upsert. `entity_id` is always the subject itself —
   * there is no resolution step, unlike `PersonLinkStage.writeClaims` — so
   * `confidence` is always 1.0 and `method` is always `self_asserted`.
   */
  private async writeClaims(userId: string, claims: ClaimRow[]): Promise<void> {
    if (claims.length === 0) {
      return;
    }

    await this.dataSource.query(
      `INSERT INTO ci.identifier_claims AS ic
              (owner_user_id, subject_type, subject_id, role, kind, value_normalized, value_e164,
               raw_value, entity_id, confidence, method, stage, spec_version, observed_at)
       SELECT $1::uuid, $2, t.entity_id, $3, t.kind, t.value_normalized, t.value_e164,
              t.raw_value, t.entity_id, 1.0, 'self_asserted', $4, $5::int, now()
         FROM unnest($6::uuid[], $7::text[], $8::text[], $9::text[], $10::text[])
              AS t(entity_id, kind, value_normalized, value_e164, raw_value)
       ON CONFLICT (owner_user_id, subject_type, subject_id, role, kind, value_normalized)
       DO UPDATE SET value_e164   = EXCLUDED.value_e164,
                     -- Never erase a raw value a previous run captured.
                     raw_value    = COALESCE(EXCLUDED.raw_value, ic.raw_value),
                     stage        = EXCLUDED.stage,
                     spec_version = EXCLUDED.spec_version,
                     observed_at  = now()`,
      [
        userId,
        SUBJECT_TYPE,
        ROLE,
        this.id,
        PERSON_SELF_CLAIM_GENERATION,
        claims.map((c) => c.entityId),
        claims.map((c) => c.kind),
        claims.map((c) => c.valueNormalized),
        claims.map((c) => c.valueE164),
        claims.map((c) => c.rawValue),
      ],
    );
  }
}
