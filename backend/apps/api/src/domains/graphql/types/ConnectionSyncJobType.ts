import { Field, ID, ObjectType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { type ConnectionSyncJob } from '@ci/domains/etl';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

@ObjectType({ implements: () => [Node] })
export class ConnectionSyncJobType {
  __typename = ConnectionSyncJobType.name;

  __source!: ConnectionSyncJob;

  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  userId!: string;

  @Field(() => ID)
  connectionId!: string;

  @Field(() => ID, { nullable: true })
  jobId!: string | null;

  @Field(() => String)
  endpointName!: string;

  @Field(() => String)
  status!: string;

  @Field(() => GraphQLJSONObject)
  data!: Record<string, unknown>;

  @Field(() => String)
  type!: string;

  @Field(() => GraphQLJSONObject, { nullable: true })
  cursor!: Record<string, unknown> | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  nextCursor!: Record<string, unknown> | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  properties!: Record<string, unknown> | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  error!: Record<string, unknown> | null;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  @Field(() => Date, { nullable: true })
  completedAt!: Date | null;

  static toType(syncJob: ConnectionSyncJob): ConnectionSyncJobType {
    return {
      __typename: ConnectionSyncJobType.name,
      __source: syncJob,
      id: GlobalUID.encode('connectionSyncJob', syncJob.id),
      userId: GlobalUID.encode('user', syncJob.userId),
      connectionId: GlobalUID.encode('connection', syncJob.connectionId),
      jobId: syncJob.jobId,
      endpointName: syncJob.endpointName,
      status: syncJob.status,
      data: syncJob.data,
      type: syncJob.type,
      cursor: syncJob.cursor,
      nextCursor: syncJob.nextCursor,
      properties: syncJob.properties,
      error: syncJob.error,
      createdAt: syncJob.createdAt,
      updatedAt: syncJob.updatedAt,
      completedAt: syncJob.completedAt,
    };
  }
}
