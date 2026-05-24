import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { PersonType } from './PersonType';

@ObjectType({ implements: () => [Edge] })
export class PersonEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => PersonType)
  node!: PersonType;
}
