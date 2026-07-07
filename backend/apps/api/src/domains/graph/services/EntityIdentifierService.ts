import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { computeChunkSize } from '@ci/common/persistence';

import { EntityIdentifierEntity } from '../entities/EntityIdentifierEntity';
import { type IdentifierKind, normalizeIdentifier } from '../utils/normalizeIdentifier';

/** A normalized (kind, value) pair used as a lookup key. */
export interface IdentifierKey {
  kind: IdentifierKind;
  valueNormalized: string;
}

/** One entity's raw identifier payload within a {@link EntityIdentifierService.upsertForEntities} batch. */
export interface EntityIdentifierBatchEntry {
  entityId: string;
  raw: { emails?: unknown; phones?: unknown; names?: unknown };
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
          .execute();

        // `identifiers` lists only the rows that were actually inserted.
        inserted += result.identifiers.length;
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
