import { Field, Float, Int, InputType } from '@nestjs/graphql';

import { IndexableEntity } from '@ci/domains/search-next';

@InputType()
export class SearchInput {
  @Field({ nullable: true })
  query?: string;

  // Forward cursor pagination: number of results per page.
  @Field(() => Int, { nullable: true })
  first?: number;

  // Opaque cursor (PageInfo.endCursor) to fetch the page after.
  @Field(() => String, { nullable: true })
  after?: string;

  @Field(() => [String], { nullable: true })
  excludeTypes?: IndexableEntity[];

  @Field(() => [String], { nullable: true })
  includeTypes?: IndexableEntity[];

  @Field(() => [String], { nullable: true })
  tags?: string[];

  // "How things happened" — narrows event results to these event types
  // (visited, messaged, called, ...). Only affects entities of type `event`.
  @Field(() => [String], { nullable: true })
  eventTypes?: string[];

  @Field(() => String, { nullable: true })
  startTime?: string;

  @Field(() => String, { nullable: true })
  endTime?: string;

  /** 'relevance' | 'time' | 'name'. Defaults to relevance when a query is present, else time. */
  @Field(() => String, { nullable: true })
  sortBy?: string;

  /** 'asc' | 'desc'. Defaults to desc. */
  @Field(() => String, { nullable: true })
  sortOrder?: string;

  // ── LifeScope-parity dimensions (event-scoped) ────────────────────────────
  // who / where / connector narrow the timeline events; combined with the other
  // filters they AND together (candidate-set + post-filter), and when any of
  // them is set the result is restricted to matching events.

  /** "Connector" — data sources (event.source_system) to include, e.g. 'gmail','imessage','spotify'. */
  @Field(() => [String], { nullable: true })
  connectors?: string[];

  /** "Who" — person name patterns; matched (ILIKE) against Person entities the event involves. */
  @Field(() => [String], { nullable: true })
  people?: string[];

  /** "Where" — place name patterns; matched (ILIKE) against the event's Location entity / location name. */
  @Field(() => [String], { nullable: true })
  places?: string[];

  /** "Where" — when true, only events carrying geographic coordinates are returned (located only). */
  @Field(() => Boolean, { nullable: true })
  hasLocation?: boolean;

  /**
   * "Where" (viewport) — geographic bounding box as [minLon, minLat, maxLon, maxLat]
   * in WGS84 / EPSG:4326. When set, only events whose coordinates fall inside the box
   * are returned (the map view's "Search this area"). Implies located-only.
   */
  @Field(() => [Float], { nullable: true })
  bbox?: number[];

  /** Force conceptual (embedding) ranking for the free-text query instead of the auto heuristic. */
  @Field(() => Boolean, { nullable: true })
  semantic?: boolean;

  /**
   * Shared-search capability token. When set, the search is resolved from the
   * referenced public saved search and run as its owner; all other filter
   * inputs above are ignored (only `first`/`after`/`sortBy`/`sortOrder` apply).
   * The caller must still be authenticated — sharing is limited to signed-in
   * users. See SearchResolver.runSharedSearch.
   */
  @Field(() => String, { nullable: true })
  shareToken?: string;
}
