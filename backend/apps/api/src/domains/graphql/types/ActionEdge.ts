import { Field, ObjectType } from '@nestjs/graphql';

import { ActionType } from './ActionType';
import { Edge } from './Edge';

@ObjectType({ implements: () => [Edge] })
export class ActionEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => ActionType)
  node!: ActionType;
}
