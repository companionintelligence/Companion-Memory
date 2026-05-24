import { Field, ID, ObjectType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { type Content } from '@ci/domains/memory';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { Taggable } from './Taggable';

@ObjectType({ implements: () => [Node, Taggable] })
export class ContentType implements Node, Taggable {
  __typename = ContentType.name;

  __source!: Content;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  type!: string | null;

  @Field(() => String, { nullable: true })
  title!: string | null;

  @Field(() => String, { nullable: true })
  text!: string | null;

  @Field(() => String, { nullable: true })
  url!: string | null;

  @Field(() => String, { nullable: true })
  mimetype!: string | null;

  @Field(() => String, { nullable: true })
  externalId!: string | null;

  @Field(() => String, { nullable: true })
  sourceUrl!: string | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  sourceData!: Record<string, unknown> | null;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  static toType(entity: Content): ContentType {
    return {
      __typename: ContentType.name,
      __source: entity,
      id: GlobalUID.encode('content', entity.id),
      type: entity.type,
      title: entity.title,
      text: entity.text,
      url: entity.url,
      mimetype: entity.mimetype,
      externalId: entity.externalId,
      sourceUrl: entity.sourceUrl,
      sourceData: entity.sourceData,
      tags: [], // Hydrated by resolver
    };
  }
}
