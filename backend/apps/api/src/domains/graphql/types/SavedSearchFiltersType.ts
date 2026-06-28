import { Field, InputType, ObjectType } from '@nestjs/graphql';

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

  static toType(filters: SavedSearchFilters | null | undefined): SavedSearchFiltersType | null {
    if (filters == null) {
      return null;
    }

    return {
      eventTypes: filters.eventTypes,
      startTime: filters.startTime,
      endTime: filters.endTime,
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
      connectors: filters.connectors,
      people: filters.people,
      places: filters.places,
      hasLocation: filters.hasLocation,
      semantic: filters.semantic,
    };
  }
}

@InputType()
export class SavedSearchFiltersInput implements SavedSearchFilters {
  @Field(() => [String], { nullable: true })
  eventTypes?: string[];

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
}
