import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
// The graph domain's PUBLIC barrel, not its internals: `no-cross-domain-internals`
// allows exactly `index.ts` and `events.ts` across a domain boundary.
//
// `normalizeIdentifier` is imported rather than re-implemented, and that is the
// single most important line in this file. Its own header states the contract:
// it is "the single source of truth for the rule shared by the importer ... and
// the server", and "the two MUST stay byte-identical or the people-linking
// lookup silently misses". A cleaner that normalised by its own rule would
// rewrite `value_normalized` into a form no lookup in either repo computes, and
// people-linking would stop matching with no error anywhere.
import { hasPhoneExtension, normalizeIdentifier, type IdentifierKind } from '@ci/domains/graph';

import { PIPELINE_QUEUES } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, type StageVersion } from '../../versions';

/**
 * This stage's id.
 *
 * Declared locally ahead of its `STAGE_IDS` entry, as every stage written before
 * its wiring has been; `__tests__/stageWiring.spec.ts` fails by name until the
 * four central entries land. IDS ARE PERMANENT.
 */
export const CLEAN_IDENTIFIER_NORMALIZE_STAGE_ID = 'clean.identifier_normalize';

/** The ledger `entity_type` this stage records under. */
const ENTITY_TYPE = 'entity';

// ---------------------------------------------------------------------------
// The version
// ---------------------------------------------------------------------------

/**
 * Generation of the SHARED normalization rule —
 * `domains/graph/utils/normalizeIdentifier.ts`.
 *
 * Bump it in the same commit that changes `normalizeEmail`, `normalizePhone` or
 * `normalizeName`, because that is exactly when every `value_normalized` in the
 * corpus becomes provisional. This is the whole reason the stage exists: without
 * it, improving the rule fixes only rows written afterwards.
 *
 * This rule used to also live in CI-Import-Tools, which required bumping both
 * copies together or the two would drift and the lookup would silently miss.
 * That repo is now retired (its import functionality is native here, in
 * `backend/apps/api/src/domains/import/`) and this is the only copy left.
 *
 * v2 — `normalizePhone` refuses a value carrying an extension
 * (`hasPhoneExtension`) instead of keeping the last ten digits of number and
 * extension run together: `(212) 555-0147;229` had keyed as `5550147229`. The
 * bump re-opens every entity and restamps `spec_version`, but it CANNOT repair
 * what this stage finds: a stored row whose `raw_value` carries the extension
 * now normalizes to nothing and is reported `identifiers_unnormalizable` (this
 * stage never deletes), and the importer's rows have `raw_value IS NULL` — their
 * truncated key is a fixed point of the new rule. Migration
 * `20260930020117_refuse_phone_extension_join_keys` removes both kinds.
 */
export const IDENTIFIER_RULE_GENERATION = 2;

/**
 * Generation of THIS stage's E.164 derivation — {@link toE164}.
 *
 * Separate from the rule generation because they improve independently: adding
 * a declared home region (see {@link toE164}) should not re-run email
 * normalization, and a fix to `normalizeName` should not re-derive phones.
 *
 * v2 — {@link toE164} refuses every extension form `hasPhoneExtension` names,
 * not only a trailing `x`/`ext`: `+1 (212) 555-0147;229` had derived the
 * fourteen-digit `+12125550147229`.
 */
export const E164_RULE_GENERATION = 2;

/**
 * The stage version, derived so improving EITHER re-runs history.
 *
 * ── Why NOT `IDENTITY_SPEC_VERSION` ────────────────────────────────────────
 *
 * The rebuild plan says "`clean.identifier_normalize.version` tracks
 * `IDENTITY_SPEC_VERSION`". That constant
 * (`domains/identity/types.ts`, currently 1) versions the OBJECT identity ladder
 * — `canonicalizeUrl`, `buildNaturalKey`, GTIN/ISBN/IMEI — and has nothing to do
 * with the person-identifier rule this stage runs. Tying the two together would
 * be wrong in both directions: bumping URL canonicalisation would re-normalize
 * every phone number for no reason, and improving `normalizeIdentifier` would
 * NOT re-open the corpus, which is the precise defect the ledger exists to
 * remove. The plan's line should be read as "it tracks the rule it runs"; the
 * rule it runs is the one imported at the top of this file.
 *
 * A SUM, offset so both-at-1 gives 1, and monotone in each term so the version
 * can only go UP.
 */
export const IDENTIFIER_NORMALIZE_VERSION = IDENTIFIER_RULE_GENERATION + E164_RULE_GENERATION - 1;

/**
 * The version this stage reports, cross-checked against `STAGE_VERSIONS`.
 *
 * A missing entry is not an error (this file precedes the central declaration);
 * a disagreeing one throws here, where the fix is one line.
 */
export function identifierNormalizeStageVersion(
  versions: Record<string, StageVersion> = STAGE_VERSIONS,
): number {
  const declared = versions[CLEAN_IDENTIFIER_NORMALIZE_STAGE_ID];

  if (typeof declared === 'number' && declared !== IDENTIFIER_NORMALIZE_VERSION) {
    throw new Error(
      `STAGE_VERSIONS["${CLEAN_IDENTIFIER_NORMALIZE_STAGE_ID}"] declares ${declared} but the stage ` +
        `derives ${IDENTIFIER_NORMALIZE_VERSION} from IDENTIFIER_RULE_GENERATION ` +
        `(${IDENTIFIER_RULE_GENERATION}) + E164_RULE_GENERATION (${E164_RULE_GENERATION}) - 1. ` +
        `Bumping a generation is only half the change: update versions.ts in the same commit.`,
    );
  }

  return IDENTIFIER_NORMALIZE_VERSION;
}

// Module load, not first sweep.
identifierNormalizeStageVersion();

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * Where the sweep looks for candidates, and which of those rows this stage
 * APPLIES to.
 *
 * The sweep pages over ENTITIES, not over identifier rows, for a structural
 * reason: `ci.entity_identifiers` has no single-column identity — its natural
 * key is `(owner_user_id, kind, value_normalized)` and its only uuid column is
 * `entity_id`, which is not unique in it. `StageSource.idColumn` becomes
 * `ci.pipeline_state.entity_id`, which is typed and part of the primary key, so
 * paging over the identifier table directly would key several rows' outcomes
 * onto one ledger cell and lose all but the last.
 *
 * Sweeping the owner instead is also the more useful unit: the answer the ledger
 * then holds is "this entity's identifiers are normalized at rule generation N",
 * which is what identity work needs to know.
 *
 * ── What is NOT in this predicate ─────────────────────────────────────────
 *
 * Nothing about `value_normalized`, `value_e164` or `spec_version`. All three
 * are this stage's OUTPUT.
 *
 * `spec_version` deserves the explicit note, because
 * `20260809183010_identifier_claims` has just added it to
 * `ci.entity_identifiers` and its column comment proposes exactly the predicate
 * this file refuses: *"`spec_version < $current` re-opens the row for
 * recompute"*. As PROVENANCE the column is right and this stage writes it. As
 * CANDIDATE SELECTION it is the ratchet with a version bolted on — one column
 * per stage per table, no way to express "tried and correctly changed nothing",
 * and nowhere to put a reason. The pipeline README's "Why 'just add a column'
 * was not enough" is the long form. `ci.pipeline_state` answers all three, so
 * the sweep asks the ledger and the column stays a fact about the row.
 *
 * `merged_into_entity_id IS NULL` is applicability, not completion: a tombstone
 * is a redirect, its identifiers were repointed by the merge, and this stage
 * never writes that column.
 */
export const IDENTIFIER_NORMALIZE_SOURCE: StageSource = {
  schema: 'ci',
  table: 'entities',
  idColumn: 'entity_id',
  userColumn: 'owner_user_id',
  predicate: `COALESCE(s.is_active, true) = true AND s.merged_into_entity_id IS NULL`,
};

// ---------------------------------------------------------------------------
// E.164 — derived only where it is DERIVABLE
// ---------------------------------------------------------------------------

/** E.164 allows at most 15 digits; a subscriber number is never shorter than 8. */
const E164_MIN_DIGITS = 8;
const E164_MAX_DIGITS = 15;

/** North American Numbering Plan: country code 1, then a 10-digit number. */
const NANP_LENGTH = 11;

/**
 * The strict international form of a phone number, or `null` when it cannot be
 * derived WITHOUT GUESSING A COUNTRY.
 *
 * ── Why this is written alongside `value_normalized`, never instead of it ──
 *
 * The shared rule (`normalizePhone`) keeps the LAST TEN DIGITS and throws the
 * country code away. That is lossy in a way that actively creates false
 * identities: a UK `+44 20 7946 0958` and a US `(207) 946-0958` both normalize
 * to `2079460958` and become the same person. E.164 is the fix.
 *
 * But `value_normalized` is a JOIN KEY, computed at every lookup by
 * `classifyParticipant` and — until CI-Import-Tools' retirement — shared
 * byte-for-byte with that repo's own copy of the same rule. Redefining it
 * here silently breaks people-linking against every row already written with
 * the old rule — no error, no dead letter, just matches that stop happening.
 * So the canonical form goes in its own column and the join key is left
 * alone. Promoting `value_e164` to be the key is a later, reviewable change,
 * and a version bump when it happens.
 *
 * ── Why no default region ─────────────────────────────────────────────────
 *
 * A bare ten-digit number is only E.164-able against an assumed country. There
 * is no per-user home region on this appliance (`ci.users` has `timezone` and
 * `language`, neither of which is a dialling region), so assuming `+1` would
 * stamp a fabricated country code onto every number in the corpus and make it
 * look measured. `StageResult.confidence` names that failure exactly: an
 * enricher reporting a number because it felt right teaches everything
 * downstream to trust it.
 *
 * So: derived when the raw value SAYS the country, null otherwise, and the
 * "otherwise" is counted rather than guessed. Adding `ci.users.phone_region` and
 * bumping {@link E164_RULE_GENERATION} converts those nulls in one commit —
 * which is what the ledger is for.
 *
 * The duplicate detector's phone tier (`memory/utils/phoneIdentity.ts`) does
 * infer a country, and it is not a contradiction of the above: it infers only
 * NANP, only under a region derived from the owner's own numbers or an
 * explicit list of North American time zones AND corroborated by the corpus,
 * only for a valid geographic number, and never where anything in the corpus
 * states the same digits with another country. A stated form always
 * overrides that inference, and it writes nothing back: `value_e164` stays
 * stated-only. `DuplicateDetectStage.spec` pins that module's stated form to
 * this function's.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null;
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return null;
  }

  // An extension makes the subscriber number ambiguous and E.164 has no place to
  // put one. Refused rather than truncated — by the SAME test the join key uses,
  // so the two can never disagree about which values are one number. (The
  // private pattern this replaced caught only a trailing `x`/`ext`, and turned
  // `+1 (212) 555-0147;229` into a fourteen-digit "E.164".)
  if (hasPhoneExtension(trimmed)) {
    return null;
  }

  const digits = trimmed.replace(/\D/g, '');

  if (digits.length === 0) {
    return null;
  }

  // `+<cc><number>` — the country is stated.
  if (trimmed.startsWith('+')) {
    return digits.length >= E164_MIN_DIGITS && digits.length <= E164_MAX_DIGITS ? `+${digits}` : null;
  }

  // `00<cc><number>` — the ITU international prefix. Also states the country.
  if (digits.startsWith('00') && digits.length > 2) {
    const international = digits.slice(2);

    return international.length >= E164_MIN_DIGITS && international.length <= E164_MAX_DIGITS
      ? `+${international}`
      : null;
  }

  // `1NXXNXXXXXX` — eleven digits led by 1 is NANP by construction; no other
  // country code is a bare leading 1.
  if (digits.length === NANP_LENGTH && digits.startsWith('1')) {
    return `+${digits}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// The per-identifier decision — pure
// ---------------------------------------------------------------------------

/** One identifier row as the slice load projects it. */
export interface IdentifierRow {
  entity_id: string;
  kind: string;
  /** The current join key. Part of the row's natural key, so also its address. */
  value_normalized: string;
  /** What the source actually supplied. NULL when no writer retained it. */
  raw_value: string | null;
}

/** What one identifier row should become. */
export interface IdentifierPatch {
  entityId: string;
  kind: string;
  /** The value to match on — the row's current natural key. */
  currentValue: string;
  /** The value the current rule produces. Equal to `currentValue` when correct. */
  target: string;
  /** Strict international form, or null when the raw value did not state a country. */
  e164: string | null;
}

/**
 * Kinds this stage can normalize — i.e. the kinds the SHARED rule implements.
 *
 * A strict SUBSET of what `ci.entity_identifiers.kind` now permits.
 * `20260809183010_identifier_claims` widened that CHECK to
 * `('email','phone','handle','name')`, but `normalizeIdentifier` still has three
 * branches: `IdentifierKind` is `'email' | 'phone' | 'name'` and a handle routes
 * through `normalizeName`.
 *
 * `handle` is therefore reported `unnormalizable` rather than folded through the
 * name rule, and that is deliberate. `normalizeName` NFKD-folds, strips
 * diacritics and collapses whitespace — reasonable for a human display name and
 * wrong for a namespaced handle, where `x:@alice` and `X:@Alice` may or may not
 * be the same account depending on the platform, and where case is significant
 * on some. Guessing would write a value no lookup computes, which is the one
 * failure this stage exists to avoid.
 *
 * The fix is a `normalizeHandle` branch in
 * `domains/graph/utils/normalizeIdentifier.ts` plus a bump of
 * {@link IDENTIFIER_RULE_GENERATION}, which
 * re-opens every row skipped here. Until then the count of
 * `identifiers_unnormalizable` IS the size of that job.
 */
const SUPPORTED_KINDS: ReadonlySet<string> = new Set<IdentifierKind>(['email', 'phone', 'name']);

/**
 * Recompute one identifier row under the current rule.
 *
 * Returns `null` when the row cannot be normalized at all — an unsupported kind,
 * or a value the rule rejects (empty after trimming, a "phone" with no digits).
 * Such a row is REPORTED, never deleted: it is a real row somebody wrote, and
 * removing it would be this stage deciding a question it was not asked.
 *
 * ── Idempotent by construction ────────────────────────────────────────────
 *
 * The normalizers are idempotent — `normalizeEmail(normalizeEmail(x)) ===
 * normalizeEmail(x)`, and likewise for phone and name — so re-running over an
 * already-converged corpus computes the same target and changes nothing. That
 * property is what lets the fallback below be safe: when `raw_value` is NULL the
 * current `value_normalized` is fed back through the rule, and for a row that is
 * already a fixed point the answer is itself.
 *
 * The fallback is strictly weaker than the real thing and it is worth being
 * clear about why: normalization is lossy, so a value that lost its country code
 * or its display name cannot get them back. It can only be checked for being a
 * fixed point of the CURRENT rule — which is exactly the class of damage a rule
 * change causes, and therefore the class this stage is for.
 */
export function normalizeOne(row: IdentifierRow): IdentifierPatch | null {
  if (!SUPPORTED_KINDS.has(row.kind)) {
    return null;
  }

  const kind = row.kind as IdentifierKind;
  const origin = row.raw_value ?? row.value_normalized;
  const target = normalizeIdentifier(kind, origin);

  if (target == null || target.length === 0) {
    return null;
  }

  return {
    entityId: row.entity_id,
    kind,
    currentValue: row.value_normalized,
    target,
    // E.164 is derived from the RAW value only. `value_normalized` for a phone
    // has already had its country code removed by `normalizePhone`, so deriving
    // from it would produce a confident international number out of a number
    // whose country is gone.
    e164: kind === 'phone' ? toE164(row.raw_value) : null,
  };
}

/**
 * Drop patches that would collide with each other inside one statement.
 *
 * `entity_identifiers_owner_kind_value_uniq` is UNIQUE on
 * `(owner_user_id, kind, value_normalized)`. Two of an entity's identifiers can
 * legitimately converge under the rule — `"+1 (415) 555-0100"` and
 * `"415.555.0100"` both become `4155550100` — and a single `UPDATE … FROM
 * unnest(...)` that moved both would raise a unique violation and take the
 * WHOLE SLICE down, charging 200 healthy entities an attempt for one merge.
 *
 * The in-statement conflict cannot be caught by the SQL guard, because
 * `NOT EXISTS` reads the pre-statement snapshot and both rows pass it. So it is
 * resolved here: the first patch for a given `(kind, target)` proceeds and the
 * rest are returned as `converged` — reported, and left exactly as they are.
 * Deleting the redundant row is the obvious "fix" and is refused: two identifier
 * rows collapsing into one is a DUPLICATE FINDING, and this domain proposes
 * findings rather than resolving them.
 *
 * Deterministic in slice order, so a re-run keeps the same winner.
 */
export function resolveConvergence(patches: readonly IdentifierPatch[]): {
  writable: IdentifierPatch[];
  converged: IdentifierPatch[];
} {
  const claimed = new Set<string>();
  const writable: IdentifierPatch[] = [];
  const converged: IdentifierPatch[] = [];

  for (const patch of patches) {
    const key = `${patch.kind}|${patch.target}`;

    if (claimed.has(key)) {
      converged.push(patch);

      continue;
    }

    claimed.add(key);
    writable.push(patch);
  }

  return { writable, converged };
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/** What happened to one entity's identifiers, before it becomes a `StageResult`. */
interface EntityTally {
  examined: number;
  /** `value_normalized` moved. */
  repaired: number;
  /** Already a fixed point of the rule. */
  unchanged: number;
  /** `value_e164` written. */
  e164: number;
  /** Blocked by another entity already holding the target value. */
  collided: number;
  /** Blocked by a sibling identifier of the same entity converging on it. */
  converged: number;
  /** Kind unsupported, or the rule rejected the value. */
  unnormalizable: number;
}

/**
 * Canonicalises the identifiers already stored, so identity work runs over a
 * consistent corpus.
 *
 * ── Nothing here is destructive, and here is the accounting ────────────────
 *
 * `value_normalized` is a DERIVED column: it is `normalizeIdentifier(kind,
 * raw_value)` and nothing else. Recomputing a derived column from a retained
 * original is not destruction — `raw_value` is the original and this stage never
 * writes it. That is the justification for updating in place rather than writing
 * a correction row, and it is the only place in the CLEAN phase where an
 * in-place write is taken.
 *
 * The two cases where the original was NOT retained are handled separately and
 * neither loses anything:
 *
 *  - `raw_value IS NULL` — the rule is applied to the current normalized value,
 *    which can only confirm or repair a fixed point (see {@link normalizeOne}).
 *  - a value the rule rejects — reported as `unnormalizable`, left untouched.
 *
 * And nothing is ever deleted. Two identifiers converging on one value is left
 * as two rows and counted, because that is a duplicate finding and
 * `clean.duplicate_detect` is where findings go.
 *
 * ── The collision is the interesting outcome ──────────────────────────────
 *
 * `(owner_user_id, kind, value_normalized)` is UNIQUE, so if entity A's
 * identifier normalizes onto a value entity B already holds, the write CANNOT
 * happen — and the reason it cannot is that A and B are probably the same
 * person. The stage refuses the write, leaves both rows intact, and records the
 * entity `skipped: normalization_collides`. That reason is persisted (unlike
 * `detail`, which the ledger validates and drops), so the collisions are a
 * countable, queryable list rather than a log line, and
 * `clean.duplicate_detect` finds the same pair independently from
 * `ci.identifier_claims`, which has no such unique constraint.
 *
 * ── Outcomes ───────────────────────────────────────────────────────────────
 *
 *  - `done` — every identifier this entity has is at the current generation.
 *  - `skipped: no_identifiers` — the entity has none. The overwhelming majority
 *    on an appliance where `enrich.person_link` has not run yet, and countable
 *    precisely so that is visible.
 *  - `skipped: normalization_collides` — at least one identifier could not move
 *    because another entity holds the target value. See above. `skipped` here
 *    means "did not fully converge", not "wrote nothing": the entity's other
 *    identifiers were written, which is safe because every write is idempotent
 *    and a later generation redoes them harmlessly.
 *  - `skipped: identifiers_unnormalizable` — every identifier is of a kind or a
 *    shape the rule cannot handle.
 *  - `skipped: source_row_missing` — deleted or re-owned between sweep and slice.
 *  - `failed: identifier_write_failed` — the statement did not commit. Retryable.
 */
@Injectable()
export class IdentifierNormalizeStage implements Stage {
  readonly id = CLEAN_IDENTIFIER_NORMALIZE_STAGE_ID;

  /** Resolved once at construction; see `GeocodeStage` on why not a getter. */
  readonly version = identifierNormalizeStageVersion();

  /** `pipeline-index`: pure string work plus two Postgres statements per slice. */
  readonly queue = PIPELINE_QUEUES.INDEX;

  readonly entityTypes = [ENTITY_TYPE] as const;

  readonly source = IDENTIFIER_NORMALIZE_SOURCE;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(IdentifierNormalizeStage.name);
  }

  /**
   * Normalize one slice of entities' identifiers.
   *
   * Idempotent by construction, in the strong sense: the normalizers are fixed
   * points, so a second run over a converged corpus computes the same targets,
   * the `WHERE ei.value_normalized = u.current_value` clause matches the rows
   * that are already correct, and the UPDATE writes the values they already
   * hold. Two workers racing the same entity cost one redundant statement.
   */
  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    const rows = await this.loadIdentifiers(ctx.userId, ids);
    const present = await this.loadPresentEntities(ctx.userId, ids);

    for (const id of ids) {
      if (!present.has(id)) {
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    const tallies = new Map<string, EntityTally>();

    for (const id of ids) {
      if (present.has(id)) {
        tallies.set(id, {
          examined: 0,
          repaired: 0,
          unchanged: 0,
          e164: 0,
          collided: 0,
          converged: 0,
          unnormalizable: 0,
        });
      }
    }

    const patches: IdentifierPatch[] = [];

    for (const row of rows) {
      const tally = tallies.get(row.entity_id);

      if (tally == null) {
        // An identifier whose entity failed the slice-time applicability check.
        continue;
      }

      tally.examined += 1;

      const patch = normalizeOne(row);

      if (patch == null) {
        tally.unnormalizable += 1;

        continue;
      }

      patches.push(patch);
    }

    const { writable, converged } = resolveConvergence(patches);

    for (const patch of converged) {
      const tally = tallies.get(patch.entityId);

      if (tally != null) {
        tally.converged += 1;
      }
    }

    if (writable.length > 0) {
      try {
        const written = await this.writeIdentifiers(ctx.userId, writable);

        for (const patch of writable) {
          const tally = tallies.get(patch.entityId);

          if (tally == null) {
            continue;
          }

          if (!written.has(`${patch.entityId}|${patch.kind}|${patch.target}`)) {
            // The guarded UPDATE matched nothing for this patch: another entity
            // already holds the target value.
            tally.collided += 1;

            continue;
          }

          if (patch.target === patch.currentValue) {
            tally.unchanged += 1;
          } else {
            tally.repaired += 1;
          }

          if (patch.e164 != null) {
            tally.e164 += 1;
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        // One statement, one verdict: every entity that contributed a patch
        // shares it. FAILED, so the retry gate and attempt budget apply.
        for (const patch of writable) {
          if (present.has(patch.entityId)) {
            results.set(patch.entityId, {
              outcome: 'failed',
              reason: 'identifier_write_failed',
              detail: { message },
            });
          }
        }

        this.logger.error(
          `Identifier normalization write failed for ${writable.length} identifiers`,
          err instanceof Error ? err : new Error(message),
        );
      }
    }

    for (const [id, tally] of tallies) {
      if (results.has(id)) {
        continue;
      }

      results.set(id, resultFor(tally));
    }

    return results;
  }

  /**
   * Which of the slice's ids are still live entities owned by this user.
   *
   * Re-applies the applicability predicate at slice time for the reason every
   * stage does: a slice can arrive from a dead letter replayed weeks later, by
   * which time the entity may have been merged away.
   */
  private async loadPresentEntities(userId: string, ids: string[]): Promise<Set<string>> {
    const rows = await this.dataSource.query<Array<{ entity_id: string }>>(
      `SELECT e.entity_id
         FROM ci.entities e
        WHERE e.entity_id = ANY($1::uuid[])
          AND e.owner_user_id = $2::uuid
          AND COALESCE(e.is_active, true) = true
          AND e.merged_into_entity_id IS NULL`,
      [ids, userId],
    );

    return new Set(rows.map((row) => row.entity_id));
  }

  /**
   * Every identifier belonging to the slice's entities, in one statement.
   *
   * Ordered so {@link resolveConvergence} picks a deterministic winner when two
   * of an entity's identifiers converge: the same slice re-run chooses the same
   * row to move, so a retry does not oscillate between them.
   */
  private loadIdentifiers(userId: string, ids: string[]): Promise<IdentifierRow[]> {
    return this.dataSource.query<IdentifierRow[]>(
      `SELECT ei.entity_id, ei.kind, ei.value_normalized, ei.raw_value
         FROM ci.entity_identifiers ei
        WHERE ei.entity_id = ANY($1::uuid[])
          AND ei.owner_user_id = $2::uuid
        ORDER BY ei.entity_id, ei.kind, ei.value_normalized`,
      [ids, userId],
    );
  }

  /**
   * Write every patch in ONE statement, and report which ones landed.
   *
   * ── The `NOT EXISTS` guard is what makes this non-destructive ─────────────
   *
   * `(owner_user_id, kind, value_normalized)` is UNIQUE. An unguarded UPDATE
   * that moved A's identifier onto a value B already holds would raise a unique
   * violation and fail the whole slice; an `ON CONFLICT DO NOTHING` variant
   * would need this to be an upsert and would silently drop the row. The guard
   * makes the collision a NON-EVENT at the database and a REPORTED one in the
   * ledger: the row stays where it is, both entities keep their identifiers, and
   * the pair surfaces as `skipped: normalization_collides`.
   *
   * The guard is skipped when `u.target = u.current_value`, because a row
   * "colliding" with itself is the ordinary no-move case and must still get its
   * `value_e164`.
   *
   * ── `WITH … SELECT`, not a bare `UPDATE … RETURNING` ──────────────────────
   *
   * TypeORM's `query()` returns the driver's rows for a SELECT and for an
   * `INSERT … RETURNING`, but the PAIR `[rows, rowCount]` for an
   * `UPDATE … RETURNING`. `EstimateLocationStage` documents the same measurement.
   * Wrapping in a CTE keeps the shape a plain array.
   *
   * The returned set is how a collision is detected: a patch whose key is absent
   * from it did not land. That is a report of what the database actually did,
   * not a prediction — which matters because the guard's subquery and the update
   * race every other writer of this table.
   */
  private async writeIdentifiers(userId: string, patches: IdentifierPatch[]): Promise<Set<string>> {
    const rows = await this.dataSource.query<
      Array<{ entity_id: string; kind: string; value_normalized: string }>
    >(
      `WITH normalized AS (
         UPDATE ci.entity_identifiers ei
            SET value_normalized = u.target,
                value_e164       = u.e164,
                spec_version     = $7::int
           FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[])
                AS u(entity_id, kind, current_value, target, e164)
          WHERE ei.owner_user_id = $6::uuid
            AND ei.entity_id = u.entity_id
            AND ei.kind = u.kind
            AND ei.value_normalized = u.current_value
            AND (u.target = u.current_value
                 OR NOT EXISTS (
                      SELECT 1
                        FROM ci.entity_identifiers other
                       WHERE other.owner_user_id = $6::uuid
                         AND other.kind = u.kind
                         AND other.value_normalized = u.target))
        RETURNING ei.entity_id, ei.kind, ei.value_normalized
       )
       SELECT * FROM normalized`,
      [
        patches.map((patch) => patch.entityId),
        patches.map((patch) => patch.kind),
        patches.map((patch) => patch.currentValue),
        patches.map((patch) => patch.target),
        patches.map((patch) => patch.e164),
        userId,
        // The NORMALISATION rule generation, not the stage version. They differ
        // the moment `E164_RULE_GENERATION` moves on its own: that changes
        // `value_e164` and leaves `value_normalized` untouched, so stamping the
        // stage version here would claim the shared rule had changed when it had
        // not — and `spec_version` is a fact about `value_normalized`.
        IDENTIFIER_RULE_GENERATION,
      ],
    );

    return new Set(rows.map((row) => `${row.entity_id}|${row.kind}|${row.value_normalized}`));
  }
}

/**
 * Turn one entity's tally into its ledger answer.
 *
 * Ordered by how much a reviewer needs to know: a collision is a finding and
 * outranks "nothing to do", which outranks a clean pass.
 */
function resultFor(tally: EntityTally): StageResult {
  if (tally.examined === 0) {
    return { outcome: 'skipped', reason: 'no_identifiers' };
  }

  if (tally.collided > 0 || tally.converged > 0) {
    return {
      outcome: 'skipped',
      reason: 'normalization_collides',
      detail: {
        collided: tally.collided,
        converged: tally.converged,
        repaired: tally.repaired,
        examined: tally.examined,
      },
    };
  }

  if (tally.unnormalizable === tally.examined) {
    return {
      outcome: 'skipped',
      reason: 'identifiers_unnormalizable',
      detail: { examined: tally.examined },
    };
  }

  return {
    outcome: 'done',
    detail: {
      examined: tally.examined,
      repaired: tally.repaired,
      unchanged: tally.unchanged,
      e164: tally.e164,
      unnormalizable: tally.unnormalizable,
    },
  };
}
