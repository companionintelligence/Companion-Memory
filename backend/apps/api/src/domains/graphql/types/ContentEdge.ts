import { Field, ObjectType } from '@nestjs/graphql';

import { ContentType } from './ContentType';
import { Edge } from './Edge';

@ObjectType({ implements: () => [Edge] })
export class ContentEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => ContentType)
  node!: ContentType;
}
