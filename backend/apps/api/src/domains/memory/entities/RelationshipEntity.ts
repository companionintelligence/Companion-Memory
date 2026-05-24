import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity({ schema: 'ci', name: 'relationships' })
export class RelationshipEntity {
  @PrimaryColumn('uuid')
  relationship_id!: string;

  @Column({ type: 'uuid' })
  from_entity_id!: string;

  @Column({ type: 'uuid' })
  to_entity_id!: string;

  @Column({ type: 'text' })
  relationship_type!: string;

  @Column({ type: 'double precision', default: 1.0 })
  strength!: number;

  @Column({ type: 'jsonb', default: '{}' })
  properties!: Record<string, unknown>;

  @Column({ type: 'boolean', default: false })
  is_bidirectional!: boolean;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'date', nullable: true })
  start_date!: Date | null;

  @Column({ type: 'date', nullable: true })
  end_date!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  owner_user_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
