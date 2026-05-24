import { Field, ObjectType } from '@nestjs/graphql';

import { ConnectionType } from './ConnectionType';
import { MutationPayload } from './MutationPayload';

@ObjectType()
export class UpdateConnectionPayload extends MutationPayload {
  @Field(() => ConnectionType, { nullable: true })
  connection?: ConnectionType;
}
