import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * An item↔item graph edge from the importer (email→attachment, photo→album).
 *
 * Both endpoints are referenced by their PROVENANCE TRIPLE
 * (source_type, source_system, source_id) rather than a CI-Server row id, because
 * one importer item may land in ci.events / ci.communications / ci.content /
 * ci.inventory depending on its kind — the triple is the table-agnostic handle
 * both sides already share. Rows dedup on
 * (user_id, from-triple, to-triple, relation) — see the item_relationships_edge_uniq
 * index and ItemRelationshipService.createMany's ON CONFLICT DO NOTHING.
 */
@Entity({ schema: 'ci', name: 'item_relationships' })
export class ItemRelationshipEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'from_source_type', type: 'text' })
  fromSourceType!: string;

  @Column({ name: 'from_source_system', type: 'text' })
  fromSourceSystem!: string;

  @Column({ name: 'from_source_id', type: 'text' })
  fromSourceId!: string;

  @Column({ name: 'to_source_type', type: 'text' })
  toSourceType!: string;

  @Column({ name: 'to_source_system', type: 'text' })
  toSourceSystem!: string;

  @Column({ name: 'to_source_id', type: 'text' })
  toSourceId!: string;

  @Column({ type: 'text' })
  relation!: string;

  @Column({ type: 'jsonb', default: '{}' })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

export type ItemRelationship = Readonly<ItemRelationshipEntity>;
