import { Field, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

/**
 * One item↔item edge (email→attachment, photo→album) from the importer. Both
 * endpoints are referenced by their provenance triple
 * (source_type, source_system, source_id) — the table-agnostic handle both sides
 * share — NOT a CI-Server row id.
 */
@InputType()
export class ItemRelationshipInput {
  @Field(() => String)
  fromSourceType!: string;

  @Field(() => String)
  fromSourceSystem!: string;

  @Field(() => String)
  fromSourceId!: string;

  @Field(() => String)
  toSourceType!: string;

  @Field(() => String)
  toSourceSystem!: string;

  @Field(() => String)
  toSourceId!: string;

  @Field(() => String)
  relation!: string;

  @Field(() => GraphQLJSONObject, { nullable: true })
  metadata?: Record<string, unknown> | null;
}
