import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'entities' })
export class GraphNodeEntity {
  @PrimaryColumn('uuid')
  entity_id!: string;

  @Column({ type: 'text' })
  entity_type!: string;

  @Column({ type: 'uuid', array: true, default: '{}' })
  outgoing_relationships!: string[];

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  properties!: Record<string, unknown>;

  @Column({
    type: 'text',
    nullable: true,
    transformer: {
      to: (v: number[] | null) => (v ? `[${v.join(',')}]` : null),
      from: (v: string | null) => (v ? v.slice(1, -1).split(',').map(Number) : null),
    },
  })
  embedding!: number[] | null;

  @Column({ type: 'text', nullable: true })
  search_content!: string | null;

  @Column({ type: 'text', nullable: true })
  linked_table!: string | null;

  @Column({ type: 'uuid', nullable: true })
  linked_id!: string | null;

  @Column({ type: 'uuid', nullable: true })
  owner_user_id!: string | null;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'boolean', default: false })
  is_archived!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  last_accessed!: Date;
}
