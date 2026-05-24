import { Field, Float, ID, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { RelationshipType as RelationshipTypeName } from '@ci/domains/graph';

@InputType()
export class CreateRelationshipInput {
  @Field(() => ID)
  fromNodeId!: string;

  @Field(() => String)
  fromNodeType!: string;

  @Field(() => String)
  toNodeId!: string;

  @Field(() => String)
  toNodeType!: string;

  @Field(() => String)
  type!: RelationshipTypeName;

  @Field(() => Float, { nullable: true })
  strength?: number;

  @Field(() => GraphQLJSONObject, { nullable: true })
  properties?: Record<string, unknown>;

  @Field(() => Boolean, { nullable: true })
  isBidirectional?: boolean;

  @Field(() => Date, { nullable: true })
  startDate?: Date;

  @Field(() => Date, { nullable: true })
  endDate?: Date;
}
