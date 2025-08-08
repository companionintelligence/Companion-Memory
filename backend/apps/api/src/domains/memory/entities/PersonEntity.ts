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

@Entity({ name: 'people' })
export class PersonEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text', nullable: true })
  type!: string | null;

  @Column({ type: 'text', nullable: true })
  first_name!: string | null;

  @Column({ type: 'text', nullable: true })
  last_name!: string | null;

  @Column({ type: 'text', nullable: true })
  gender!: string | null;

  @Column({ type: 'text', nullable: true })
  address!: string | null;

  @Column({ type: 'text', nullable: true })
  street_address!: string | null;

  @Column({ type: 'text', nullable: true })
  street_address_2!: string | null;

  @Column({ type: 'text', nullable: true })
  city!: string | null;

  @Column({ type: 'text', nullable: true })
  region!: string | null;

  @Column({ type: 'text', nullable: true })
  country!: string | null;

  @Column({ type: 'text', nullable: true })
  postal_code!: string | null;

  @Column({ type: 'text', nullable: true })
  avatar_url!: string | null;

  @Column({ type: 'text', nullable: true })
  external_id!: string | null;

  @Column({ type: 'text', nullable: true })
  source_url!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  source_data!: Record<string, unknown> | null;

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @ManyToMany(() => TagEntity, { nullable: true })
  @JoinTable({
    name: 'person_tag',
    joinColumn: { name: 'person_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'tag_id', referencedColumnName: 'id' },
  })
  tags?: TagEntity[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
