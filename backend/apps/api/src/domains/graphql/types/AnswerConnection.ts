import { Field, Int, ObjectType } from '@nestjs/graphql';

import { AnswerEdge } from './AnswerEdge';
import { Connection } from './Connection';
import { PageInfo } from './PageInfo';

@ObjectType({ implements: () => [Connection] })
export class AnswerConnection implements Connection {
  @Field(() => [AnswerEdge])
  edges!: AnswerEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
