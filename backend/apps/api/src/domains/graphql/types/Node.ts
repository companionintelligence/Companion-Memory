import { Field, ID, InterfaceType } from '@nestjs/graphql';

@InterfaceType({ resolveType: (value) => value.__typename })
export abstract class Node {
  __typename!: string;

  @Field(() => ID)
  id!: string;
}
