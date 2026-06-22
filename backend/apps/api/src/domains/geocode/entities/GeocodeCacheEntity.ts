import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * Forward-geocode cache (ci.geocode_cache). Source of truth is the hand-written
 * migration 20260622120000_create_geocode_cache; this entity mirrors it (schema
 * sync stays off).
 *
 * One row per *canonical* query string (see GeocodeService.canonicalize), so
 * repeated lookups of the same address hit the cache instead of re-billing
 * Google. Negative results (ZERO_RESULTS / REQUEST_DENIED / INVALID_REQUEST) are
 * cached with null lat/lng so they are never re-sent.
 */
@Entity({ schema: 'ci', name: 'geocode_cache' })
export class GeocodeCacheEntity {
  /** sha256 of the canonical query form. PK. */
  @PrimaryColumn({ type: 'text', name: 'query_hash' })
  queryHash!: string;

  @Column({ type: 'text', name: 'raw_query' })
  rawQuery!: string;

  @Column({ type: 'text', nullable: true, name: 'normalized_address' })
  normalizedAddress!: string | null;

  @Column({ type: 'text', nullable: true, name: 'place_id' })
  placeId!: string | null;

  @Column({ type: 'double precision', nullable: true })
  lat!: number | null;

  @Column({ type: 'double precision', nullable: true })
  lng!: number | null;

  @Column({ type: 'jsonb', default: '{}' })
  components!: Record<string, unknown>;

  /**
   * Google's JSON `status` field, verbatim — OK | ZERO_RESULTS | REQUEST_DENIED |
   * INVALID_REQUEST | OVER_QUERY_LIMIT | UNKNOWN_ERROR — plus the synthetic
   * 'virtual' status for denylisted non-physical locations.
   */
  @Index('geocode_cache_status_idx')
  @Column({ type: 'text' })
  status!: string;

  @Column({ type: 'boolean', default: false, name: 'partial_match' })
  partialMatch!: boolean;

  /** Google geometry.location_type: ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE. */
  @Column({ type: 'text', nullable: true, name: 'location_type' })
  locationType!: string | null;

  @Column({ type: 'integer', default: 1, name: 'hit_count' })
  hitCount!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
