import { Field, InterfaceType } from '@nestjs/graphql';

import { Node } from './Node';

@InterfaceType()
export abstract class Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => Node)
  node!: Node;
}
