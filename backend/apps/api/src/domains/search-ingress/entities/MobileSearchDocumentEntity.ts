import { Entity, Column, CreateDateColumn, UpdateDateColumn, PrimaryColumn } from 'typeorm';

/**
 * `ci_search.mobile_search_documents` — the plain-text projection of a `ci_search.vectors`
 * row, replicated to devices by PowerSync and searched there with FTS5
 * (migration 20261019212935). Written only beside the tsvector, by the shared
 * statement in `VectorService`; `id` is the vectors row's id with ON DELETE
 * CASCADE, so there is no remove path of its own.
 */
@Entity({ schema: 'ci_search', name: 'mobile_search_documents' })
export class MobileSearchDocumentEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text', name: 'entity_type' })
  entityType!: string;

  @Column({ type: 'uuid', name: 'entity_id' })
  entityId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  /** The first weight-A text of the row's search document: a name, a subject, a filename. */
  @Column({ type: 'text', default: '' })
  title!: string;

  /** The rest of the search document, cut at {@link DOCUMENT_BODY_MAX_CHARS}. */
  @Column({ type: 'text', default: '' })
  body!: string;

  /** The row's own time (sent, started, taken, written); NULL for types without one. */
  @Column({ type: 'timestamptz', name: 'occurred_at', nullable: true })
  occurredAt!: Date | null;

  /**
   * The row this one belongs with: a message's conversation (a uuid v5 of user,
   * source and thread id), a sub-event's parent, a file's parent... See
   * search-next `entityDeviceRecordSql` (migration 20261021203300).
   */
  @Column({ type: 'uuid', name: 'related_id', nullable: true })
  relatedId!: string | null;

  /** Per-type display fields for the offline record page; NULL when a type has none. */
  @Column({ type: 'jsonb', nullable: true })
  detail!: Record<string, unknown> | null;

  /** Which `DEVICE_RECORD_VERSION` derived `relatedId` / `detail`. Server only; not synced. */
  @Column({ type: 'smallint', name: 'detail_version', default: 0 })
  detailVersion!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}

/** How much of a search document's body a device carries. */
export const DOCUMENT_BODY_MAX_CHARS = 1024;
