import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { type SignedFile } from '@ci/domains/files';
import { type FileChunk } from '@ci/domains/parsing';

import { FileType } from './FileType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

@ObjectType({ implements: () => [Node] })
export class FileChunkType implements Node {
  __typename = FileChunkType.name;

  __source!: FileChunk;

  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  fileId!: string;

  @Field(() => Int)
  chunkIndex!: number;

  @Field(() => String)
  content!: string;

  @Field(() => String, { nullable: true })
  sectionTitle!: string | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  sourceLocator!: Record<string, unknown> | null;

  @Field(() => FileType, { nullable: true, complexity: 5 })
  file!: FileType | null;

  @Field(() => String)
  parserName!: string;

  @Field(() => String)
  parserVersion!: string;

  @Field(() => String)
  chunkerVersion!: string;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  static toType(chunk: FileChunk, file?: SignedFile | null): FileChunkType {
    return {
      __typename: FileChunkType.name,
      __source: chunk,
      id: GlobalUID.encode('file-chunk', chunk.id),
      fileId: GlobalUID.encode('file', chunk.fileId),
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      sectionTitle: chunk.sectionTitle,
      sourceLocator: chunk.sourceLocator,
      file: file ? FileType.toType(file) : null,
      parserName: chunk.parserName,
      parserVersion: chunk.parserVersion,
      chunkerVersion: chunk.chunkerVersion,
      createdAt: chunk.createdAt,
      updatedAt: chunk.updatedAt,
    };
  }
}
