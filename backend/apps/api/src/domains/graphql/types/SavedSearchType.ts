import { Field, ID, ObjectType } from '@nestjs/graphql';

import { type SavedSearch } from '@ci/domains/files';
import { IndexableEntity } from '@ci/domains/search-next';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { SavedSearchFiltersType } from './SavedSearchFiltersType';

@ObjectType({ implements: () => [Node] })
export class SavedSearchType implements Node {
  __typename = SavedSearchType.name;

  __source!: SavedSearch;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => String, { nullable: true })
  query!: string | null;

  @Field(() => [String], { nullable: true })
  entityTypes!: IndexableEntity[] | null;

  @Field(() => [String], { nullable: true })
  tags!: string[];

  /** Secondary explorer dimensions (who / where / when / how / sort / semantic). */
  @Field(() => SavedSearchFiltersType, { nullable: true })
  filters!: SavedSearchFiltersType | null;

  /** Whether this search is link-shared. See {@link shareToken}. */
  @Field(() => Boolean)
  isPublic!: boolean;

  /**
   * Unguessable capability token for the share link (`/shared/<token>`). Only
   * present when `isPublic` is true and only returned to the owner. A signed-in
   * viewer holding the token can open the search and run it as the owner.
   */
  @Field(() => String, { nullable: true })
  shareToken!: string | null;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  static toType(savedSearch: SavedSearch): SavedSearchType {
    return {
      __typename: SavedSearchType.name,
      __source: savedSearch,
      id: GlobalUID.encode('saved-search', savedSearch.id),
      name: savedSearch.name,
      description: savedSearch.description,
      query: savedSearch.query,
      entityTypes: savedSearch.entityTypes,
      tags: savedSearch.tags,
      filters: SavedSearchFiltersType.toType(savedSearch.filters),
      isPublic: savedSearch.isPublic ?? false,
      shareToken: savedSearch.shareToken ?? null,
      createdAt: savedSearch.createdAt,
      updatedAt: savedSearch.updatedAt,
    };
  }
}
