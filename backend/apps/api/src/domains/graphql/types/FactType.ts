import { Field, ID, ObjectType } from '@nestjs/graphql';

import { type Fact } from '@ci/domains/memory';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

@ObjectType({ implements: () => [Node] })
export class FactType implements Node {
  __typename = FactType.name;

  __source!: Fact;

  @Field(() => ID)
  id!: string;

  static toType(fact: Fact): FactType {
    return {
      __typename: FactType.name,
      __source: fact,
      id: GlobalUID.encode('fact', fact.id),
    };
  }
}
