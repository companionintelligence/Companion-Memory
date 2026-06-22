import { Field, InputType } from '@nestjs/graphql';

import { GraphEntityInput } from './GraphEntityInput';
import { GraphRelationshipInput } from './GraphRelationshipInput';

@InputType()
export class BulkGraphInput {
  @Field(() => [GraphEntityInput])
  entities!: GraphEntityInput[];

  @Field(() => [GraphRelationshipInput], { nullable: true })
  relationships?: GraphRelationshipInput[];
}
