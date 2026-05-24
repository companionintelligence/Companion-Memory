import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { PlaceType } from './PlaceType';

@ObjectType({ implements: () => [Edge] })
export class PlaceEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => PlaceType)
  node!: PlaceType;
}
