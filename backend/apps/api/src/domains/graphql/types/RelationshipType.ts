import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { type Relationship } from '@ci/domains/graph';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

@ObjectType({ implements: () => [Node] })
export class RelationshipType implements Node {
  __typename = RelationshipType.name;

  __source!: Relationship;

  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  fromNodeId!: string;

  @Field(() => String)
  fromNodeType!: string;

  @Field(() => ID)
  toNodeId!: string;

  @Field(() => String)
  toNodeType!: string;

  @Field(() => String)
  type!: string;

  @Field(() => Float, { nullable: true })
  strength?: number;

  @Field(() => GraphQLJSONObject, { nullable: true })
  properties?: Record<string, unknown>;

  @Field(() => Boolean)
  isBidirectional!: boolean;

  @Field(() => Date, { nullable: true })
  startDate?: Date;

  @Field(() => Date, { nullable: true })
  endDate?: Date;

  static toType(relationship: Relationship): RelationshipType {
    return {
      __typename: RelationshipType.name,
      __source: relationship,
      id: GlobalUID.encode('relationship', relationship.id),
      fromNodeId: relationship.fromNodeId,
      fromNodeType: relationship.fromNodeType,
      toNodeId: relationship.toNodeId,
      toNodeType: relationship.toNodeType,
      type: relationship.type,
      strength: relationship.strength,
      properties: relationship.properties,
      isBidirectional: relationship.isBidirectional,
      startDate: relationship.startDate ? new Date(relationship.startDate) : undefined,
      endDate: relationship.endDate ? new Date(relationship.endDate) : undefined,
    };
  }
}
