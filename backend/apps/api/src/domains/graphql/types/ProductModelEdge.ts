import { Field, ObjectType } from '@nestjs/graphql';

import { Edge } from './Edge';
import { ProductModelType } from './ProductModelType';

@ObjectType({ implements: () => [Edge] })
export class ProductModelEdge implements Edge {
  @Field(() => String)
  cursor!: string;

  @Field(() => ProductModelType)
  node!: ProductModelType;
}
