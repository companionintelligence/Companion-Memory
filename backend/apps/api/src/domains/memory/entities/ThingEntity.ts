import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  AfterLoad,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';

import { UserEntity } from '@ci/domains/user';

import { EventEntity } from './EventEntity';

@Entity({ schema: 'ci', name: 'entities' })
export class ThingEntity {
  @PrimaryColumn('uuid', { name: 'entity_id' })
  id!: string;

  @Column({ type: 'text', name: 'entity_type', default: 'Object' })
  entity_type!: string;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  properties!: Record<string, unknown>;

  // Backward compatibility fields - populated from properties JSONB after load
  type!: string | null;

  external_id!: string | null;

  source_url!: string | null;

  source_data!: Record<string, unknown> | null;

  @AfterLoad()
  loadPropertiesFromJsonb() {
    this.type = (this.properties?.type as string) || null;
    this.external_id = (this.properties?.external_id as string) || null;
    this.source_url = (this.properties?.source_url as string) || null;
    this.source_data = (this.properties?.source_data as Record<string, unknown>) || null;
  }

  // Helper method for creating filtered queries
  static createThingQuery(
    repository: Repository<ThingEntity>,
    alias: string = 'thing',
  ): SelectQueryBuilder<ThingEntity> {
    return repository
      .createQueryBuilder(alias)
      .where(`${alias}.entity_type = :entityType`, { entityType: 'Object' });
  }

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @ManyToOne(() => EventEntity, { nullable: true })
  @JoinColumn({ name: 'event_id' })
  event?: EventEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
