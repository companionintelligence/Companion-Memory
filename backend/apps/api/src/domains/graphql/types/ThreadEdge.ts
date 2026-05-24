import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { ThreadType } from './ThreadType';

@ObjectType({ implements: () => [Edge] })
export class ThreadEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => ThreadType)
  node!: ThreadType;
}
