import { Field, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

/**
 * Batch communication ingest input for the importer (net-new write path outside
 * ETL). Carries the provenance triple (sourceType, sourceSystem, sourceId) so
 * re-ingest is idempotent — see the communications_source_triple_uniq partial
 * unique index and CommunicationService.createMany.
 */
@InputType()
export class CreateCommunicationInput {
  /** e.g. 'email', 'sms', 'call', 'chat'. Stored verbatim on the row. */
  @Field(() => String)
  communicationType!: string;

  @Field(() => Date)
  time!: Date;

  @Field(() => String)
  content!: string;

  @Field(() => String, { nullable: true })
  preview?: string;

  @Field(() => String, { nullable: true })
  subject?: string;

  /** e.g. 'inbound', 'outbound'. */
  @Field(() => String, { nullable: true })
  direction?: string;

  @Field(() => String, { nullable: true })
  threadId?: string;

  @Field(() => String, { nullable: true })
  fromEntityId?: string;

  @Field(() => [String], { nullable: true })
  toEntityIds?: string[];

  @Field(() => GraphQLJSONObject, { nullable: true })
  participantsMetadata?: Record<string, unknown>;

  @Field(() => [GraphQLJSONObject], { nullable: true })
  attachments?: Record<string, unknown>[];

  @Field(() => String, { nullable: true })
  sourceType?: string;

  @Field(() => String, { nullable: true })
  sourceSystem?: string;

  @Field(() => String, { nullable: true })
  sourceId?: string;
}
