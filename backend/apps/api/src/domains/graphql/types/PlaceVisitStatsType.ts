import { Field, Int, ObjectType } from '@nestjs/graphql';

import type { PlaceVisitStats } from '@ci/domains/memory';

/**
 * Aggregated visit stats for a place, derived from events linked via
 * events.location_entity_id.
 */
@ObjectType()
export class PlaceVisitStatsType {
  @Field(() => Int)
  visitCount!: number;

  @Field(() => Date, { nullable: true })
  firstVisitAt!: Date | null;

  @Field(() => Date, { nullable: true })
  lastVisitAt!: Date | null;

  /**
   * `confirmed`: visitCount is a fact. `pending_enrichment`: geocoding isn't
   * configured, or this user's geocode/place-promotion work isn't finished
   * yet, so a visitCount of 0 here isn't yet a measurement — a client should
   * render this differently from a place that is genuinely never visited.
   */
  @Field(() => String)
  status!: 'confirmed' | 'pending_enrichment';

  static toType(stats: PlaceVisitStats): PlaceVisitStatsType {
    return {
      visitCount: stats.visitCount,
      firstVisitAt: stats.firstVisitAt,
      lastVisitAt: stats.lastVisitAt,
      status: stats.status,
    };
  }
}
