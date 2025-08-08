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

import { PersonEntity } from './PersonEntity';

@Entity({ name: 'contacts' })
export class ContactEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text', nullable: true })
  type!: string | null;

  @Column({ type: 'text', nullable: true })
  avatar_url!: string | null;

  @Column({ type: 'text', nullable: true })
  handle!: string | null;

  @Column({ type: 'text', nullable: true })
  identifier!: string | null;

  @Column({ type: 'text', nullable: true })
  external_id!: string | null;

  @Column({ type: 'text', nullable: true })
  source_url!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  source_data!: Record<string, unknown> | null;

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @ManyToOne(() => PersonEntity, { nullable: true })
  @JoinColumn({ name: 'person_id' })
  person?: PersonEntity;

  @ManyToMany(() => TagEntity, { nullable: true })
  @JoinTable({
    name: 'contact_tag',
    joinColumn: { name: 'contact_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'tag_id', referencedColumnName: 'id' },
  })
  tags?: TagEntity[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
