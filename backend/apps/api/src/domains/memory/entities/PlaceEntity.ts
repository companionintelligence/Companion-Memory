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

import { UserEntity } from '@ci/domains/user';

import { TagEntity } from './TagEntity';

@Entity({ name: 'places' })
export class PlaceEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text', nullable: true })
  type!: string | null;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true })
  geo_format!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  geolocation!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  location_boundary!: Record<string, unknown> | null;

  @Column({ type: 'boolean', nullable: true })
  estimated!: boolean | null;

  @Column({ type: 'boolean', nullable: true })
  tracked!: boolean | null;

  @Column({ type: 'boolean', nullable: true })
  uploaded!: boolean | null;

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @ManyToOne(() => PlaceEntity, { nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent?: PlaceEntity;

  @ManyToMany(() => TagEntity, { nullable: true })
  @JoinTable({
    name: 'place_tag',
    joinColumn: { name: 'place_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'tag_id', referencedColumnName: 'id' },
  })
  tags?: TagEntity[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
