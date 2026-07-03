import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

import { EntityIdentifierEntity } from '../entities/EntityIdentifierEntity';
import { type IdentifierKind, normalizeIdentifier } from '../utils/normalizeIdentifier';

/** A normalized (kind, value) pair used as a lookup key. */
export interface IdentifierKey {
  kind: IdentifierKind;
  valueNormalized: string;
}

/**
 * Read/write surface for `ci.entity_identifiers`: the normalized
 * email/phone -> graph entity_id index that powers people-linking.
 *
 * - {@link upsertForEntity} is called from the graph-ingest entity path to
 *   register a Person's identifiers (idempotent on the unique index).
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
   * Register the given raw email/phone identifiers for an entity. Values are
   * normalized defensively (the importer pre-normalizes, but we re-apply the
   * same rule so a non-conforming or directly-written entity still indexes
   * correctly). Idempotent: inserts ON CONFLICT DO NOTHING against the
   * (owner_user_id, kind, value_normalized) unique index, so re-ingest never
   * duplicates and never throws on collision.
   *
   * Returns the number of rows actually inserted (new identifiers).
   */
  async upsertForEntity(
    ownerUserId: string,
    entityId: string,
    raw: { emails?: unknown; phones?: unknown; names?: unknown },
  ): Promise<number> {
    const rows: EntityIdentifierEntity[] = [];
    const seen = new Set<string>();

    const collect = (kind: IdentifierKind, values: unknown) => {
      for (const candidate of toStringArray(values)) {
        const valueNormalized = normalizeIdentifier(kind, candidate);
        if (valueNormalized == null) {
          continue;
        }

        // De-dup within this batch so the multi-row insert never trips the
        // unique index against itself (which would abort the whole statement).
        const dedupeKey = `${kind}:${valueNormalized}`;
        if (seen.has(dedupeKey)) {
          continue;
        }

        seen.add(dedupeKey);

        rows.push(
          this.repository.create({
            ownerUserId,
            entityId,
            kind,
            valueNormalized,
          }),
        );
      }
    };

    collect('email', raw.emails);
    collect('phone', raw.phones);
    collect('name', raw.names);

    if (rows.length === 0) {
      return 0;
    }

    const result = await this.repository
      .createQueryBuilder()
      .insert()
      .into(EntityIdentifierEntity)
      .values(rows)
      .orIgnore() // ON CONFLICT DO NOTHING on the unique index.
      .execute();

    // `identifiers` lists only the rows that were actually inserted.
    return result.identifiers.length;
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
