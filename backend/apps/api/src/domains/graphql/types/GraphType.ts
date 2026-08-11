import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

/**
 * First-class GraphQL graph surface (#1941). Nodes/edges are projections over
 * `ci.entities` + `ci.relationships` (CTI aggregates included). ForceGraph should
 * migrate here from REST `/api/graph/*`.
 */
@ObjectType({ description: 'Knowledge graph projection over entities + relationships' })
export class GraphType {
  @Field(() => [GraphNodeType])
  nodes!: GraphNodeType[];

  @Field(() => [GraphEdgeType])
  edges!: GraphEdgeType[];
}

@ObjectType({ description: 'A graph node (ci.entities row, including CTI bases)' })
export class GraphNodeType {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  entityType!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => String, { nullable: true })
  linkedTable!: string | null;

  @Field(() => String, { nullable: true })
  linkedId!: string | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  properties!: Record<string, unknown> | null;
}

@ObjectType({ description: 'A directed typed edge (ci.relationships row)' })
export class GraphEdgeType {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  type!: string;

  @Field(() => ID)
  fromEntityId!: string;

  @Field(() => ID)
  toEntityId!: string;

  @Field(() => Float, { nullable: true })
  strength!: number | null;

  @Field(() => Boolean)
  isActive!: boolean;

  @Field(() => GraphQLJSONObject, { nullable: true })
  properties!: Record<string, unknown> | null;
}
