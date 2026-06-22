import { Field, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

@InputType()
export class GraphEntityInput {
  /** Importer-stable natural key, e.g. `apple_contacts:contact:John Doe`. */
  @Field(() => String)
  key!: string;

  @Field(() => String)
  entityType!: string;

  @Field(() => String, { nullable: true })
  name?: string | null;

  @Field(() => String, { nullable: true })
  description?: string | null;

  @Field(() => String)
  sourceSystem!: string;

  @Field(() => GraphQLJSONObject, { nullable: true })
  properties?: Record<string, unknown> | null;
}
