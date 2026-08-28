import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { ReceiptType } from './ReceiptType';

@ObjectType({ implements: () => [Edge] })
export class ReceiptEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => ReceiptType)
  node!: ReceiptType;
}
