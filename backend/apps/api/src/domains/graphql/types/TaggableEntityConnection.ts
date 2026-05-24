import { Field, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { TaggableEntityEdge } from './TaggableEntityEdge';

@ObjectType()
export class TaggableEntityConnection extends Connection {
  @Field(() => [TaggableEntityEdge])
  declare edges: TaggableEntityEdge[];
}
