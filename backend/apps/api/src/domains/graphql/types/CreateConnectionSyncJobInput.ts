import { Field, ID, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

/**
 * A request for a sync. No `status`, `data`, `cursor` or `nextCursor`: those are the sync
 * executor's to write. A job starts `pending`, the executor fetches from the provider with the
 * connection's own credentials, and only what it stored is ever transformed. A client that could
 * set them could hand the server a "successful" payload of its own making and have it acted on
 * (downloaded, filed into memory) as if the provider had sent it.
 */
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

  @Field(() => String)
  type!: string;

  @Field(() => GraphQLJSONObject, { nullable: true })
  properties?: Record<string, unknown> | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  error?: Record<string, unknown> | null;
}
