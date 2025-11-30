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

@Entity('position')
export class PositionEntity {
  @PrimaryColumn({ type: 'timestamptz' })
  time!: Date;

  @PrimaryColumn({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'uuid', nullable: true })
  device_id?: string | null;

  @Column({
    type: 'geography',
    nullable: true,
    srid: 4326,
    spatialFeatureType: 'Point',
  })
  location?: Point | null;

  @Column({ type: 'double precision', nullable: true })
  altitude_meters?: number | null;

  @Column({ type: 'double precision', nullable: true })
  accuracy_meters?: number | null;

  @Column({ type: 'double precision', nullable: true })
  hdop?: number | null;

  @Column({ type: 'double precision', nullable: true })
  vdop?: number | null;

  @Column({ type: 'double precision', nullable: true })
  heading_degrees?: number | null;

  @Column({ type: 'double precision', nullable: true })
  speed_meters_per_second?: number | null;

  @Column({ type: 'text', nullable: true })
  address?: string | null;

  @Column({ type: 'text', nullable: true })
  city?: string | null;

  @Column({ type: 'text', nullable: true })
  region?: string | null;

  @Column({ type: 'text', nullable: true })
  country?: string | null;

  @Column({ type: 'text', nullable: true })
  postal_code?: string | null;

  @Column({ type: 'text', nullable: true })
  name?: string | null;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ type: 'text', nullable: true })
  provider?: string | null;

  @Column({ type: 'text' })
  source!: LocationSource;

  @Column({ type: 'text', nullable: true })
  activity_type?: string | null;

  @Column({ type: 'uuid', nullable: true })
  location_entity_id?: string | null;

  @Column({ type: 'uuid', nullable: true })
  reference_entity_id?: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  relative_coordinates!: RelativeCoordinates | Record<string, unknown>;

  @Column({ type: 'jsonb', default: '{}' })
  relative_orientation!: RelativeOrientation | Record<string, unknown>;

  @Column({
    type: 'text',
    nullable: true,
    transformer: {
      to: (v: number[] | null) => (v ? `[${v.join(',')}]` : null),
      from: (v: string | null) => (v ? v.slice(1, -1).split(',').map(Number) : null),
    },
  })
  location_embedding?: number[] | null;

  @Column({ type: 'boolean', default: false })
  is_private!: boolean;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity | null;

  @ManyToOne(() => DeviceEntity)
  @JoinColumn({ name: 'device_id' })
  device?: DeviceEntity | null;

  @ManyToOne(() => GraphNodeEntity)
  @JoinColumn({ name: 'location_entity_id' })
  location_entity?: GraphNodeEntity | null;

  @ManyToOne(() => GraphNodeEntity)
  @JoinColumn({ name: 'reference_entity_id' })
  reference_entity?: GraphNodeEntity | null;

  toPosition(): Position {
    return {
      time: this.time,
      user_id: this.user_id,
      device_id: this.device_id ?? undefined,
      location: this.location ?? undefined,
      altitude_meters: this.altitude_meters ?? undefined,
      accuracy_meters: this.accuracy_meters ?? undefined,
      hdop: this.hdop ?? undefined,
      vdop: this.vdop ?? undefined,
      heading_degrees: this.heading_degrees ?? undefined,
      speed_meters_per_second: this.speed_meters_per_second ?? undefined,
      address: this.address ?? undefined,
      city: this.city ?? undefined,
      region: this.region ?? undefined,
      country: this.country ?? undefined,
      postal_code: this.postal_code ?? undefined,
      name: this.name ?? undefined,
      description: this.description ?? undefined,
      provider: this.provider ?? undefined,
      source: this.source,
      activity_type: this.activity_type ?? undefined,
      location_entity_id: this.location_entity_id ?? undefined,
      reference_entity_id: this.reference_entity_id ?? undefined,
      relative_coordinates: this.relative_coordinates,
      relative_orientation: this.relative_orientation,
      location_embedding: this.location_embedding ?? undefined,
      is_private: this.is_private,
      user: this.user ? UserEntity.toEgressType(this.user) : undefined,
      device: this.device?.toDevice(),
      location_entity: this.location_entity ?? undefined,
      reference_entity: this.reference_entity ?? undefined,
    };
  }
}

export interface Position {
  readonly time: Date;
  readonly user_id: string;
  readonly device_id?: string;
  readonly location?: Point;
  readonly altitude_meters?: number;
  readonly accuracy_meters?: number;
  readonly hdop?: number;
  readonly vdop?: number;
  readonly heading_degrees?: number;
  readonly speed_meters_per_second?: number;
  readonly address?: string;
  readonly city?: string;
  readonly region?: string;
  readonly country?: string;
  readonly postal_code?: string;
  readonly name?: string;
  readonly description?: string;
  readonly provider?: string;
  readonly source: LocationSource;
  readonly activity_type?: string;
  readonly location_entity_id?: string;
  readonly reference_entity_id?: string;
  readonly relative_coordinates: RelativeCoordinates | Record<string, unknown>;
  readonly relative_orientation: RelativeOrientation | Record<string, unknown>;
  readonly location_embedding?: number[];
  readonly is_private: boolean;
  readonly user?: User;
  readonly device?: Device;
  readonly location_entity?: GraphNodeEntity;
  readonly reference_entity?: GraphNodeEntity;
}
