import { Field, ID, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { JobStatus } from '@ci/domains/etl';

@InputType()
export class UpdateConnectionSyncJobInput {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, { nullable: true })
  jobId?: string | undefined;

  @Field(() => String, { nullable: true })
  endpointName?: string;

  @Field(() => String, { nullable: true })
  status?: JobStatus;

  @Field(() => GraphQLJSONObject, { nullable: true })
  data?: Record<string, unknown>;

  @Field(() => String, { nullable: true })
  type?: string;

  @Field(() => GraphQLJSONObject, { nullable: true })
  cursor?: Record<string, unknown> | undefined;

  @Field(() => GraphQLJSONObject, { nullable: true })
  nextCursor?: Record<string, unknown> | undefined;

  @Field(() => GraphQLJSONObject, { nullable: true })
  properties?: Record<string, unknown> | undefined;

  @Field(() => GraphQLJSONObject, { nullable: true })
  error?: Record<string, unknown> | undefined;

  @Field(() => Date, { nullable: true })
  completedAt?: Date | undefined;
}
