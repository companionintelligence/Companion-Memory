import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index, Point } from 'typeorm';

/** Role a known place plays in the user's life. */
export type KnownPlaceKind = 'home' | 'work' | 'school' | 'social' | 'other';

/** How a known-place label was established. */
export type KnownPlaceSource = 'manual' | 'inferred' | 'geocoded';

/**
 * Known-place label (ci.known_place_labels). Source of truth is the hand-written
 * migration 20260622130000_create_known_place_labels; this entity mirrors it.
 *
 * A label is the confidence-tracked, time-bounded assertion that a graph
 * Location plays a role (home/work/…) in the user's life. Time-ranges are
 * mandatory because homes move: active_from..active_to define an era, and
 * (user_id, label, active_from) is unique so successive eras of the same label
 * coexist.
 */
@Entity({ schema: 'ci', name: 'known_place_labels' })
export class KnownPlaceLabelEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Index('known_place_labels_user_kind_idx')
  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  /** ci.entities Location node this label resolves to (nullable: label may pre-date its node). */
  @Column({ type: 'uuid', nullable: true, name: 'location_id' })
  locationId!: string | null;

  @Column({ type: 'text' })
  label!: string;

  @Column({ type: 'text', default: 'other' })
  kind!: KnownPlaceKind;

  @Column({
    type: 'geography',
    nullable: true,
    srid: 4326,
    spatialFeatureType: 'Point',
  })
  coordinates!: Point | null;

  @Column({ type: 'double precision', default: 0.5 })
  confidence!: number;

  @Column({ type: 'date', name: 'active_from' })
  activeFrom!: string;

  @Column({ type: 'date', nullable: true, name: 'active_to' })
  activeTo!: string | null;

  @Column({ type: 'text', array: true, default: '{}' })
  aliases!: string[];

  @Column({ type: 'text', default: 'inferred' })
  source!: KnownPlaceSource;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: KnownPlaceLabelEntity) {
    return {
      id: entity.id,
      userId: entity.userId,
      locationId: entity.locationId,
      label: entity.label,
      kind: entity.kind,
      coordinates: entity.coordinates,
      confidence: entity.confidence,
      activeFrom: entity.activeFrom,
      activeTo: entity.activeTo,
      aliases: entity.aliases,
      source: entity.source,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type KnownPlaceLabel = Readonly<KnownPlaceLabelEntity>;
