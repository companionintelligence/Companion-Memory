import { Field, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

@InputType()
export class GraphRelationshipInput {
  /** An entity `key` from the same request, or the `self` sentinel (owner). */
  @Field(() => String)
  fromKey!: string;

  @Field(() => String)
  toKey!: string;

  @Field(() => String)
  type!: string;

  @Field(() => GraphQLJSONObject, { nullable: true })
  properties?: Record<string, unknown> | null;
}
