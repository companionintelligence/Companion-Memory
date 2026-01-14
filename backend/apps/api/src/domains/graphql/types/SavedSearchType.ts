import { Field, ID, ObjectType } from '@nestjs/graphql';

import { type SavedSearch } from '@ci/domains/files';
import { IndexableEntity } from '@ci/domains/search-next';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

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

  @Field(() => [ID], { nullable: true })
  tags!: string[];

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
      createdAt: savedSearch.createdAt,
      updatedAt: savedSearch.updatedAt,
    };
  }
}
