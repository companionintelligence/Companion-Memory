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

import { PlaceEntity } from './PlaceEntity';
import { TagEntity } from './TagEntity';

@Entity({ name: 'locations' })
export class LocationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text', nullable: true })
  identifier!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  datetime!: Date | null;

  @Column({ type: 'text', nullable: true })
  geo_format!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  geolocation!: Record<string, unknown> | null;

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
  @JoinColumn({ name: 'place_id' })
  place?: PlaceEntity;

  @ManyToMany(() => TagEntity, { nullable: true })
  @JoinTable({
    name: 'location_tag',
    joinColumn: { name: 'location_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'tag_id', referencedColumnName: 'id' },
  })
  tags?: TagEntity[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
