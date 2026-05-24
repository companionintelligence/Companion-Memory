import { Field, ObjectType } from '@nestjs/graphql';

import { ConnectionSyncJobType } from './ConnectionSyncJobType';
import { MutationPayload } from './MutationPayload';

@ObjectType()
export class CreateConnectionSyncJobPayload extends MutationPayload {
  @Field(() => ConnectionSyncJobType, { nullable: true })
  connectionSyncJob?: ConnectionSyncJobType;
}
