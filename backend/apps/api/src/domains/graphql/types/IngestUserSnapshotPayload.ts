import { Field, ObjectType } from '@nestjs/graphql';

import { MutationPayload } from './MutationPayload';

@ObjectType()
export class IngestUserSnapshotPayload extends MutationPayload {
  @Field(() => String, { nullable: true })
  errorMessage?: string;
}
