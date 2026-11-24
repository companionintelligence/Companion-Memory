import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * An edge from a staged item to either an entity or another item. Mirrors
 * migration 20260810164304_create_ci_import_schema.
 *
 * A row carries EITHER {@link entityId} (item→entity, e.g. email→sender) OR
 * {@link relatedItemId} (item→item, e.g. email→attachment, photo→album) — never
 * both and never neither. Upstream that was a convention every consumer had to
 * know; here `staged_relationships_one_target` makes it a database constraint.
 * A query that joins on `entityId` still skips item↔item rows naturally.
 *
 * Edge writes are idempotent by constraint rather than by a read-then-write.
 * Upstream did `SELECT … WHERE relation IS ?` before each insert so a NULL
 * relation matched its own prior row; the two partial unique indexes behind this
 * entity are `NULLS NOT DISTINCT`, which is that same semantic as a constraint —
 * and turns the write into a plain `ON CONFLICT`.
 */
@Entity({ schema: 'ci_import', name: 'staged_relationships' })
@Index('staged_relationships_entity_idx', ['entityId'])
// The two columns that cascade from staged_items (migration
// 20261113093810_index_staged_relationships_cascade): without them every
// deleted staged item scanned this whole table.
@Index('staged_relationships_item_idx', ['itemId'])
@Index('staged_relationships_related_item_idx', ['relatedItemId'], { where: '"related_item_id" IS NOT NULL' })
export class StagedRelationshipEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'run_id' })
  runId!: string;

  /** The edge's origin. Always an item; entities are never a source here. */
  @Column({ type: 'uuid', name: 'item_id' })
  itemId!: string;

  /** Set for item→entity edges; NULL for item→item ones. */
  @Column({ type: 'uuid', name: 'entity_id', nullable: true })
  entityId!: string | null;

  /** Set for item→item edges; NULL for item→entity ones. */
  @Column({ type: 'uuid', name: 'related_item_id', nullable: true })
  relatedItemId!: string | null;

  /**
   * What the edge means ('from', 'to', 'cc', 'attachment', 'album'). Nullable,
   * and a NULL is a real value that deduplicates against its own prior row
   * rather than being distinct from it.
   */
  @Column({ type: 'text', nullable: true })
  relation!: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}

export type StagedRelationship = Readonly<StagedRelationshipEntity>;
