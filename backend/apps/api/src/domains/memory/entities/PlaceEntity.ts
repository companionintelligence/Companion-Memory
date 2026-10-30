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
  type Point,
  type Polygon,
} from 'typeorm';

import { UserEntity, type User } from '@ci/domains/user';

/** Geographic level of a place, room -> planet (issue #1811). */
export type PlaceKind =
  | 'room'
  | 'building'
  | 'venue'
  | 'address'
  | 'neighborhood'
  | 'city'
  | 'region'
  | 'country'
  | 'continent'
  | 'planet'
  | 'other';

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

  /** Full-precision coordinates (GeoJSON Point, [lng, lat], SRID 4326). */
  @Column({
    type: 'geography',
    nullable: true,
    srid: 4326,
    spatialFeatureType: 'Point',
    name: 'location_point',
  })
  locationPoint!: Point | null;

  /** Optional polygon footprint (GeoJSON Polygon, SRID 4326). */
  @Column({
    type: 'geography',
    nullable: true,
    srid: 4326,
    spatialFeatureType: 'Polygon',
    name: 'location_boundary',
  })
  boundary!: Polygon | null;

  @Column({ type: 'text', name: 'place_kind', nullable: true })
  placeKind!: PlaceKind | null;

  /** Containing place (venue -> city -> region -> country chain). */
  @Column({ type: 'uuid', name: 'parent_place_id', nullable: true })
  parentPlaceId!: string | null;

  /**
   * `ci.entities.is_active`. False once the user asked Memory to forget the
   * place (`memory.forget` in archive mode), and on a merge tombstone. Search,
   * the explorer and the map leave such a row out.
   */
  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  // Backward compatibility fields - populated from properties JSONB after load
  type!: string | null;

  /** Latitude/longitude from locationPoint, falling back to legacy properties shapes. */
  latitude!: number | null;

  longitude!: number | null;

  geoFormat!: string | null;

  geolocation!: Record<string, unknown> | null;

  locationBoundary!: Record<string, unknown> | null;

  estimated!: boolean | null;

  tracked!: boolean | null;

  uploaded!: boolean | null;

  @AfterLoad()
  loadPropertiesFromJsonb() {
    this.latitude = null;
    this.longitude = null;

    if (this.locationPoint?.coordinates?.length === 2) {
      this.longitude = this.locationPoint.coordinates[0];
      this.latitude = this.locationPoint.coordinates[1];
    }

    if (!this.properties) {
      return;
    }

    // Legacy fallbacks: geocode-created rows ({lat, lng}) and LifeScope-style
    // rows (geolocation = [lng, lat]).
    if (this.latitude == null || this.longitude == null) {
      const lat = this.properties.lat;
      const lng = this.properties.lng;
      if (typeof lat === 'number' && typeof lng === 'number') {
        this.latitude = lat;
        this.longitude = lng;
      } else {
        const geo = this.properties.geolocation;
        if (Array.isArray(geo) && typeof geo[0] === 'number' && typeof geo[1] === 'number') {
          this.longitude = geo[0];
          this.latitude = geo[1];
        }
      }
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
      locationPoint: entity.locationPoint || null,
      boundary: entity.boundary || null,
      placeKind: entity.placeKind || null,
      parentPlaceId: entity.parentPlaceId || null,
      isActive: entity.isActive,
      latitude: entity.latitude ?? null,
      longitude: entity.longitude ?? null,
      userId: entity.user?.id || null,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      user: entity.user ? UserEntity.toEgressType(entity.user) : undefined,
    };
  }
}

export type Place = Readonly<Omit<PlaceEntity, 'user' | 'loadPropertiesFromJsonb'>> & {
  user?: User;
  /**
   * Browse-only: first real visit inside the active search date window.
   * Absent on an unfiltered unique list so the frontend keeps places in "No date".
   */
  readonly appearedAt?: Date | null;
};
