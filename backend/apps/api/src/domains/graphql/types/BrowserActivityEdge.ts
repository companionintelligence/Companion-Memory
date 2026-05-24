import { Field, ObjectType } from '@nestjs/graphql';

import { BrowserActivityType } from './BrowserActivityType';
import { Edge } from './Edge';

@ObjectType({ implements: () => [Edge] })
export class BrowserActivityEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => BrowserActivityType)
  node!: BrowserActivityType;
}
