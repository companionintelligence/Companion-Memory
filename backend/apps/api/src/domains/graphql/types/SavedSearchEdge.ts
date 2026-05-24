import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { SavedSearchType } from './SavedSearchType';

@ObjectType({ implements: () => [Edge] })
export class SavedSearchEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => SavedSearchType)
  node!: SavedSearchType;
}
