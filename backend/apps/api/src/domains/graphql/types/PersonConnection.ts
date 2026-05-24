import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Connection } from './Connection';
import { PageInfo } from './PageInfo';
import { PersonEdge } from './PersonEdge';

@ObjectType({ implements: () => [Connection] })
export class PersonConnection implements Connection {
  @Field(() => [PersonEdge])
  edges!: PersonEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Int)
  totalCount!: number;
}
