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

import { UserEntity, type User } from '@ci/domains/user';

@Entity({ schema: 'ci', name: 'entities' })
export class PlaceEntity {
  @PrimaryColumn('uuid', { name: 'entity_id' })
  id!: string;

  @Column({ type: 'text', name: 'entity_type', default: 'Location' })
  entityType!: string;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  properties!: Record<string, unknown>;

  // Backward compatibility fields - populated from properties JSONB after load
  type!: string | null;

  geoFormat!: string | null;

  geolocation!: Record<string, unknown> | null;

  locationBoundary!: Record<string, unknown> | null;

  estimated!: boolean | null;

  tracked!: boolean | null;

  uploaded!: boolean | null;

  @AfterLoad()
  loadPropertiesFromJsonb() {
    if (!this.properties) {
      return;
    }

    this.type = (this.properties.type as string) || null;
    this.geoFormat = (this.properties.geo_format as string) || null;
    this.geolocation = (this.properties.geolocation as Record<string, unknown>) || null;
    this.locationBoundary = (this.properties.location_boundary as Record<string, unknown>) || null;
    this.estimated =
      typeof this.properties.estimated === 'boolean'
        ? this.properties.estimated
        : typeof this.properties.estimated === 'string'
          ? this.properties.estimated.toLowerCase() === 'true'
          : null;
    this.tracked =
      typeof this.properties.tracked === 'boolean'
        ? this.properties.tracked
        : typeof this.properties.tracked === 'string'
          ? this.properties.tracked.toLowerCase() === 'true'
          : null;
    this.uploaded =
      typeof this.properties.uploaded === 'boolean'
        ? this.properties.uploaded
        : typeof this.properties.uploaded === 'string'
          ? this.properties.uploaded.toLowerCase() === 'true'
          : null;
  }

  // Helper method for creating filtered queries
  static createPlaceQuery(
    repository: Repository<PlaceEntity>,
    alias: string = 'place',
  ): SelectQueryBuilder<PlaceEntity> {
    return repository
      .createQueryBuilder(alias)
      .where(`${alias}.entity_type = :entityType`, { entityType: 'Location' });
  }

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'owner_user_id' })
  user?: UserEntity;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: PlaceEntity) {
    return {
      id: entity.id,
      name: entity.name || null,
      entityType: entity.entityType,
      description: entity.description || null,
      type: entity.type || null,
      geoFormat: entity.geoFormat || null,
      geolocation: entity.geolocation || null,
      locationBoundary: entity.locationBoundary || null,
      estimated: entity.estimated || null,
      tracked: entity.tracked || null,
      properties: entity.properties || {},
      uploaded: entity.uploaded || null,
      userId: entity.user?.id || null,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      user: entity.user ? UserEntity.toEgressType(entity.user) : undefined,
    };
  }
}

export type Place = Readonly<Omit<PlaceEntity, 'user' | 'loadPropertiesFromJsonb'>> & {
  user?: User;
};
