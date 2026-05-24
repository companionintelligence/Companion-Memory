import { Field, ID, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { JobStatus } from '@ci/domains/etl';

@InputType()
export class CreateConnectionSyncJobInput {
  @Field(() => ID, { nullable: true })
  id?: string;

  @Field(() => ID)
  userId!: string;

  @Field(() => ID)
  connectionId!: string;

  @Field(() => ID, { nullable: true })
  jobId?: string | null;

  @Field(() => String)
  endpointName!: string;

  @Field(() => String, { nullable: true })
  status?: JobStatus;

  @Field(() => GraphQLJSONObject, { nullable: true })
  data?: Record<string, unknown>;

  @Field(() => String)
  type!: string;

  @Field(() => GraphQLJSONObject, { nullable: true })
  cursor?: Record<string, unknown> | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  nextCursor?: Record<string, unknown> | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  properties?: Record<string, unknown> | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  error?: Record<string, unknown> | null;
}
