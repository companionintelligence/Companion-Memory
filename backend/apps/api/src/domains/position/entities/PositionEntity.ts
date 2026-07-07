import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, Point } from 'typeorm';

import { DeviceEntity, type Device } from '@ci/domains/devices';
import { GraphNodeEntity } from '@ci/domains/memory';
import { UserEntity, type User } from '@ci/domains/user';

export type LocationSource = 'gps' | 'wifi' | 'cell_tower' | 'manual' | 'inferred' | 'other';

export interface RelativeCoordinates {
  x: number;
  y: number;
  z?: number;
}

export interface RelativeOrientation {
  phi?: number;
  theta?: number;
  [key: string]: number | undefined;
}

@Entity({ schema: 'ci', name: 'position' })
export class PositionEntity {
  @Column({ type: 'uuid' })
  id!: string;

  @PrimaryColumn({ type: 'timestamptz' })
  time!: Date;

  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', nullable: true, name: 'device_id' })
  deviceId?: string | null;

  @Column({
    type: 'geography',
    nullable: true,
    srid: 4326,
    spatialFeatureType: 'Point',
  })
  location?: Point | null;

  @Column({ type: 'double precision', nullable: true, name: 'altitude_meters' })
  altitudeMeters?: number | null;

  @Column({ type: 'double precision', nullable: true, name: 'accuracy_meters' })
  accuracyMeters?: number | null;

  @Column({ type: 'double precision', nullable: true })
  hdop?: number | null;

  @Column({ type: 'double precision', nullable: true })
  vdop?: number | null;

  @Column({ type: 'double precision', nullable: true, name: 'heading_degrees' })
  headingDegrees?: number | null;

  @Column({ type: 'double precision', nullable: true, name: 'speed_meters_per_second' })
  speedMetersPerSecond?: number | null;

  @Column({ type: 'text', nullable: true })
  address?: string | null;

  @Column({ type: 'text', nullable: true })
  city?: string | null;

  @Column({ type: 'text', nullable: true })
  region?: string | null;

  @Column({ type: 'text', nullable: true })
  country?: string | null;

  @Column({ type: 'text', nullable: true, name: 'postal_code' })
  postalCode?: string | null;

  @Column({ type: 'text', nullable: true })
  name?: string | null;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ type: 'text', nullable: true })
  provider?: string | null;

  @Column({ type: 'text' })
  source!: LocationSource;

  @Column({ type: 'text', nullable: true, name: 'activity_type' })
  activityType?: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'location_entity_id' })
  locationEntityId?: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'reference_entity_id' })
  referenceEntityId?: string | null;

  @Column({ type: 'jsonb', default: '{}', name: 'relative_coordinates' })
  relativeCoordinates!: RelativeCoordinates | Record<string, unknown>;

  @Column({ type: 'jsonb', default: '{}', name: 'relative_orientation' })
  relativeOrientation!: RelativeOrientation | Record<string, unknown>;

  @Column({ type: 'boolean', default: false, name: 'is_private' })
  isPrivate!: boolean;

  // Provenance triple for bulk-ingested fixes (#1672) — traceability + triple
  // idempotency, mirroring communications/content/browser_activity. Nullable:
  // live device fixes have no import provenance.
  @Column({ type: 'text', nullable: true, name: 'source_type' })
  sourceType?: string | null;

  @Column({ type: 'text', nullable: true, name: 'source_system' })
  sourceSystem?: string | null;

  @Column({ type: 'text', nullable: true, name: 'source_id' })
  sourceId?: string | null;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity | null;

  @ManyToOne(() => DeviceEntity)
  @JoinColumn({ name: 'device_id' })
  device?: DeviceEntity | null;

  @ManyToOne(() => GraphNodeEntity)
  @JoinColumn({ name: 'location_entity_id' })
  locationEntity?: GraphNodeEntity | null;

  @ManyToOne(() => GraphNodeEntity)
  @JoinColumn({ name: 'reference_entity_id' })
  referenceEntity?: GraphNodeEntity | null;

  static toEgressType(entity: PositionEntity): Position {
    return {
      id: entity.id,
      time: entity.time,
      userId: entity.userId,
      deviceId: entity.deviceId ?? undefined,
      location: entity.location ?? undefined,
      altitudeMeters: entity.altitudeMeters ?? undefined,
      accuracyMeters: entity.accuracyMeters ?? undefined,
      hdop: entity.hdop ?? undefined,
      vdop: entity.vdop ?? undefined,
      headingDegrees: entity.headingDegrees ?? undefined,
      speedMetersPerSecond: entity.speedMetersPerSecond ?? undefined,
      address: entity.address ?? undefined,
      city: entity.city ?? undefined,
      region: entity.region ?? undefined,
      country: entity.country ?? undefined,
      postalCode: entity.postalCode ?? undefined,
      name: entity.name ?? undefined,
      description: entity.description ?? undefined,
      provider: entity.provider ?? undefined,
      source: entity.source,
      activityType: entity.activityType ?? undefined,
      locationEntityId: entity.locationEntityId ?? undefined,
      referenceEntityId: entity.referenceEntityId ?? undefined,
      relativeCoordinates: entity.relativeCoordinates,
      relativeOrientation: entity.relativeOrientation,
      isPrivate: entity.isPrivate,
      user: entity.user ? UserEntity.toEgressType(entity.user) : undefined,
      device: entity.device ? DeviceEntity.toEgressType(entity.device) : undefined,
      locationEntity: entity.locationEntity ?? undefined,
      referenceEntity: entity.referenceEntity ?? undefined,
    };
  }
}
export type Position = Readonly<
  Omit<PositionEntity, 'user' | 'device' | 'locationEntity' | 'referenceEntity'>
> & {
  user?: User;
  device?: Device;
  locationEntity?: GraphNodeEntity;
  referenceEntity?: GraphNodeEntity;
};
