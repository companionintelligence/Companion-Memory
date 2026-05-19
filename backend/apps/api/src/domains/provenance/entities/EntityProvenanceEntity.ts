import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export type ProvenanceKind = 'user' | 'etl' | 'agent' | 'inferred' | 'skill' | 'migration' | 'legacy';

abstract class ProvenanceBase {
  @Column({ type: 'text' })
  kind!: ProvenanceKind;

  @Column({ type: 'text', nullable: true })
  source_provider!: string | null;

  @Column({ type: 'text', nullable: true })
  source_id!: string | null;

  @Column({ type: 'text', nullable: true })
  source_uri!: string | null;

  @Column({ type: 'uuid', nullable: true })
  ingest_run_id!: string | null;

  @Column({ type: 'text', nullable: true })
  model!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'ingested_at' })
  ingested_at!: Date;

  @Column({ type: 'real', nullable: true })
  source_confidence!: number | null;

  @Column({ type: 'text', nullable: true })
  raw_excerpt_hash!: string | null;
}

@Entity({ schema: 'ci', name: 'entity_provenance' })
export class EntityProvenanceEntity extends ProvenanceBase {
  @PrimaryColumn('uuid')
  entity_id!: string;
}

@Entity({ schema: 'ci', name: 'relationship_provenance' })
export class RelationshipProvenanceEntity extends ProvenanceBase {
  @PrimaryColumn('uuid')
  relationship_id!: string;
}

@Entity({ schema: 'ci', name: 'fact_provenance' })
export class FactProvenanceEntity extends ProvenanceBase {
  @PrimaryColumn('uuid')
  fact_id!: string;
}
