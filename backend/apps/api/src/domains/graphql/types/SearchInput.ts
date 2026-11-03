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

  /**
   * Force standalone files into (`true`) or out of (`false`) the timed browse,
   * whatever the type filter says. Absent, files follow the type filter and,
   * like people and places, are left out of the UNFILTERED browse: a file has
   * no date of its own, so it would sort by when its row was last written.
   *
   * History: files were opt-in behind this flag, then (#2110) part of the
   * default browse with this as an opt-out, because the explorer's File type
   * picker did nothing on surfaces that didn't set the flag. The picker now
   * reaches files through the type filter itself, so the default could go back
   * to opt-in (2026-10-30) without breaking it.
   */
  @Field(() => Boolean, { nullable: true })
  includeFiles?: boolean;

  // "Which kind of file" — narrows file results to these kinds (`image`,
  // `video`, `audio`, `document`), read off the file's content type. Only
  // affects entities of type `file`; a kind nobody recognises is ignored.
  @Field(() => [String], { nullable: true })
  fileKinds?: string[];

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

  /**
   * "How" — data sources (`source_system`) to include, e.g. 'gmail','imessage','reddit'.
   * Unlike who / where, this is not event-only: it narrows every browsed kind that
   * carries a source column (events, communications, content, browser activity,
   * receipts, products, things) and sets aside the kinds that have none.
   */
  @Field(() => [String], { nullable: true })
  connectors?: string[];

  /**
   * "Who" — person name patterns; matched (ILIKE) against the Person entities a
   * row links to: an event's participants / organizer, a communication's sender /
   * recipients. Narrows those two kinds and sets aside every other kind.
   */
  @Field(() => [String], { nullable: true })
  people?: string[];

  /** "Where" — place name patterns; matched (ILIKE) against the event's Location entity / location name. */
  @Field(() => [String], { nullable: true })
  places?: string[];

  /**
   * Message direction: `inbound` (received) or `outbound` (sent). A dimension
   * only communications carry, so setting it pins the browse to them — the
   * Who picker's "Received / Sent" toggle. With `people` set it also fixes the
   * person's role: received means *from* one of them, sent means *to* one of
   * them, so a group chat they merely belong to does not surface everyone
   * else's messages. Other values are ignored.
   */
  @Field(() => String, { nullable: true })
  direction?: string;

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

  /**
   * "Where" (drawn areas) — several bounding boxes, each [minLon, minLat, maxLon, maxLat],
   * ORed: an event matches inside any of them. `bbox` is read as one more area.
   */
  @Field(() => [[Float]], { nullable: true })
  areas?: number[][];

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
