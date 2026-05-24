import { Field, ID, ObjectType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { type Connection } from '@ci/domains/connections';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

@ObjectType({ implements: () => [Node] })
export class ConnectionType {
  __typename = ConnectionType.name;

  __source!: Connection;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => Boolean)
  active!: boolean;

  @Field(() => String, { nullable: true })
  schedule!: string | null;

  @Field(() => Date, { nullable: true })
  tokenExpiry!: Date | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  syncState!: Record<string, unknown> | null;

  @Field(() => [String])
  activeEndpoints!: string[];

  @Field(() => ID)
  providerId!: string;

  @Field(() => Boolean)
  needsReauth!: boolean;

  @Field(() => String, { nullable: true })
  externalId!: string | null;

  static toType(connection: Connection): ConnectionType {
    return {
      __typename: ConnectionType.name,
      __source: connection,
      id: GlobalUID.encode('connection', connection.id),
      name: connection.name,
      active: connection.active,
      schedule: connection.schedule,
      tokenExpiry: connection.tokenExpiry,
      syncState: connection.syncState,
      activeEndpoints: connection.activeEndpoints,
      providerId: connection.providerId,
      needsReauth: connection.needsReauth,
      externalId: connection.externalId,
    };
  }
}
