import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { computeChunkSize } from '@ci/common/persistence';

import { EntityIdentifierEntity } from '../entities/EntityIdentifierEntity';
import { type IdentifierKind, normalizeIdentifier } from '../utils/normalizeIdentifier';
import { isNonNameParticipant } from '../utils/participantSanity';

/** A normalized (kind, value) pair used as a lookup key. */
export interface IdentifierKey {
  kind: IdentifierKind;
  valueNormalized: string;
}

/** One entity's raw identifier payload within a {@link EntityIdentifierService.upsertForEntities} batch. */
export interface EntityIdentifierBatchEntry {
  entityId: string;
  raw: { emails?: unknown; phones?: unknown; names?: unknown };
  /** Provenance stamped onto newly-inserted identifier rows (import:<sourceSystem>, user, ...). */
  source?: string;
}

/**
 * Read/write surface for `ci.entity_identifiers`: the normalized
 * email/phone/name -> graph entity_id index that powers people-linking.
 *
 * - {@link upsertForEntities} is called from the graph-ingest entity path to
 *   register the whole batch's identifiers set-based (idempotent on the
 *   unique index); {@link upsertForEntity} is the single-entity convenience
 *   over it.
 * - {@link findEntityIdByIdentifier} / {@link findEntityIdsByIdentifiers} are
 *   the lookups the communications backfill resolves participants against.
 */
@Injectable()
export class EntityIdentifierService {
  constructor(
    @InjectRepository(EntityIdentifierEntity)
    private readonly repository: Repository<EntityIdentifierEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EntityIdentifierService.name);
  }

  /**
   * Register the given raw email/phone/name identifiers for one entity — the
   * single-entity convenience over {@link upsertForEntities}, kept for callers
   * that genuinely have one entity in hand.
   *
   * Returns the number of rows actually inserted (new identifiers).
   */
  async upsertForEntity(
    ownerUserId: string,
    entityId: string,
    raw: { emails?: unknown; phones?: unknown; names?: unknown },
  ): Promise<number> {
    return this.upsertForEntities(ownerUserId, [{ entityId, raw }]);
  }

  /**
   * Register raw email/phone/name identifiers for a whole ingest batch of
   * entities in ONE set-based INSERT (chunked to the shared bind-param
   * budget), replacing the former per-entity statement — the last per-row
   * write on the bulk graph-ingest path. Values are normalized defensively
   * (the importer pre-normalizes, but we re-apply the same rule so a
   * non-conforming or directly-written entity still indexes correctly);
   * unusable values (empty emails, digit-less phones) are skipped without
   * failing the batch.
   *
   * Idempotent: inserts ON CONFLICT DO NOTHING against the
   * (owner_user_id, kind, value_normalized) unique index
   * (entity_identifiers_owner_kind_value_uniq), so re-ingest never duplicates
   * and never throws on collision. Duplicate (kind, value) tuples across the
   * batch collapse to the FIRST entity carrying them — exactly what the
   * sequential per-entity statements produced (the first INSERT claimed the
   * tuple; later ones were ignored) — and the client-side de-dup also keeps a
   * multi-row INSERT from tripping the unique index against itself.
   *
   * A failed chunk is recorded and the remaining chunks still run (bounding a
   * transient failure's blast radius to its chunk); the first failure is then
   * rethrown so the caller's non-fatal handling (log + continue) still sees it.
   *
   * Returns the number of rows actually inserted (new identifiers).
   */
  async upsertForEntities(ownerUserId: string, entries: EntityIdentifierBatchEntry[]): Promise<number> {
    const rows: EntityIdentifierEntity[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      const collect = (kind: IdentifierKind, values: unknown) => {
        for (const candidate of toStringArray(values)) {
          // A display name that is structurally not a name must never enter the
          // index: this table's (owner, kind, value) tuple is what every
          // people-linking lookup resolves against, so a garbage `name` row is
          // not cosmetic — it is a permanent claim on that string, and the
          // Person holding it keeps being resolved to. Emails and phones go
          // through the same door because the guard also catches embedded
          // newlines, which are markup leaking through whatever the kind.
          if (isNonNameParticipant(candidate, 'EntityIdentifierService.upsertForEntities')) {
            continue;
          }

          const valueNormalized = normalizeIdentifier(kind, candidate);
          if (valueNormalized == null) {
            continue;
          }

          const dedupeKey = `${kind}:${valueNormalized}`;
          if (seen.has(dedupeKey)) {
            continue;
          }

          seen.add(dedupeKey);

          rows.push(
            this.repository.create({
              ownerUserId,
              entityId: entry.entityId,
              kind,
              valueNormalized,
              // Keep the source's original form when it differs from the
              // normalized one — cheap provenance for the contact-method UI.
              rawValue: candidate === valueNormalized ? null : candidate,
              source: entry.source ?? null,
            }),
          );
        }
      };

      collect('email', entry.raw.emails);
      collect('phone', entry.raw.phones);
      collect('name', entry.raw.names);
    }

    if (rows.length === 0) {
      return 0;
    }

    // Split into param-budget-bounded chunks so a large batch (a full
    // contacts+graph sync is 100k+ entities) never exceeds Postgres' 65535
    // bind-param limit — computeChunkSize is the same helper the entity /
    // relationship bulk upserts use.
    const chunkSize = computeChunkSize(this.repository.metadata.columns.length);
    let inserted = 0;
    const failures: string[] = [];
    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      try {
        const result = await this.repository
          .createQueryBuilder()
          .insert()
          .into(EntityIdentifierEntity)
          .values(rows.slice(offset, offset + chunkSize))
          .orIgnore() // ON CONFLICT DO NOTHING on the unique index.
          // TypeORM's `identifiers` array is populated from the input entities
          // after execution, so it also counts rows skipped by ON CONFLICT.
          // RETURNING makes the actual inserted rows observable on Postgres.
          .returning(['ownerUserId', 'kind', 'valueNormalized'])
          .execute();

        inserted += Array.isArray(result.raw) ? result.raw.length : 0;
      } catch (err) {
        failures.push((err as Error).message);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} identifier insert chunk(s) failed (${inserted} rows inserted): ${failures[0]}`,
      );
    }

    return inserted;
  }

  /**
   * Resolve a single normalized identifier to its entity_id, scoped to the
   * owner. Returns null when no identifier matches.
   */
  async findEntityIdByIdentifier(
    ownerUserId: string,
    kind: IdentifierKind,
    valueNormalized: string,
  ): Promise<string | null> {
    const row = await this.repository.findOne({
      where: { ownerUserId, kind, valueNormalized },
      select: ['entityId'],
    });

    return row?.entityId ?? null;
  }

  /**
   * Batched lookup: resolve many normalized identifiers in a single query.
   * Returns a Map keyed by `${kind}:${valueNormalized}` -> entity_id, holding
   * only the keys that matched (callers treat a missing key as "no match,
   * leave NULL"). Empty input short-circuits without a query.
   *
   * Uses a single `WHERE (kind, value_normalized) IN (...)` row-values
   * predicate scoped to owner_user_id, so N participants cost one round-trip.
   */
  async findEntityIdsByIdentifiers(ownerUserId: string, keys: IdentifierKey[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (keys.length === 0) {
      return out;
    }

    // De-dup input keys to keep the IN-list tight.
    const unique = new Map<string, IdentifierKey>();
    for (const key of keys) {
      unique.set(`${key.kind}:${key.valueNormalized}`, key);
    }

    const tuples = [...unique.values()];

    const params: unknown[] = [ownerUserId];
    const placeholders = tuples
      .map((key) => {
        params.push(key.kind, key.valueNormalized);

        return `($${params.length - 1}, $${params.length})`;
      })
      .join(', ');

    const rows: Array<{ kind: string; value_normalized: string; entity_id: string }> =
      await this.repository.manager.query(
        `SELECT kind, value_normalized, entity_id
           FROM ci.entity_identifiers
          WHERE owner_user_id = $1
            AND (kind, value_normalized) IN (${placeholders})`,
        params,
      );

    for (const row of rows) {
      out.set(`${row.kind}:${row.value_normalized}`, row.entity_id);
    }

    return out;
  }

  /**
   * All identifiers claimed by the given entities, for the contact-methods
   * read surface (PersonType.identifiers). Returns a Map entity_id -> rows,
   * ordered kind then value for stable display.
   */
  async listForEntities(
    ownerUserId: string,
    entityIds: string[],
  ): Promise<Map<string, EntityIdentifierEntity[]>> {
    const out = new Map<string, EntityIdentifierEntity[]>();
    if (entityIds.length === 0) {
      return out;
    }

    const rows = await this.repository.find({
      where: { ownerUserId, entityId: In(entityIds) },
      order: { kind: 'ASC', valueNormalized: 'ASC' },
    });

    for (const row of rows) {
      const list = out.get(row.entityId);
      if (list) {
        list.push(row);
      } else {
        out.set(row.entityId, [row]);
      }
    }

    return out;
  }

  /**
   * User-asserted identifier add (the addPersonIdentifier mutation). Normalizes
   * with the shared rule and upserts under source='user' with verified_at=now()
   * — a user assertion IS a verification. If the (kind, value) tuple is already
   * claimed by ANOTHER entity, the claim is NOT stolen (first-writer-wins, same
   * as ingest); the existing owner's id is returned so the caller can surface
   * "already belongs to X" (a merge is the right fix, not a silent re-point).
   *
   * Returns the entity id the identifier resolves to after the call (the given
   * entity on success, the prior claimant on conflict), or null when the value
   * doesn't normalize to a usable identifier.
   */
  async addForEntity(
    ownerUserId: string,
    entityId: string,
    kind: IdentifierKind,
    rawValue: string,
    label?: string | null,
  ): Promise<string | null> {
    const valueNormalized = normalizeIdentifier(kind, rawValue);
    if (valueNormalized == null) {
      return null;
    }

    await this.repository
      .createQueryBuilder()
      .insert()
      .into(EntityIdentifierEntity)
      .values({
        ownerUserId,
        entityId,
        kind,
        valueNormalized,
        rawValue: rawValue === valueNormalized ? null : rawValue,
        label: label ?? null,
        source: 'user',
        verifiedAt: () => 'now()',
      })
      .orIgnore()
      .execute();

    const row = await this.repository.findOne({
      where: { ownerUserId, kind, valueNormalized },
    });

    if (row && row.entityId === entityId && (row.label !== (label ?? null) || row.verifiedAt == null)) {
      // The tuple already existed for this same entity (a machine-asserted
      // row): promote it to user-verified and apply the label.
      await this.repository.update(
        { ownerUserId, kind, valueNormalized },
        { label: label ?? row.label, source: 'user', verifiedAt: new Date() },
      );
    }

    return row?.entityId ?? null;
  }

  /**
   * The `conflicts` {@link replaceForEntity} would report for the same
   * arguments — values of the reconciled kinds that ANOTHER entity already
   * holds — found with a read, so a caller that has to refuse the whole edit
   * can ask before anything is written. `replaceForEntity` only meets a
   * conflict at the insert, after it has deleted every row missing from
   * `desired`.
   *
   * Same normalize-and-de-dupe rule, so the same values come back: the first
   * spelling of each, in `desired` order. A value this entity already holds is
   * not a conflict, and neither is one that does not normalize —
   * `replaceForEntity` stores nothing for it.
   *
   * A read, not a lock: a value another writer claims between this call and
   * the write is still reported by `replaceForEntity` itself.
   */
  async findConflicts(
    ownerUserId: string,
    entityId: string,
    kinds: readonly IdentifierKind[],
    desired: ReadonlyArray<{ kind: IdentifierKind; value: string }>,
  ): Promise<Array<{ kind: IdentifierKind; value: string }>> {
    const firstSpelling = new Map<string, IdentifierKey & { value: string }>();

    for (const entry of desired) {
      if (!kinds.includes(entry.kind)) {
        continue;
      }

      const valueNormalized = normalizeIdentifier(entry.kind, entry.value);
      if (valueNormalized == null) {
        continue;
      }

      const key = `${entry.kind}:${valueNormalized}`;
      if (!firstSpelling.has(key)) {
        firstSpelling.set(key, { kind: entry.kind, valueNormalized, value: entry.value });
      }
    }

    const holders = await this.findEntityIdsByIdentifiers(ownerUserId, [...firstSpelling.values()]);

    const conflicts: Array<{ kind: IdentifierKind; value: string }> = [];
    for (const [key, { kind, value }] of firstSpelling) {
      const holder = holders.get(key);
      if (holder != null && holder !== entityId) {
        conflicts.push({ kind, value });
      }
    }

    return conflicts;
  }

  /**
   * Reconcile ONE entity's contact methods of the given kinds against `desired`
   * — the set-shaped counterpart to {@link addForEntity}, for a form that edits
   * the whole contact list at once.
   *
   * Adds what is new, applies labels / the primary flag, and deletes the rows
   * of those kinds that are no longer listed. Kinds absent from `kinds` are left
   * alone, so reconciling emails never touches phones (or the 'name' rows the
   * duplicate detector relies on).
   *
   * A value already claimed by ANOTHER entity is NOT stolen (first-writer-wins,
   * same as ingest and {@link addForEntity}); it is returned in `conflicts` so
   * the caller can surface "already belongs to X" instead of silently dropping
   * the user's input.
   */
  async replaceForEntity(
    ownerUserId: string,
    entityId: string,
    kinds: IdentifierKind[],
    desired: Array<{ kind: IdentifierKind; value: string; label?: string | null; isPrimary?: boolean }>,
  ): Promise<{ conflicts: Array<{ kind: IdentifierKind; value: string }> }> {
    const conflicts: Array<{ kind: IdentifierKind; value: string }> = [];
    const kindSet = new Set(kinds);

    // Normalize + de-dupe first: the form can legitimately submit the same
    // address twice (e.g. "Bo@x.com" and "bo@x.com"), and only the first wins.
    const seen = new Set<string>();
    const wanted: Array<{
      kind: IdentifierKind;
      valueNormalized: string;
      rawValue: string;
      label: string | null;
      isPrimary: boolean;
    }> = [];

    for (const entry of desired) {
      if (!kindSet.has(entry.kind)) {
        continue;
      }

      const valueNormalized = normalizeIdentifier(entry.kind, entry.value);
      if (valueNormalized == null) {
        continue;
      }

      const dedupeKey = `${entry.kind}:${valueNormalized}`;
      if (seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);
      wanted.push({
        kind: entry.kind,
        valueNormalized,
        rawValue: entry.value,
        label: entry.label?.trim() || null,
        // First of its kind wins the primary flag when nothing is marked.
        isPrimary: entry.isPrimary === true,
      });
    }

    // Exactly one primary per kind.
    for (const kind of kindSet) {
      const ofKind = wanted.filter((entry) => entry.kind === kind);
      if (ofKind.length === 0) {
        continue;
      }

      const primary = ofKind.find((entry) => entry.isPrimary) ?? ofKind[0]!;
      for (const entry of ofKind) {
        entry.isPrimary = entry === primary;
      }
    }

    const existing = await this.repository.find({ where: { ownerUserId, entityId } });

    // Drop the rows of the reconciled kinds that are no longer wanted.
    const stale = existing.filter(
      (row) => kindSet.has(row.kind) && !seen.has(`${row.kind}:${row.valueNormalized}`),
    );

    if (stale.length > 0) {
      await this.repository.delete(
        stale.map((row) => ({ ownerUserId, kind: row.kind, valueNormalized: row.valueNormalized })),
      );
    }

    for (const entry of wanted) {
      await this.repository
        .createQueryBuilder()
        .insert()
        .into(EntityIdentifierEntity)
        .values({
          ownerUserId,
          entityId,
          kind: entry.kind,
          valueNormalized: entry.valueNormalized,
          rawValue: entry.rawValue === entry.valueNormalized ? null : entry.rawValue,
          label: entry.label,
          isPrimary: entry.isPrimary,
          source: 'user',
          verifiedAt: () => 'now()',
        })
        .orIgnore()
        .execute();

      const row = await this.repository.findOne({
        where: { ownerUserId, kind: entry.kind, valueNormalized: entry.valueNormalized },
      });

      if (row == null) {
        continue;
      }

      if (row.entityId !== entityId) {
        conflicts.push({ kind: entry.kind, value: entry.rawValue });

        continue;
      }

      // The tuple already existed for this entity (machine-asserted, or an
      // edited label): promote it to user-verified and apply the form's values.
      if (row.label !== entry.label || row.isPrimary !== entry.isPrimary || row.verifiedAt == null) {
        await this.repository.update(
          { ownerUserId, kind: entry.kind, valueNormalized: entry.valueNormalized },
          {
            label: entry.label,
            isPrimary: entry.isPrimary,
            source: 'user',
            verifiedAt: row.verifiedAt ?? new Date(),
          },
        );
      }
    }

    return { conflicts };
  }

  /**
   * Remove an identifier claim from an entity. Scoped to the entity so a stale
   * UI can never delete another entity's claim. Returns true when a row was
   * deleted.
   */
  async removeForEntity(
    ownerUserId: string,
    entityId: string,
    kind: IdentifierKind,
    value: string,
  ): Promise<boolean> {
    const valueNormalized = normalizeIdentifier(kind, value) ?? value;

    const result = await this.repository.delete({
      ownerUserId,
      entityId,
      kind,
      valueNormalized,
    });

    return (result.affected ?? 0) > 0;
  }

  /**
   * Force an identifier claim onto `entityId`, stealing it from any prior
   * claimant. Used only for authoritative self collation (account email / self
   * phones) when trust policy allows — first-writer-wins must not leave the
   * owner's mailbox on a non-self stub forever.
   *
   * Returns the prior entity id when a claim was moved, null when this entity
   * already owned it or the value does not normalize.
   */
  async repointToEntity(
    ownerUserId: string,
    entityId: string,
    kind: IdentifierKind,
    rawValue: string,
    source = 'self_collation',
  ): Promise<string | null> {
    const valueNormalized = normalizeIdentifier(kind, rawValue);
    if (valueNormalized == null) {
      return null;
    }

    const existing = await this.repository.findOne({
      where: { ownerUserId, kind, valueNormalized },
    });

    if (existing == null) {
      await this.repository
        .createQueryBuilder()
        .insert()
        .into(EntityIdentifierEntity)
        .values({
          ownerUserId,
          entityId,
          kind,
          valueNormalized,
          rawValue: rawValue === valueNormalized ? null : rawValue,
          source,
          verifiedAt: () => 'now()',
        })
        .orIgnore()
        .execute();

      return null;
    }

    if (existing.entityId === entityId) {
      return null;
    }

    const prior = existing.entityId;
    await this.repository.update(
      { ownerUserId, kind, valueNormalized },
      { entityId, source, verifiedAt: new Date() },
    );

    this.logger.log('Repointed identifier claim to entity', {
      ownerUserId,
      kind,
      valueNormalized,
      fromEntityId: prior,
      toEntityId: entityId,
      source,
    });

    return prior;
  }

  /**
   * Register the owner's contact methods on the self Person (emails / names /
   * phones). Uses first-writer-wins upsert first; callers that need to steal
   * account email should follow with {@link repointToEntity}.
   */
  async claimForSelf(
    ownerUserId: string,
    selfEntityId: string,
    raw: { emails?: unknown; phones?: unknown; names?: unknown },
  ): Promise<number> {
    return this.upsertForEntities(ownerUserId, [{ entityId: selfEntityId, raw, source: 'self' }]);
  }
}

/**
 * Coerce a properties value into a string array. Accepts a string[] (the
 * contract shape), a single string, or anything else (-> []). Non-string
 * elements are dropped.
 */
function toStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }

  return [];
}
