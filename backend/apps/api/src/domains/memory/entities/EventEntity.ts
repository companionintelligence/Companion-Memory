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

import { ConnectionEntity } from '@ci/domains/connections';
import { TagEntity } from '@ci/domains/search';
import { UserEntity } from '@ci/domains/user';

@Entity({ name: 'events' })
export class EventEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text', nullable: true })
  type!: string | null;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  start_time!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  end_time!: Date | null;

  @Column({ type: 'text', nullable: true })
  external_id!: string | null;

  @Column({ type: 'text', nullable: true })
  source_url!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  source_data!: Record<string, unknown> | null;

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @ManyToOne(() => ConnectionEntity, { nullable: true })
  @JoinColumn({ name: 'connection_id' })
  connection?: ConnectionEntity;

  @ManyToMany(() => TagEntity, { nullable: true })
  @JoinTable({
    name: 'event_tag',
    joinColumn: { name: 'event_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'tag_id', referencedColumnName: 'id' },
  })
  tags?: TagEntity[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  toEvent() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      description: this.description,
      start_time: this.start_time,
      end_time: this.end_time,
      external_id: this.external_id,
      source_url: this.source_url,
      source_data: this.source_data,
      user_id: this.user?.id,
      connection_id: this.connection?.id,
      tags: this.tags?.map((tag) => tag.toTag()),
    };
  }
}
