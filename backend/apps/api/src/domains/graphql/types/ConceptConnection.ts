import { Field, Int, ObjectType } from '@nestjs/graphql';

import { ConceptEdge } from './ConceptEdge';
import { Connection } from './Connection';
import { PageInfo } from './PageInfo';

@ObjectType({ implements: () => [Connection] })
export class ConceptConnection implements Connection {
  @Field(() => [ConceptEdge])
  edges!: ConceptEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
