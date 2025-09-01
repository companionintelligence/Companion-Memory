import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  ManyToMany,
  JoinColumn,
  JoinTable,
} from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { UserEntity } from '@ci/domains/user';
import { TagEntity } from './TagEntity';

@Entity({ name: 'saved_searches' })
export class SavedSearchEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  query!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'json', nullable: true })
  filters?: Record<string, any>;

  @Column({ type: 'boolean', default: false })
  is_smart_search!: boolean;

  @ManyToOne(() => UserEntity, { nullable: false })
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  @ManyToMany(() => TagEntity)
  @JoinTable({
    name: 'saved_search_tags',
    joinColumn: { name: 'saved_search_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'tag_id', referencedColumnName: 'id' },
  })
  tags!: TagEntity[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  constructor() {
    if (!this.id) {
      this.id = uuidv7();
    }
  }
}