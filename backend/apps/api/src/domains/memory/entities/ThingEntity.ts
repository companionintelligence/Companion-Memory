import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToMany,
  ManyToOne,
  JoinColumn,
  JoinTable,
} from 'typeorm';

import { TagEntity } from '@ci/domains/search';
import { UserEntity } from '@ci/domains/user';

import { EventEntity } from './EventEntity';

@Entity({ name: 'things' })
export class ThingEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text', nullable: true })
  type!: string | null;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true })
  external_id!: string | null;

  @Column({ type: 'text', nullable: true })
  source_url!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  source_data!: Record<string, unknown> | null;

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @ManyToOne(() => EventEntity, { nullable: true })
  @JoinColumn({ name: 'event_id' })
  event?: EventEntity;

  @ManyToMany(() => TagEntity, { nullable: true })
  @JoinTable({
    name: 'thing_tag',
    joinColumn: { name: 'thing_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'tag_id', referencedColumnName: 'id' },
  })
  tags?: TagEntity[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
