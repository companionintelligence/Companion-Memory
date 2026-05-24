import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { ItemType } from './ItemType';

@ObjectType({ implements: () => [Edge] })
export class ItemEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => ItemType)
  node!: ItemType;
}
