import { Entity, Column, CreateDateColumn, PrimaryColumn } from 'typeorm';

/**
 * Marker that a `(entity_type, entity_id)` was examined by a search-index
 * listener and intentionally NOT embedded (low-value content — see
 * `embedSkipReason`). The backfill sweep anti-joins this table so skipped rows
 * are not re-enqueued forever; a successful embed upsert deletes the marker.
 */
@Entity({ schema: 'ci_search', name: 'index_skips' })
export class IndexSkipEntity {
  @PrimaryColumn({ type: 'text', name: 'entity_type' })
  entityType!: string;

  @PrimaryColumn({ type: 'uuid', name: 'entity_id' })
  entityId!: string;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
