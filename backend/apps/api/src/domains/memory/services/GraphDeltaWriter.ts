import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { computeChunkSize } from '@ci/common/persistence';

export type GraphDeltaChangeType = 'created' | 'updated' | 'archived' | 'deleted' | 'merged';
export type GraphDeltaNodeType = 'entity' | 'relationship';

export interface GraphDeltaChangedField {
  old?: unknown;
  new?: unknown;
}

export interface RecordGraphDeltaInput {
  nodeType: GraphDeltaNodeType;
  changeType: GraphDeltaChangeType;
  ownerUserId: string | null | undefined;
  entityId?: string | null;
  entityType?: string | null;
  relationshipId?: string | null;
  relationshipType?: string | null;
  fromEntityId?: string | null;
  toEntityId?: string | null;
  changedFields?: Record<string, GraphDeltaChangedField>;
  /** Defaults to `app`. Prefer a service name for observability. */
  changeSource?: string | null;
  changeReason?: string | null;
  changedByUserId?: string | null;
  /** Share the domain write's transaction when provided. */
  manager?: EntityManager;
}

/** A value with its object keys sorted, so two jsonb reads of one bag compare equal. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

/**
 * The `changedFields` of an edit: each of `keys` whose value differs between
 * `before` and `after`, as `{ old, new }`. Missing, null, '' and [] are all "empty",
 * so a form that sends every field back unchanged records nothing.
 */
export function changedFieldsBetween(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: Iterable<string>,
): Record<string, GraphDeltaChangedField> {
  const isEmpty = (value: unknown) =>
    value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
  const changed: Record<string, GraphDeltaChangedField> = {};

  for (const key of keys) {
    const was = before[key];
    const now = after[key];

    if ((isEmpty(was) && isEmpty(now)) || sortedJson(was) === sortedJson(now)) {
      continue;
    }

    changed[key] = { old: isEmpty(was) ? null : was, new: isEmpty(now) ? null : now };
  }

  return changed;
}

/**
 * App-written trail into `ci.graph_deltas`.
 * Replaces statement-level DB triggers so writers are visible in app code
 * (logs, change_source / change_reason, metrics around this service).
 *
 * Uses SQL (not the audit-domain ORM entity) so MemoryModule can own the writer
 * without a Memory → Audit → Graph → Memory cycle.
 */
/** Parameters one `ci.graph_deltas` row binds in {@link GraphDeltaWriter.recordMany}. */
const BOUND_COLUMNS = 14;

@Injectable()
export class GraphDeltaWriter {
  constructor(
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GraphDeltaWriter.name);
  }

  async record(input: RecordGraphDeltaInput): Promise<void> {
    await this.recordMany([input], input.manager);
  }

  async recordMany(inputs: RecordGraphDeltaInput[], manager?: EntityManager): Promise<void> {
    if (inputs.length === 0) {
      return;
    }

    const runner = manager ?? this.dataSource;

    // One statement per chunk, never one for the whole list: each row binds
    // BOUND_COLUMNS parameters, and Postgres caps a statement at 65535. An
    // unchunked call of 4,873 rows (one Google Takeout push) bound 68,222, which
    // the wire protocol's 16-bit count wrapped to "bind message has 2686
    // parameter formats but 0 parameters" — failing the caller's whole batch
    // after its own rows were already written.
    const chunkSize = computeChunkSize(BOUND_COLUMNS);

    for (let offset = 0; offset < inputs.length; offset += chunkSize) {
      await this.insertChunk(runner, inputs.slice(offset, offset + chunkSize));
    }
  }

  private async insertChunk(
    runner: EntityManager | DataSource,
    inputs: RecordGraphDeltaInput[],
  ): Promise<void> {
    const bind: unknown[] = [];
    const valueSql = inputs
      .map((input, i) => {
        const b = i * BOUND_COLUMNS;
        bind.push(
          uuidv7(),
          input.entityId ?? null,
          input.relationshipId ?? null,
          input.nodeType,
          input.entityType ?? null,
          input.relationshipType ?? null,
          input.fromEntityId ?? null,
          input.toEntityId ?? null,
          input.changeType,
          JSON.stringify(input.changedFields ?? {}),
          input.changeSource ?? 'app',
          input.changeReason ?? null,
          input.changedByUserId ?? null,
          input.ownerUserId ?? null,
        );

        return `(
          $${b + 1}::uuid, $${b + 2}::uuid, $${b + 3}::uuid, $${b + 4}::text,
          $${b + 5}::text, $${b + 6}::text, $${b + 7}::uuid, $${b + 8}::uuid,
          $${b + 9}::text, $${b + 10}::jsonb, $${b + 11}::text, $${b + 12}::text,
          $${b + 13}::uuid, $${b + 14}::uuid
        )`;
      })
      .join(', ');

    const sql = `
      INSERT INTO ci.graph_deltas (
        delta_id, entity_id, relationship_id, node_type, entity_type,
        relationship_type, from_entity_id, to_entity_id, change_type,
        changed_fields, change_source, change_reason, changed_by_user_id,
        owner_user_id
      ) VALUES ${valueSql}
    `;

    try {
      await runner.query(sql, bind);
      this.logger.debug('Recorded graph deltas', {
        count: inputs.length,
        changeSource: inputs[0]?.changeSource ?? 'app',
        changeTypes: [...new Set(inputs.map((r) => r.changeType))],
      });
    } catch (error) {
      this.logger.error('Failed to record graph deltas', {
        count: inputs.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Entity create with the name anchor insight renderers expect. */
  entityCreated(args: {
    entityId: string;
    entityType: string;
    name: string | null | undefined;
    description?: string | null;
    properties?: Record<string, unknown> | null;
    ownerUserId: string | null | undefined;
    changeSource: string;
    changeReason?: string | null;
    changedByUserId?: string | null;
    manager?: EntityManager;
  }): Promise<void> {
    return this.record({
      nodeType: 'entity',
      changeType: 'created',
      entityId: args.entityId,
      entityType: args.entityType,
      ownerUserId: args.ownerUserId,
      changeSource: args.changeSource,
      changeReason: args.changeReason,
      changedByUserId: args.changedByUserId,
      manager: args.manager,
      changedFields: {
        name: { new: args.name ?? null },
        description: { new: args.description ?? null },
        entity_type: { new: args.entityType },
        properties: { new: args.properties ?? {} },
      },
    });
  }

  /**
   * `changedFields` is stored as given. It used to gain a `name` entry with the
   * current name on both sides when the caller sent none, which put an
   * `old == new` pair in every edit's delta that the panel then had to hide.
   */
  entityUpdated(args: {
    entityId: string;
    entityType: string;
    name: string | null | undefined;
    changedFields: Record<string, GraphDeltaChangedField>;
    ownerUserId: string | null | undefined;
    changeSource: string;
    changeReason?: string | null;
    changedByUserId?: string | null;
    manager?: EntityManager;
  }): Promise<void> {
    return this.record({
      nodeType: 'entity',
      changeType: 'updated',
      entityId: args.entityId,
      entityType: args.entityType,
      ownerUserId: args.ownerUserId,
      changeSource: args.changeSource,
      changeReason: args.changeReason,
      changedByUserId: args.changedByUserId,
      manager: args.manager,
      changedFields: args.changedFields,
    });
  }

  entityDeleted(args: {
    entityId: string;
    entityType: string;
    name: string | null | undefined;
    ownerUserId: string | null | undefined;
    changeSource: string;
    changeReason?: string | null;
    changedByUserId?: string | null;
    manager?: EntityManager;
  }): Promise<void> {
    return this.record({
      nodeType: 'entity',
      changeType: 'deleted',
      entityId: args.entityId,
      entityType: args.entityType,
      ownerUserId: args.ownerUserId,
      changeSource: args.changeSource,
      changeReason: args.changeReason,
      changedByUserId: args.changedByUserId,
      manager: args.manager,
      changedFields: {
        name: { old: args.name ?? null },
      },
    });
  }
}
