import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { toServiceContext } from '@ci/common/context';
import {
  EntityIdentifierService,
  GraphIngestService,
  normalizeIdentifier,
  type EntityIdentifierBatchEntry,
} from '@ci/domains/graph';
import { LoggerService } from '@ci/common/logging';

const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 5000;

export interface EntityIdentifierBackfillOptions {
  /** Maximum number of Person rows read per page. */
  pageSize?: number;
}

export interface EntityIdentifierBackfillResult {
  /** Active, unmerged Person rows examined. */
  examined: number;
  /** Distinct normalized identifiers found in Person properties. */
  identifiersSeen: number;
  /** Person rows that carried at least one indexable identifier. */
  entitiesWithIdentifiers: number;
  /** Identifier rows inserted into ci.entity_identifiers. */
  identifiersIndexed: number;
  /** The owner's canonical self Person, after self repair/provisioning. */
  selfEntityId: string | null;
  /** Non-fatal page/indexing errors. */
  errors: string[];
}

interface PersonPropertyRow {
  entity_id: string;
  created_at: Date | string;
  properties: Record<string, unknown> | null;
}

/**
 * Repairs the derived identity index from the source-of-truth Person rows.
 *
 * Older imports can leave `properties.emails` / `properties.phones` on
 * `ci.entities` while missing the corresponding `ci.entity_identifiers` rows.
 * That makes communications and events look like unknown people even though
 * the imported graph already contains the contact methods. This job only adds
 * derived index rows and repairs the owner's self marker; it never deletes,
 * merges, or rewrites source Person data.
 */
@Injectable()
export class EntityIdentifierBackfillService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly entityIdentifierService: EntityIdentifierService,
    private readonly graphIngestService: GraphIngestService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EntityIdentifierBackfillService.name);
  }

  async backfill(
    userId: string,
    options: EntityIdentifierBackfillOptions = {},
  ): Promise<EntityIdentifierBackfillResult> {
    const pageSize = Math.min(Math.max(options.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const result: EntityIdentifierBackfillResult = {
      examined: 0,
      identifiersSeen: 0,
      entitiesWithIdentifiers: 0,
      identifiersIndexed: 0,
      selfEntityId: null,
      errors: [],
    };
    const seenIdentifiers = new Set<string>();

    try {
      const self = await this.graphIngestService.ensureSelfEntityForOwner(toServiceContext({ userId }));
      result.selfEntityId = self?.id ?? null;
    } catch (error) {
      result.errors.push(`self repair: ${error instanceof Error ? error.message : String(error)}`);
    }

    let cursorTime: string | null = null;
    let cursorId: string | null = null;

    for (;;) {
      let rows: PersonPropertyRow[];
      try {
        rows = await this.dataSource.query(
          `SELECT entity_id, created_at, properties
             FROM ci.entities
            WHERE owner_user_id = $1::uuid
              AND entity_type = 'Person'
              AND is_active IS DISTINCT FROM FALSE
              AND merged_into_entity_id IS NULL
              AND ($2::timestamptz IS NULL OR (created_at, entity_id) > ($2::timestamptz, $3::uuid))
            ORDER BY created_at ASC, entity_id ASC
            LIMIT $4`,
          [userId, cursorTime, cursorId, pageSize],
        );
      } catch (error) {
        result.errors.push(`read page: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }

      if (rows.length === 0) {
        break;
      }

      result.examined += rows.length;
      const entries: EntityIdentifierBatchEntry[] = [];

      for (const row of rows) {
        const raw = identifierProperties(row.properties);
        if (raw == null) {
          continue;
        }

        result.entitiesWithIdentifiers += 1;
        for (const [kind, values] of identifierValues(raw)) {
          for (const value of values) {
            const normalized = normalizeIdentifier(kind, value);
            if (normalized != null) {
              seenIdentifiers.add(`${kind}:${normalized}`);
            }
          }
        }

        entries.push({
          entityId: row.entity_id,
          raw,
          source: 'backfill:entity-properties',
        });
      }

      if (entries.length > 0) {
        try {
          result.identifiersIndexed += await this.entityIdentifierService.upsertForEntities(userId, entries);
        } catch (error) {
          result.errors.push(`index page: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const last = rows[rows.length - 1];
      cursorTime = new Date(last.created_at).toISOString();
      cursorId = last.entity_id;

      if (rows.length < pageSize) {
        break;
      }
    }

    result.identifiersSeen = seenIdentifiers.size;
    this.logger.log('Entity identifier backfill complete', {
      userId,
      examined: result.examined,
      entitiesWithIdentifiers: result.entitiesWithIdentifiers,
      identifiersSeen: result.identifiersSeen,
      identifiersIndexed: result.identifiersIndexed,
      selfEntityId: result.selfEntityId,
      errors: result.errors.length,
    });

    return result;
  }
}

type IdentifierKind = 'email' | 'phone' | 'name';

function identifierProperties(
  properties: Record<string, unknown> | null,
): { emails?: unknown; phones?: unknown; names?: unknown } | null {
  if (properties == null) {
    return null;
  }

  const emails = usableValues('email', stringValues(properties.emails ?? properties.email));
  const phones = usableValues('phone', stringValues(properties.phones ?? properties.phone));
  const names = usableValues('name', stringValues(properties.names));

  if (emails.length === 0 && phones.length === 0 && names.length === 0) {
    return null;
  }

  return {
    ...(emails.length > 0 ? { emails } : {}),
    ...(phones.length > 0 ? { phones } : {}),
    ...(names.length > 0 ? { names } : {}),
  };
}

function identifierValues(raw: {
  emails?: unknown;
  phones?: unknown;
  names?: unknown;
}): Array<[IdentifierKind, string[]]> {
  return [
    ['email', stringValues(raw.emails)],
    ['phone', stringValues(raw.phones)],
    ['name', stringValues(raw.names)],
  ];
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function usableValues(kind: IdentifierKind, values: string[]): string[] {
  return values.filter((value) => normalizeIdentifier(kind, value) != null);
}
