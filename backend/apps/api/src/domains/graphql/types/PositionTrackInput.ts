import { Field, Float, InputType, Int } from '@nestjs/graphql';

/**
 * Filters and paging for the `positionTrack` read.
 *
 * Deliberately narrower than {@link SearchInput}: `ci.position` is a stream of
 * GPS fixes, not memories, so it has no text to query, no tags, no participants
 * and no connectors. What it does have is when and where — which is exactly the
 * pair the map already knows (its viewport, and the explorer's date filters).
 */
@InputType()
export class PositionTrackInput {
  /** ISO-8601 lower bound (inclusive) on the fix time. */
  @Field(() => String, { nullable: true })
  startTime?: string;

  /** ISO-8601 upper bound (exclusive) on the fix time. */
  @Field(() => String, { nullable: true })
  endTime?: string;

  /**
   * Viewport as [minLon, minLat, maxLon, maxLat] (WGS84 / EPSG:4326) — the same
   * shape and order as `SearchInput.bbox`, so the map can hand both reads the
   * same box. Ignored unless it is exactly four finite numbers, and dropped
   * (rather than narrowed to nonsense) for viewports wider than a hemisphere.
   */
  @Field(() => [Float], { nullable: true })
  bbox?: number[];

  /** Points per page (default 2,000, hard max 10,000). */
  @Field(() => Int, { nullable: true })
  first?: number;

  /** Opaque cursor from a previous page's `endCursor`. */
  @Field(() => String, { nullable: true })
  after?: string;

  /**
   * Roughly how many points the WHOLE window should collapse to (default 2,000,
   * hard max 20,000). The server turns this into a time bucket, so this — not
   * the number of rows in the table — is what bounds a world-zoom read. Pass 0
   * to switch downsampling off and page through raw fixes.
   */
  @Field(() => Int, { nullable: true })
  maxPoints?: number;
}
