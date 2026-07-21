import { Field, ID, ObjectType, Float, Directive } from '@nestjs/graphql';

import { type SignedFile } from '@ci/domains/files';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { ItemConnection } from './ItemConnection';
import { Node } from './Node';
import { Taggable } from './Taggable';

@ObjectType({ implements: () => [Node, Taggable] })
export class FileType implements Node, Taggable {
  __typename = FileType.name;

  __source!: SignedFile;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  filename!: string | null;

  @Field(() => String)
  contentType!: string;

  @Field(() => Float, { nullable: true })
  size!: number | null;

  @Field(() => String, { nullable: true })
  title!: string | null;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => String, { nullable: true })
  externalId!: string | null;

  @Directive('@cacheControl(maxAge: 3600)')
  @Field(() => String, { nullable: true })
  sourceUrl!: string | null;

  @Field(() => ItemConnection, { nullable: true, complexity: 5 })
  items?: ItemConnection | null;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  @Field(() => String, { nullable: true })
  parseStatus!: string | null;

  @Field(() => String, { nullable: true })
  parseError!: string | null;

  @Field(() => Date, { nullable: true })
  parsedAt!: Date | null;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  static toType(file: SignedFile): FileType {
    return {
      __typename: FileType.name,
      __source: file,
      id: GlobalUID.encode('file', file.id),
      filename: file.filename,
      contentType: file.contentType,
      size: file.size ? Number(file.size) : null,
      title: file.title,
      description: file.description,
      externalId: file.externalId,
      sourceUrl: file.url,
      tags: [], // Hydrated by resolver
      parseStatus: file.parseStatus,
      parseError: file.parseError,
      parsedAt: file.parsedAt,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    };
  }
}
