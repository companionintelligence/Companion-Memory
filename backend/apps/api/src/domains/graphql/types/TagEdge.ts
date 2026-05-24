import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { TagType } from './TagType';

@ObjectType({ implements: () => [Edge] })
export class TagEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => TagType)
  node!: TagType;
}
