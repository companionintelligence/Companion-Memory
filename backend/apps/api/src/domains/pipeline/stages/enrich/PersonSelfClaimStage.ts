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
 * retracted (see {@link PersonSelfClaimStage.reconcileClaims}). And the record
 * now states more: staging records every email and phone a contact card
 * gives (`import/staging/identity.ts` `contactIdentifiers`), and migration
 * 20260930022046 wrote them into existing rows' `emails` / `phones`, so every
 * Person is re-read.
 *
 * Within generation 2, and without a bump of its own: the retraction runs in
 * the upsert's own statement, a Person that is no longer live (merged away,
 * deactivated) yields nothing, so all of its claims go, and every Person row
 * is applicable so such a record can still be reached. None of that makes a
 * stored answer provisional — a live Person is reconciled as before, a
 * non-live one was never decided under a predicate that admitted it (the
 * sweep offers it anyway), and one merged after its decision is re-opened by
 * `source.changedAtColumn`.
 */
export const PERSON_SELF_CLAIM_GENERATION = 2;

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
 * Applicability: EVERY Person row — live or merged away, with identifiers or
 * without.
 *
 * Generation 1 applied only to live Persons with something to extract, which
 * was right for a stage that only ever added claims and is wrong for one that
 * retracts them: a Person merged into another, or edited down to no
 * identifiers at all, fell out of the candidate set at exactly the moment its
 * claims went stale, and nothing could reach it again. What a Person yields is
 * decided in {@link PersonSelfClaimStage.run} — nothing, for one that is not
 * live — not by whether the sweep offers it.
 *
 * Never references `ci.identifier_claims` — that would recreate the one-way
 * ratchet `StageSource.predicate`'s own contract forbids (see the type's doc).
 *
 * `updated_at` is the change stamp (`StageSource.changedAtColumn`): every
 * writer of a Person's `name` / `properties` bumps it — the re-import upsert
 * in `GraphIngestService`, `PersonMergeService` on the target and on every
 * source it tombstones, and each TypeORM update through `@UpdateDateColumn` —
 * so a Person whose record changed after its claims were written is re-opened
 * rather than left holding them until the next version bump.
 */
export const PERSON_SELF_CLAIM_SOURCE: StageSource = {
  schema: 'ci',
  table: 'entities',
  idColumn: 'entity_id',
  userColumn: 'owner_user_id',
  predicate: `entity_type = '${ENTITY_TYPE}'`,
  changedAtColumn: 'updated_at',
};

interface SubjectRow {
  entity_id: string;
  name: string | null;
  properties: Record<string, unknown> | null;
  merged: boolean;
  active: boolean;
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
 * ── In step with the record, not appended to ────────────────────────────────
 *
 * The migration calls the table's observations append-only, and for a claim
 * observed on a message that is exactly right: the message does not change,
 * so neither does what was seen on it. A self claim observes nothing that
 * stays put. It is a COPY of a mutable row — "this Person's record says X" —
 * and it is true only while the record still says it. Generation 1 only ever
 * added, so a number dropped from a record (a re-import rewriting `properties`
 * from the source's own card, a merge, an edit) kept its claim, and
 * `clean.duplicate_detect`'s claim pass went on proposing pairs on a number
 * neither record carried, re-proposing them at every scoring bump.
 *
 * So one statement both asserts what the record yields now and RETRACTS the
 * rest — this stage's own claims (`stage`, `subject_type = 'person'`,
 * `role = 'self'`) on the slice's subjects that the upsert did not name. A
 * Person that is no longer live, or no longer there, yields nothing, and
 * loses them all. Two kinds of row are never retracted:
 *
 *  - one a human has DISPOSED. `disposition` is the one column no stage
 *    writes; deleting the row would delete the verdict with it, and a
 *    rejection that vanishes is re-derived the next time the record says X;
 *  - another stage's, or another role's. A claim `enrich.person_link` wrote
 *    because a message resolved to this Person is evidence about the message,
 *    whatever the record says now.
 *
 * Deleted, not flagged: nothing reads a retracted self claim, and every reader
 * of the table — the duplicate claim pass, its holder caps, the review queue —
 * would otherwise have to learn to skip it.
 *
 * WHEN a Person is looked at again is the ledger's business, not this
 * class's: `source.changedAtColumn` re-opens one whose row changed after its
 * claims were written, and a version bump re-opens every one.
 *
 * ── Idempotent, and cheap to re-run ────────────────────────────────────────
 *
 * The upsert is keyed on `(owner_user_id, subject_type, subject_id, role,
 * kind, value_normalized)` — the same unique index every other claim writer
 * uses — so a re-sweep of an unchanged Person costs one no-op UPDATE per
 * claim and retracts nothing, not a duplicate row.
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
      if (subject.merged || !subject.active) {
        // Not a live Person, so it asserts nothing. A merge folded its
        // identifiers into the target's record, which asserts them itself.
        continue;
      }

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
          // cheap provenance, matching reconcileClaims' own COALESCE-on-update.
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

    // Every id in the slice, not only the live ones: a Person merged away,
    // deactivated, deleted or re-owned since the sweep yields nothing, and
    // that is exactly the case whose claims most need to go.
    const retracted = await this.reconcileClaims(ctx.userId, [...new Set(ids)], claims);

    for (const subject of subjects) {
      const detail = { retracted: retracted.get(subject.entity_id) ?? 0 };

      if (subject.merged) {
        results.set(subject.entity_id, { outcome: 'skipped', reason: 'merged', detail });
      } else if (!subject.active) {
        results.set(subject.entity_id, { outcome: 'skipped', reason: 'inactive', detail });
      } else {
        results.set(subject.entity_id, {
          outcome: 'done',
          detail: { claims: claimCounts.get(subject.entity_id) ?? 0, ...detail },
        });
      }
    }

    // Deleted, re-owned or retyped between the sweep and this slice.
    for (const id of ids) {
      if (!results.has(id)) {
        results.set(id, {
          outcome: 'skipped',
          reason: 'source_row_missing',
          detail: { retracted: retracted.get(id) ?? 0 },
        });
      }
    }

    return results;
  }

  /** Every Person row among `ids` the user owns, live or not — {@link run} decides what each yields. */
  private loadSubjects(userId: string, ids: string[]): Promise<SubjectRow[]> {
    return this.dataSource.query<SubjectRow[]>(
      `SELECT entity_id, name, properties,
              merged_into_entity_id IS NOT NULL AS merged,
              COALESCE(is_active, true) AS active
         FROM ci.entities
        WHERE entity_id = ANY($1::uuid[])
          AND owner_user_id = $2::uuid
          AND entity_type = '${ENTITY_TYPE}'`,
      [ids, userId],
    );
  }

  /**
   * Make `subjectIds`' self claims exactly `claims`, in ONE statement:
   * upsert every claim, and retract every other claim this stage holds on
   * those subjects. Returns how many were retracted, per subject.
   *
   * `entity_id` is always the subject itself — there is no resolution step,
   * unlike `PersonLinkStage.writeClaims` — so `confidence` is always 1.0 and
   * `method` is always `self_asserted`.
   *
   * One statement rather than an upsert and a DELETE, so no reader ever sees
   * the half-way state — a Person's new number asserted with the old one not
   * yet retracted, or the reverse — and a slice that dies part-way has done
   * neither. The two halves touch disjoint rows by construction (the DELETE
   * keeps everything `incoming` names), which is what makes running them as
   * sibling CTEs of one statement well-defined.
   *
   * The DELETE rides `identifier_claims_observation_uniq`, whose leading
   * columns — owner, subject_type, subject_id, role — are exactly what it binds.
   */
  private async reconcileClaims(
    userId: string,
    subjectIds: string[],
    claims: ClaimRow[],
  ): Promise<Map<string, number>> {
    const rows = await this.dataSource.query<Array<{ subject_id: string; retracted: number | string }>>(
      `WITH incoming AS (
         SELECT t.entity_id, t.kind, t.value_normalized, t.value_e164, t.raw_value
           FROM unnest($6::uuid[], $7::text[], $8::text[], $9::text[], $10::text[])
                AS t(entity_id, kind, value_normalized, value_e164, raw_value)
       ),
       asserted AS (
         INSERT INTO ci.identifier_claims AS ic
                (owner_user_id, subject_type, subject_id, role, kind, value_normalized, value_e164,
                 raw_value, entity_id, confidence, method, stage, spec_version, observed_at)
         SELECT $1::uuid, $2, t.entity_id, $3, t.kind, t.value_normalized, t.value_e164,
                t.raw_value, t.entity_id, 1.0, 'self_asserted', $4, $5::int, now()
           FROM incoming t
         ON CONFLICT (owner_user_id, subject_type, subject_id, role, kind, value_normalized)
         DO UPDATE SET value_e164   = EXCLUDED.value_e164,
                       -- Never erase a raw value a previous run captured.
                       raw_value    = COALESCE(EXCLUDED.raw_value, ic.raw_value),
                       stage        = EXCLUDED.stage,
                       spec_version = EXCLUDED.spec_version,
                       observed_at  = now()
       ),
       retracted AS (
         DELETE FROM ci.identifier_claims ic
          WHERE ic.owner_user_id = $1::uuid
            AND ic.subject_type = $2
            AND ic.subject_id = ANY($11::uuid[])
            AND ic.role = $3
            AND ic.stage = $4
            AND ic.disposition IS NULL
            AND NOT EXISTS (
                  SELECT 1
                    FROM incoming t
                   WHERE t.entity_id = ic.subject_id
                     AND t.kind = ic.kind
                     AND t.value_normalized = ic.value_normalized)
         RETURNING ic.subject_id
       )
       SELECT r.subject_id::text AS subject_id, count(*)::int AS retracted
         FROM retracted r
        GROUP BY r.subject_id`,
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
        subjectIds,
      ],
    );

    return new Map(rows.map((row) => [String(row.subject_id), Number(row.retracted)]));
  }
}
