import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { SINGLE_VALUED_RELATIONSHIP_TYPES } from '@ci/domains/graph';
import { ActionService } from '@ci/domains/intelligence';

import { PIPELINE_QUEUES } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, type StageVersion } from '../../versions';

/**
 * This stage's id.
 *
 * Declared locally ahead of its `STAGE_IDS` entry, as every stage written before
 * its wiring has been. `__tests__/stageWiring.spec.ts` fails by name until the
 * central entries land.
 *
 * IDS ARE PERMANENT — the id is the third component of `ci.pipeline_state`'s
 * primary key, so renaming it abandons every ledger row written under the old
 * name. For this stage that also discards the COUNT, which is the entire point
 * of it existing.
 */
export const CLEAN_SINGLE_VALUED_EDGE_AUDIT_STAGE_ID = 'clean.single_valued_edge_audit';

/** The ledger `entity_type` this stage records under. */
const ENTITY_TYPE = 'entity';

/**
 * The `reason` a contradicted subject is recorded under.
 *
 * `reason` is written for EVERY outcome (`PipelineStateService.complete` pushes
 * `result.reason ?? null` regardless of status; only `skipped`/`failed` are
 * *required* to carry one), and it is a real column on `ci.pipeline_state`.
 * `StageResult.detail` is NOT — the service says so at its own docblock: it is
 * validated and then dropped, because the table has no column for it and
 * `ci.derived_facts` does not exist.
 *
 * That asymmetry decides the shape of this stage's output. A detector whose
 * whole deliverable is a NUMBER cannot put that number somewhere the ledger
 * throws away, so a contradicted subject is `done` — it WAS examined, and the
 * stage did exactly what it exists to do — carrying this reason, and the count
 * is one query:
 *
 * ```sql
 * SELECT count(*) FROM ci.pipeline_state
 *  WHERE stage = 'clean.single_valued_edge_audit'
 *    AND reason = 'single_valued_conflict';
 * ```
 *
 * It is a WATERMARK count, not a live one: a ledger row is stamped at the
 * version that wrote it and is not revisited until the version moves, so a
 * contradiction resolved after the sweep still reads as a contradiction here.
 * The live number is the same `GROUP BY` this stage runs, off the ledger
 * entirely — see {@link SingleValuedEdgeAuditStage} for it.
 */
export const CONFLICT_REASON = 'single_valued_conflict';

/**
 * Days a raised card suppresses its own repeat, dismissed or not.
 *
 * Seven, matching `RetrievalHealthCron.ALERT_REPEAT_DAYS`, and for its reason:
 * ignoring dismissal in one direction only would put the card straight back the
 * night after the user cleared it, and ignoring it in the other would let a
 * still-contradicted graph go quiet forever.
 */
export const CONFLICT_ALERT_REPEAT_DAYS = 7;

/**
 * Most cards ONE slice may raise.
 *
 * A detector that finds a systemic contradiction finds it everywhere at once,
 * and a feed that receives four hundred cards in one night is a feed nobody
 * opens again. The cap is not a sampling error: every contradiction is still
 * counted in the ledger and in the per-slice log line, and only the CARDS are
 * bounded. `MAX_GROUP_MEMBERS` in `DuplicateDetectStage` makes the same trade
 * for the same reason.
 */
export const MAX_ALERTS_PER_SLICE = 5;

// ---------------------------------------------------------------------------
// The version
// ---------------------------------------------------------------------------

/**
 * Generation of the AUDIT RULE — {@link SINGLE_VALUED_RELATIONSHIP_TYPES}, the
 * overlap test in {@link overlaps}, and the grouping in
 * {@link findContradictions}.
 *
 * Bump it in the same commit that edits any of them, and expect the bump to be
 * the normal way this stage is used: the declared type set starts at ONE entry
 * and the audit exists to tell us what else belongs in it. Every bump re-sweeps
 * the corpus under the new rule, which is exactly what re-counting means here.
 */
export const SINGLE_VALUED_AUDIT_RULE_GENERATION = 1;

/**
 * The stage version.
 *
 * One term today, spelled as a derivation for the reason `TemporalRepairStage`
 * spells its version as one: this file is written before `versions.ts` learns
 * the id, and `stageVersion(id)` THROWS on a missing entry, so a stage that
 * cannot yet be declared centrally cannot use it.
 *
 * A SUM when a second term appears, never a hash: a sum is monotone in each
 * term so the version can only go UP, and `versions.ts` documents at length why
 * a version that goes down leaves every processed row looking stale-*forward*
 * and permanently invisible.
 */
export const SINGLE_VALUED_AUDIT_VERSION = SINGLE_VALUED_AUDIT_RULE_GENERATION;

/**
 * The version this stage reports, cross-checked against `STAGE_VERSIONS`.
 *
 * `StageRegistry.assertConsistent` requires `stage.version` to equal
 * `STAGE_VERSIONS[id]`. A missing entry is NOT an error here — this file is
 * imported by its own spec before the central declarations land — but a
 * DISAGREEING entry is, and it throws here, where the fix is one line.
 *
 * `versions` is a parameter only so a test can prove the cross-check without
 * mutating the production declaration.
 */
export function singleValuedEdgeAuditStageVersion(
  versions: Record<string, StageVersion> = STAGE_VERSIONS,
): number {
  const declared = versions[CLEAN_SINGLE_VALUED_EDGE_AUDIT_STAGE_ID];

  if (typeof declared === 'number' && declared !== SINGLE_VALUED_AUDIT_VERSION) {
    throw new Error(
      `STAGE_VERSIONS["${CLEAN_SINGLE_VALUED_EDGE_AUDIT_STAGE_ID}"] declares ${declared} but the stage ` +
        `derives ${SINGLE_VALUED_AUDIT_VERSION} from SINGLE_VALUED_AUDIT_RULE_GENERATION ` +
        `(${SINGLE_VALUED_AUDIT_RULE_GENERATION}). Bumping a generation is only half the change: update ` +
        `versions.ts in the same commit, or the two disagree about which subjects have already been ` +
        `audited — and this stage's whole output is a count of subjects it audited.`,
    );
  }

  return SINGLE_VALUED_AUDIT_VERSION;
}

// Run at module load rather than at the first sweep, for the reason every other
// derived-version stage does: the earliest failure is the cheapest one.
singleValuedEdgeAuditStageVersion();

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * The declared types, as a SQL string list, quoted for interpolation.
 *
 * Safe to interpolate: every member comes from the `RelationshipType` enum, an
 * in-repo literal, and `valid_relationship_type` on `ci.relationships` is
 * `CHECK (relationship_type ~ '^[A-Z_][A-Z0-9_]*$')` — a shape with no quote in
 * it. The assertion below is what keeps that true if somebody ever adds a type
 * from outside the enum: it throws at module load rather than building a string
 * nobody re-reads.
 */
const DECLARED_TYPES: readonly string[] = [...SINGLE_VALUED_RELATIONSHIP_TYPES].sort();

for (const type of DECLARED_TYPES) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(type)) {
    throw new Error(
      `SINGLE_VALUED_RELATIONSHIP_TYPES contains "${type}", which is not a relationship type: ` +
        `ci.relationships CHECKs '^[A-Z_][A-Z0-9_]*$' and this constant is interpolated into SQL.`,
    );
  }
}

const DECLARED_TYPES_SQL = DECLARED_TYPES.map((type) => `'${type}'`).join(', ');

/**
 * Where the sweep looks for candidates, and which of those rows this stage
 * APPLIES to.
 *
 * The sweep pages over SUBJECTS (`ci.entities`), not over edges and not over
 * groups. That is the only shape that fits the ledger — `ci.pipeline_state` is
 * keyed `(entity_type, entity_id, stage)` and a `(from, type)` group has no id
 * — and it is the shape that makes the two numbers this PR exists to produce
 * fall out of one table:
 *
 *  - the DENOMINATOR is the ledger row count for this stage: subjects that hold
 *    at least one active edge of a declared single-valued type;
 *  - the NUMERATOR is those rows whose `reason` is {@link CONFLICT_REASON}.
 *
 * ── The EXISTS clause is applicability, not completion ─────────────────────
 *
 * It LOOKS like the ratchet the pipeline README warns about, so it needs
 * saying: THIS STAGE WRITES NOTHING TO `ci.relationships`. It has no writer, no
 * supersession and no `is_active` update — see the class docblock for why that
 * is the whole point — so no row can leave the candidate set because this stage
 * succeeded. Compare `s.time_source IS NULL` in `TemporalRepairStage`, which
 * WOULD be the ratchet, and is not there.
 *
 * What the clause buys is proportionality. Without it the sweep pages every
 * entity in the corpus and writes a ledger row for each — hundreds of thousands
 * of `skipped: no_single_valued_edges` rows nightly — to audit a declared set
 * that currently holds one type, held by one subject (the user's self entity).
 * The cost of the clause is that "how many entities have no single-valued edge
 * at all" stops being answerable from the ledger. That question is answerable
 * with one `count(*)` over `ci.entities` and is not what anybody is asking.
 *
 * `is_active` / `merged_into_entity_id` are applicability one column over: a
 * tombstoned entity is not a subject, it is a redirect left behind by
 * `PersonMergeService`, and its edges are the merge's problem.
 *
 * No `entity_type` filter. Single-valuedness is a property of the RELATIONSHIP
 * TYPE, not of who holds it: the reachable `LIVES_IN` case is held by a `User`
 * self entity, `WORKS_AT` (if it is ever declared) by a `Person`, and a
 * `MEMBER_OF` by either. Filtering by subject type here would silently scope the
 * audit to whatever type the first entry happened to have.
 */
export const SINGLE_VALUED_EDGE_AUDIT_SOURCE: StageSource = {
  schema: 'ci',
  table: 'entities',
  idColumn: 'entity_id',
  userColumn: 'owner_user_id',
  predicate:
    `COALESCE(s.is_active, true) = true ` +
    `AND s.merged_into_entity_id IS NULL ` +
    `AND EXISTS (SELECT 1 FROM ci.relationships r ` +
    `WHERE r.from_entity_id = s.entity_id ` +
    `AND r.owner_user_id = s.owner_user_id ` +
    `AND r.is_active = TRUE ` +
    (DECLARED_TYPES_SQL.length > 0
      ? `AND r.relationship_type IN (${DECLARED_TYPES_SQL}))`
      : // An empty declared set means the audit has nothing to look for. Spelled
        // as `FALSE` rather than as `IN ()`, which is a syntax error, and rather
        // than dropping the clause, which would sweep the whole corpus to find
        // nothing.
        `AND FALSE)`),
};

// ---------------------------------------------------------------------------
// The rule — pure
// ---------------------------------------------------------------------------

/** One active edge of a declared single-valued type, as the query returns it. */
export interface SingleValuedEdge {
  from_entity_id: string;
  relationship_type: string;
  to_entity_id: string;
  relationship_id: string;
  /** `ci.relationships.start_date`, rendered `YYYY-MM-DD` by a `::text` cast. */
  start_date: string | null;
  end_date: string | null;
}

/** One edge's part in a contradiction, as the card and the log line report it. */
export interface ContradictionMember {
  toEntityId: string;
  relationshipId: string;
  startDate: string | null;
  endDate: string | null;
}

/** One `(subject, type)` group holding more than one simultaneously-true answer. */
export interface EdgeContradiction {
  fromEntityId: string;
  relationshipType: string;

  /** The edges that actually overlap, two or more, in query order. */
  members: ContradictionMember[];

  /**
   * True when EVERY member carries neither a start nor an end date.
   *
   * The honesty flag. It says the temporal half of the rule contributed
   * NOTHING to this finding — the members did not overlap, they merely both
   * failed to say anything about when they were true, and {@link overlaps}
   * reads "unbounded on both sides" as overlapping because that is what an
   * unbounded interval is.
   *
   * Counted separately in the log line so the follow-up question — "is this
   * corpus's contradiction count real, or is it just an absence of dates?" —
   * has a number rather than an argument.
   */
  undated: boolean;
}

/**
 * Do two edges' validity intervals overlap?
 *
 * `start_date`/`end_date` are nullable `DATE`s; NULL means UNBOUNDED on that
 * side, which is the only reading consistent with the writers — `valid_date_range`
 * on `ci.relationships` only CHECKs `start_date <= end_date` when both are
 * present, and `KnownPlacesService` writes a home with no end date to mean "still
 * true".
 *
 * Inclusive on both ends: two edges that meet on a single day are two answers on
 * that day. A move-out and a move-in on the same date is the boundary case, and
 * flagging it is the conservative direction for a detector that writes nothing.
 *
 * Compared as strings, which is exact for the `YYYY-MM-DD` a `date::text` cast
 * produces — fixed-width, zero-padded, big-endian, so lexicographic order IS
 * chronological order. Parsing to `Date` would add a timezone this comparison
 * does not have and does not want.
 */
export function overlaps(a: SingleValuedEdge, b: SingleValuedEdge): boolean {
  const aStartsBeforeBEnds = a.start_date == null || b.end_date == null || a.start_date <= b.end_date;
  const bStartsBeforeAEnds = b.start_date == null || a.end_date == null || b.start_date <= a.end_date;

  return aStartsBeforeBEnds && bStartsBeforeAEnds;
}

/**
 * Group a slice's edges and return the groups that contradict themselves.
 *
 * ── Why `>1` in a group is a CONTRADICTION and not a duplicate ─────────────
 *
 * `relationships_unique_directed_idx` is
 * `UNIQUE (from_entity_id, to_entity_id, relationship_type) WHERE is_active = TRUE`.
 * Two active rows sharing `(from, type)` therefore CANNOT share a target — the
 * database refuses to store that — so every group of size >1 is a group with
 * distinct targets. That is the whole reason this shape is worth a stage: the
 * one thing a naive "more than one row" rule normally finds, and drowns in, is
 * duplicates, and here duplicates are unrepresentable.
 *
 * The group is still collapsed to ONE ROW PER TARGET before anything else
 * happens, defensively and cheaply: the index is partial, so a future writer
 * that flips `is_active` inside a transaction could in principle present two
 * rows to one target to a reader mid-flight, and a "contradiction" whose two
 * members name the same place is the duplicate shape this stage exists not to
 * report.
 *
 * Collapsing FIRST, rather than filtering the duplicates out afterwards, is
 * what makes each of the three guards below load-bearing on its own: after the
 * collapse a member IS an answer, `other !== edge` excludes only the trivial
 * self-overlap, and `< 2` means "fewer than two simultaneous answers" in both
 * places it appears. Written the other way round — overlap first, de-duplicate
 * after — the target test inside the filter and the de-duplication are two
 * spellings of one rule, and removing either changes no outcome the schema
 * permits, which is a guard that cannot be tested.
 *
 * ── Pure, and O(answers^2) on purpose ─────────────────────────────────────
 *
 * The all-pairs overlap test is quadratic in a GROUP's size, not in the slice's.
 * A group is the number of simultaneous homes one person is recorded as having;
 * if that number is ever large enough for the quadratic to matter, the number
 * itself is the finding.
 *
 * Pure so the rule is testable with no database at all — which is what makes
 * the neutralisation check in this stage's spec meaningful rather than a mock
 * asserting against itself.
 */
export function findContradictions(edges: readonly SingleValuedEdge[]): EdgeContradiction[] {
  const groups = new Map<string, SingleValuedEdge[]>();

  for (const edge of edges) {
    // NUL-separated so a type containing the separator cannot forge a group
    // boundary. The CHECK constraint already forbids it; the separator costs
    // nothing.
    const key = `${edge.from_entity_id}\u0000${edge.relationship_type}`;
    const bucket = groups.get(key);

    if (bucket == null) {
      groups.set(key, [edge]);
    } else {
      bucket.push(edge);
    }
  }

  const contradictions: EdgeContradiction[] = [];

  for (const bucket of groups.values()) {
    // One row per target: after this line an element is an ANSWER, not an edge,
    // and two answers to one target — which the unique index forbids and this
    // guards against anyway — can never be mistaken for a contradiction.
    const byTarget = new Map<string, SingleValuedEdge>();

    for (const edge of bucket) {
      if (!byTarget.has(edge.to_entity_id)) {
        byTarget.set(edge.to_entity_id, edge);
      }
    }

    const answers = [...byTarget.values()];

    if (answers.length < 2) {
      continue;
    }

    // `other !== edge` excludes the self-overlap and nothing else: every
    // remaining pair is two DIFFERENT targets, because the collapse above made
    // that true.
    const participating = answers.filter((edge) =>
      answers.some((other) => other !== edge && overlaps(edge, other)),
    );

    if (participating.length < 2) {
      // Every pair in this group is separated in time. A person who lived
      // somewhere and then moved is a HISTORY, not a contradiction, and this is
      // the branch that keeps the audit from reporting one as the other.
      continue;
    }

    const members: ContradictionMember[] = participating.map((edge) => ({
      toEntityId: edge.to_entity_id,
      relationshipId: edge.relationship_id,
      startDate: edge.start_date,
      endDate: edge.end_date,
    }));

    const [first] = bucket;

    contradictions.push({
      fromEntityId: first.from_entity_id,
      relationshipType: first.relationship_type,
      members,
      undated: members.every((member) => member.startDate == null && member.endDate == null),
    });
  }

  return contradictions;
}

/** The `ci.actions.metadata->>'key'` a contradiction is deduped on. */
export function conflictAlertKey(contradiction: EdgeContradiction): string {
  return `${CONFLICT_REASON}:${contradiction.relationshipType}:${contradiction.fromEntityId}`;
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/**
 * COUNTS contradictory single-valued relationships. Repairs none of them.
 *
 * ── What this stage is for ─────────────────────────────────────────────────
 *
 * `ci.relationships` has no notion of a fact ceasing to be true. There is
 * `is_active`, and nothing sets it to `FALSE` when a newer, incompatible edge
 * arrives. The obvious fix is supersession — close the incumbent, record what
 * closed it — and that is a large change touching every writer, so it has to be
 * EARNED. This stage is the evidence for whether it is worth earning: one
 * `GROUP BY`, a count, and no writer at all.
 *
 * The precedent is exact and it is why the count comes first. `ci.facts` shipped
 * `valid_from`, `valid_until`, `supersedes_fact_id` and `is_current`, plus two
 * indexes for them (`facts_current_idx`, `facts_supersedes_idx`), in
 * `20250925151400_create_document_chunks_facts.sql`. Nothing ever wrote a single
 * one of those columns, and the whole table was dropped in
 * `20260212191500_drop_unused_tables_and_document_chunk_function.sql`. A
 * supersession schema built on the assumption that contradictions are common is
 * a schema that gets deleted if they are not.
 *
 * So: no `SUPERSEDES` edge, no `valid_from`/`valid_to` column, no writer
 * touched, no incumbent closed. If this stage reports zero on real corpora, the
 * larger work is not worth doing and the cheapest possible thing was spent
 * finding that out.
 *
 * ── The reachable case that motivated it ──────────────────────────────────
 *
 * `KnownPlacesService.upsertSelfRelationship` keys its `ON CONFLICT` on
 * `(from_entity_id, to_entity_id, relationship_type) WHERE is_active = TRUE` —
 * the columns of `relationships_unique_directed_idx`. Confirming a NEW home is
 * a different `to_entity_id`, so it does not conflict, so it INSERTS; and no
 * code path deactivates the previous `LIVES_IN`. `getKnownPlaces(context,
 * 'home')` returns a list and `HomeConfirmService` asks only whether that list
 * is non-empty, so the appliance goes on reporting that home is labelled while
 * holding two answers to where it is.
 *
 * ── How much the temporal half can actually see: almost nothing ───────────
 *
 * The rule is "more than one active edge of a declared single-valued type, to
 * different targets, whose validity intervals OVERLAP". On this corpus the
 * overlap test degenerates to "both undated", because `KnownPlacesService` is
 * the ONLY writer in the repo that supplies `start_date`/`end_date` at all.
 * Every other one omits both columns from its INSERT — `DerivedRelationshipService`
 * (~:221 `communicates_with`, ~:331 `frequents`, ~:432/~:445 the household
 * legs) and `DeterministicEdgeBackfillService` (~:358, the whole edge matrix).
 * `RelationshipNormalizeService` carries the columns through but only ever
 * copies what a victim row already had.
 *
 * So "ranges overlap or are both null" is, in practice, "both null", and this
 * stage is really answering *"more than one active edge of a single-valued
 * type"*. That is less precise than the rule reads, and it is why
 * {@link EdgeContradiction.undated} exists and is counted separately: a report
 * of N contradictions of which N are undated is a report about missing dates as
 * much as about contradictions.
 *
 * ── The live query, for when the ledger's watermark is not what you want ───
 *
 * ```sql
 * SELECT r.from_entity_id, r.relationship_type, count(*) AS active_edges
 *   FROM ci.relationships r
 *  WHERE r.owner_user_id = $1
 *    AND r.is_active = TRUE
 *    AND r.relationship_type IN ('LIVES_IN')
 *  GROUP BY 1, 2
 * HAVING count(*) > 1;
 * ```
 *
 * That is the whole detector, minus the date test. It is written out here
 * because an operator asking "how bad is it right now?" should not have to
 * schedule a sweep to find out.
 *
 * ── Outcomes ───────────────────────────────────────────────────────────────
 *
 *  - `done` (no reason) — audited, and every declared type this subject holds
 *    has exactly one active answer. The clean case, and the denominator.
 *  - `done: single_valued_conflict` — audited, and it contradicts itself. The
 *    number this PR exists to produce. `done` rather than `skipped` because the
 *    stage did its job; see {@link CONFLICT_REASON} on why the answer rides in
 *    `reason` and not in `detail`.
 *  - `skipped: no_single_valued_edges` — the subject holds none. Reachable only
 *    as a race: the sweep's `EXISTS` clause already excludes it, and the edge
 *    can be deactivated between the sweep and the slice.
 *  - `skipped: source_row_missing` — deleted, deactivated or merged away between
 *    the sweep and the slice.
 *  - `failed: conflict_alert_failed` — the contradiction was found, the card was
 *    not written. Retryable, and safe to retry: the detection is a read and the
 *    card is deduped on its key.
 */
@Injectable()
export class SingleValuedEdgeAuditStage implements Stage {
  readonly id = CLEAN_SINGLE_VALUED_EDGE_AUDIT_STAGE_ID;

  /** Resolved once at construction; see `GeocodeStage` on why not a getter. */
  readonly version = singleValuedEdgeAuditStageVersion();

  /**
   * `pipeline-index`: one SELECT per slice, plus at most
   * {@link MAX_ALERTS_PER_SLICE} card writes. No provider, no Ollama, nothing
   * metered.
   */
  readonly queue = PIPELINE_QUEUES.INDEX;

  readonly entityTypes = [ENTITY_TYPE] as const;

  readonly source = SINGLE_VALUED_EDGE_AUDIT_SOURCE;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly actionService: ActionService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SingleValuedEdgeAuditStage.name);
  }

  /**
   * Audit one slice of subjects.
   *
   * Idempotent by construction: the detection is a pure function of a read, and
   * the only write is a card that is deduped on
   * {@link conflictAlertKey} within {@link CONFLICT_ALERT_REPEAT_DAYS}.
   */
  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    const subjects = await this.loadSubjects(ctx.userId, ids);

    for (const id of ids) {
      if (!subjects.has(id)) {
        // Deleted, deactivated, tombstoned by a merge, or re-owned between the
        // sweep and the slice. A skip: nothing to retry.
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    const examined = ids.filter((id) => subjects.has(id));

    if (examined.length === 0) {
      return results;
    }

    const edges = await this.loadEdges(ctx.userId, examined);
    const contradictions = findContradictions(edges);

    /** Subjects holding at least one active edge of a declared type. */
    const withEdges = new Set(edges.map((edge) => edge.from_entity_id));
    const contradictedBySubject = new Map<string, EdgeContradiction[]>();

    for (const contradiction of contradictions) {
      const bucket = contradictedBySubject.get(contradiction.fromEntityId);

      if (bucket == null) {
        contradictedBySubject.set(contradiction.fromEntityId, [contradiction]);
      } else {
        bucket.push(contradiction);
      }
    }

    if (contradictions.length > 0) {
      // The count, unconditionally, before any flag can suppress anything. This
      // log line is the fallback evidence when `actions` is off.
      this.logger.warn('Single-valued relationship contradictions found', {
        userId: ctx.userId,
        subjects: contradictedBySubject.size,
        contradictions: contradictions.length,
        undated: contradictions.filter((contradiction) => contradiction.undated).length,
        types: [...new Set(contradictions.map((contradiction) => contradiction.relationshipType))],
      });
    }

    const alertFailures = await this.raiseAlerts(ctx.userId, contradictions);

    for (const id of examined) {
      if (results.has(id)) {
        continue;
      }

      if (alertFailures.has(id)) {
        results.set(id, {
          outcome: 'failed',
          reason: 'conflict_alert_failed',
          detail: { message: alertFailures.get(id) },
        });

        continue;
      }

      if (!withEdges.has(id)) {
        // The sweep's EXISTS clause already excludes this; it is reachable only
        // when the last declared edge was deactivated between sweep and slice.
        results.set(id, { outcome: 'skipped', reason: 'no_single_valued_edges' });

        continue;
      }

      const found = contradictedBySubject.get(id);

      if (found == null) {
        // Audited and clean. THE DENOMINATOR — a `done` with no reason is what
        // makes the conflict count a fraction of something rather than a
        // number on its own.
        results.set(id, { outcome: 'done', detail: { contradictions: 0 } });

        continue;
      }

      results.set(id, {
        outcome: 'done',
        reason: CONFLICT_REASON,
        detail: {
          contradictions: found.length,
          types: found.map((contradiction) => contradiction.relationshipType),
          undated: found.every((contradiction) => contradiction.undated),
        },
      });
    }

    return results;
  }

  /**
   * Which of the slice's ids are still live entities owned by this user.
   *
   * Re-applies the applicability predicate at slice time, deliberately. The
   * sweep already filtered, but a slice can arrive from a dead letter replayed
   * weeks later, by which time a subject may have been merged away — and
   * telling somebody their contradictory homes belong to a tombstone is worse
   * than saying nothing.
   *
   * The EXISTS half is deliberately NOT re-applied here: `loadEdges` answers the
   * same question with the rows it returns, and asking twice would make
   * `no_single_valued_edges` depend on which of two statements ran first.
   *
   * User-scoped for the reason every stage is: re-scoping is the difference
   * between "this id is not yours" and reading someone else's graph.
   */
  private async loadSubjects(userId: string, ids: string[]): Promise<Set<string>> {
    const rows = await this.dataSource.query<Array<{ entity_id: string }>>(
      `SELECT e.entity_id
         FROM ci.entities e
        WHERE e.entity_id = ANY($1::uuid[])
          AND e.owner_user_id = $2::uuid
          AND COALESCE(e.is_active, true) = true
          AND e.merged_into_entity_id IS NULL`,
      [ids, userId],
    );

    return new Set(rows.map((row) => String(row.entity_id)));
  }

  /**
   * Every active outgoing edge of a declared single-valued type, for the slice.
   *
   * ── Scoped on `r.owner_user_id`, and why that is complete ─────────────────
   *
   * The column is nullable (`REFERENCES users(id) ON DELETE SET NULL`), so a
   * strict equality could in principle hide rows. It does not: every writer in
   * the repo sets it — `KnownPlacesService` (~:492), `DerivedRelationshipService`
   * (~:221, ~:331, ~:432, ~:445), `DeterministicEdgeBackfillService` (~:358),
   * `RelationshipNormalizeService` (~:160, carried from the victim row) and
   * `RelationshipService` through the entity. A NULL owner means the owning USER
   * row was deleted, and auditing a deleted user's graph is not this stage's
   * business. Strict scoping is the safe direction: the failure mode of the
   * loose one is reading another user's edges.
   *
   * ── `::text` on the dates, deliberately ───────────────────────────────────
   *
   * `DATE` comes back from node-postgres as a JS `Date` at host-local midnight,
   * which is a timezone this comparison neither has nor wants. The cast gives
   * `YYYY-MM-DD`: fixed-width, zero-padded and big-endian, so the string
   * comparison in {@link overlaps} IS the chronological one.
   *
   * The type list is interpolated from {@link DECLARED_TYPES_SQL}, an in-repo
   * literal validated against the table's own CHECK pattern at module load. It
   * is not a bind parameter because it must also appear, identically, in the
   * sweep's applicability predicate, which `StageSource` interpolates verbatim
   * and cannot bind at all — one source for both.
   */
  private loadEdges(userId: string, ids: string[]): Promise<SingleValuedEdge[]> {
    if (DECLARED_TYPES.length === 0) {
      return Promise.resolve([]);
    }

    return this.dataSource.query<SingleValuedEdge[]>(
      `SELECT r.from_entity_id,
              r.relationship_type,
              r.to_entity_id,
              r.relationship_id,
              r.start_date::text AS start_date,
              r.end_date::text   AS end_date
         FROM ci.relationships r
        WHERE r.owner_user_id = $2::uuid
          AND r.from_entity_id = ANY($1::uuid[])
          AND r.is_active = TRUE
          AND r.relationship_type IN (${DECLARED_TYPES_SQL})
        ORDER BY r.from_entity_id, r.relationship_type, r.to_entity_id`,
      [ids, userId],
    );
  }

  /**
   * One card per contradicted `(subject, type)`, capped, deduped, flag-gated.
   *
   * Returns the subject ids whose card could not be written, mapped to the
   * error — the caller fails exactly those, and nothing else. One subject's
   * failed card must not cost the rest of the slice its audit.
   *
   * Three deliberate splits, all borrowed from `RetrievalHealthCron`, which is
   * the only other producer of infrastructure cards on this appliance:
   *
   *  1. MEASURING is unconditional and ALERTING is behind the `actions` flag.
   *     The count is already in the ledger and the log before this method runs;
   *     turning cards off must not turn the measurement off.
   *  2. NOT gated by the trust dial. The dial rates inferences the appliance
   *     draws about the USER. This is a `GROUP BY` reporting that the appliance's
   *     own graph holds two answers to one question — a fact about the machine,
   *     with nothing to be less than certain about. Placement is still the dial's
   *     call one hop downstream, in `FeedQueuePopulationListener`.
   *  3. `source: 'legacy'`, NOT `'anomaly'`/`'suggestion'`. Those two share a cap
   *     of three cards per local day (`ActionService.countDerivedOnLocalDay`) that
   *     the Brief's engines are counting on, and an infrastructure alert must not
   *     spend it.
   */
  private async raiseAlerts(
    userId: string,
    contradictions: readonly EdgeContradiction[],
  ): Promise<Map<string, string>> {
    const failures = new Map<string, string>();

    if (contradictions.length === 0) {
      return failures;
    }

    if (!(await this.featureService.isFeatureEnabled('actions'))) {
      // The ledger and the log already carry the count; only the cards are
      // suppressed.
      this.logger.warn('Single-valued contradiction cards suppressed: actions feature disabled', {
        userId,
        contradictions: contradictions.length,
      });

      return failures;
    }

    const context = toServiceContext({ userId });

    for (const contradiction of contradictions.slice(0, MAX_ALERTS_PER_SLICE)) {
      const key = conflictAlertKey(contradiction);

      try {
        if (await this.hasRecentAlert(userId, key)) {
          continue;
        }

        await this.actionService.create(context, {
          title: 'Two answers to the same question',
          text:
            `Your graph holds ${contradiction.members.length} active ` +
            `${contradiction.relationshipType} relationships at once, and only one of them can be ` +
            `current. Nothing has been changed — this is a report.`,
          source: 'legacy',
          metadata: {
            key,
            kind: 'single_valued_edge_conflict',
            relationshipType: contradiction.relationshipType,
            fromEntityId: contradiction.fromEntityId,
            // The card is the audit trail: without the ids, "you have two homes"
            // is not actionable by the person reading it.
            members: contradiction.members,
            undated: contradiction.undated,
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        failures.set(contradiction.fromEntityId, message);

        this.logger.error(
          `Failed to raise single-valued contradiction card for ${key}`,
          err instanceof Error ? err : new Error(message),
        );
      }
    }

    return failures;
  }

  /** True when this user was already told about this contradiction inside the repeat window. */
  private async hasRecentAlert(userId: string, key: string): Promise<boolean> {
    const rows = (await this.dataSource.query(
      `SELECT 1
         FROM ci.actions
        WHERE user_id = $1
          AND metadata->>'key' = $2
          AND created_at >= now() - make_interval(days => $3)
        LIMIT 1`,
      [userId, key, CONFLICT_ALERT_REPEAT_DAYS],
    )) as unknown[];

    return rows.length > 0;
  }
}
