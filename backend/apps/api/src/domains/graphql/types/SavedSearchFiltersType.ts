import { Field, Float, InputType, ObjectType } from '@nestjs/graphql';

import type { SavedSearchFilters } from '@ci/domains/files';

/**
 * Secondary explorer filter dimensions persisted on a saved search (who / where
 * / when / how / sort / semantic). Maps 1:1 to the matching SearchInput fields,
 * so a saved/shared search restores and runs the full search the user built.
 * The primary query / entityTypes / tags stay on SavedSearchType itself.
 */
@ObjectType()
export class SavedSearchFiltersType implements SavedSearchFilters {
  @Field(() => [String], { nullable: true })
  eventTypes?: string[];

  @Field(() => String, { nullable: true })
  datePreset?: string;

  @Field(() => String, { nullable: true })
  startTime?: string;

  @Field(() => String, { nullable: true })
  endTime?: string;

  @Field(() => String, { nullable: true })
  sortBy?: string;

  @Field(() => String, { nullable: true })
  sortOrder?: string;

  @Field(() => [String], { nullable: true })
  connectors?: string[];

  @Field(() => [String], { nullable: true })
  people?: string[];

  @Field(() => [String], { nullable: true })
  places?: string[];

  @Field(() => Boolean, { nullable: true })
  hasLocation?: boolean;

  @Field(() => Boolean, { nullable: true })
  semantic?: boolean;

  @Field(() => String, { nullable: true })
  direction?: string;

  /** Narrow files to these kinds (`image`, `video`, `audio`, `document`). */
  @Field(() => [String], { nullable: true })
  fileKinds?: string[];

  /** The explorer view the search opens in; the map for a Where search. */
  @Field(() => String, { nullable: true })
  view?: string;

  /** The map areas the search is confined to, each `[minLon, minLat, maxLon, maxLat]`, ORed. */
  @Field(() => [[Float]], { nullable: true })
  areas?: number[][];

  /** Legacy single area; read as a one-entry `areas`, never written by current clients. */
  @Field(() => [Float], { nullable: true })
  bbox?: number[];

  static toType(filters: SavedSearchFilters | null | undefined): SavedSearchFiltersType | null {
    if (filters == null) {
      return null;
    }

    return {
      eventTypes: filters.eventTypes,
      datePreset: filters.datePreset,
      startTime: filters.startTime,
      endTime: filters.endTime,
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
      connectors: filters.connectors,
      people: filters.people,
      places: filters.places,
      hasLocation: filters.hasLocation,
      semantic: filters.semantic,
      direction: filters.direction,
      fileKinds: filters.fileKinds,
      view: filters.view,
      areas: filters.areas,
      bbox: filters.bbox,
    };
  }
}

@InputType()
export class SavedSearchFiltersInput implements SavedSearchFilters {
  @Field(() => [String], { nullable: true })
  eventTypes?: string[];

  @Field(() => String, { nullable: true })
  datePreset?: string;

  @Field(() => String, { nullable: true })
  startTime?: string;

  @Field(() => String, { nullable: true })
  endTime?: string;

  @Field(() => String, { nullable: true })
  sortBy?: string;

  @Field(() => String, { nullable: true })
  sortOrder?: string;

  @Field(() => [String], { nullable: true })
  connectors?: string[];

  @Field(() => [String], { nullable: true })
  people?: string[];

  @Field(() => [String], { nullable: true })
  places?: string[];

  @Field(() => Boolean, { nullable: true })
  hasLocation?: boolean;

  @Field(() => Boolean, { nullable: true })
  semantic?: boolean;

  @Field(() => String, { nullable: true })
  direction?: string;

  /** Narrow files to these kinds (`image`, `video`, `audio`, `document`). */
  @Field(() => [String], { nullable: true })
  fileKinds?: string[];

  /** The explorer view the search opens in; the map for a Where search. */
  @Field(() => String, { nullable: true })
  view?: string;

  /** The map areas the search is confined to, each `[minLon, minLat, maxLon, maxLat]`, ORed. */
  @Field(() => [[Float]], { nullable: true })
  areas?: number[][];

  /** Legacy single area; read as a one-entry `areas`, never written by current clients. */
  @Field(() => [Float], { nullable: true })
  bbox?: number[];
}
