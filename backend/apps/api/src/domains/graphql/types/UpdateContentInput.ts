import { Field, ID, InputType } from '@nestjs/graphql';

import { GraphQLJSONObject } from '@ci/domains/graphql/scalars/JsonObjectScalar';

@InputType()
export class UpdateContentInput {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  type?: string;

  @Field(() => String, { nullable: true })
  title?: string;

  @Field(() => String, { nullable: true })
  text?: string;

  @Field(() => String, { nullable: true })
  url?: string;

  @Field(() => String, { nullable: true })
  mimetype?: string;

  @Field(() => String, { nullable: true })
  externalId?: string;

  @Field(() => String, { nullable: true })
  sourceUrl?: string;

  @Field(() => GraphQLJSONObject, { nullable: true })
  sourceData?: Record<string, unknown>;
}
