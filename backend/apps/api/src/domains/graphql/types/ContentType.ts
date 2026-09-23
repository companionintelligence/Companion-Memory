import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { type Content } from '@ci/domains/memory';

import { EmbedPlayerType } from './EmbedPlayerType';
import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { Taggable } from './Taggable';
import { UnfurlType } from './UnfurlType';

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

  @Field(() => String, { nullable: true })
  sourceType!: string | null;

  @Field(() => String, { nullable: true })
  sourceSystem!: string | null;

  @Field(() => String, { nullable: true })
  sourceId!: string | null;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => GraphQLJSONObject, { nullable: true })
  sourceData!: Record<string, unknown> | null;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  /**
   * Thumbnail (PREVIEW variant) URL of the file this content row points at, for
   * `externalIdKind = 'file'` rows. Resolved by ContentResolver, not stored —
   * media content rows carry no `url`/`sourceUrl` of their own, the binary is
   * only reachable via `externalId -> ci.files`. Null when the row references no
   * file, or when no preview has been generated for it yet.
   */
  @Field(() => String, { nullable: true })
  previewUrl?: string | null;

  /** Full-resolution (ORIGINAL variant) URL of the linked file. */
  @Field(() => String, { nullable: true })
  mediaUrl?: string | null;

  /**
   * Browser-playable (PLAYBACK variant, H.264) URL of the linked video when its
   * own codec needs one; null otherwise. Resolved by ContentResolver.
   */
  @Field(() => String, { nullable: true })
  playbackUrl?: string | null;

  @Field(() => String, { nullable: true })
  playbackContentType?: string | null;

  /** Byte size of the linked ORIGINAL — lets a client avoid using it as a thumbnail. */
  @Field(() => Float, { nullable: true })
  mediaSize?: number | null;

  /** Filename of the linked ORIGINAL, when the content row points at a file. */
  @Field(() => String, { nullable: true })
  mediaFilename?: string | null;

  /**
   * Provider-hosted player derived from `url` / `externalId` alone (YouTube,
   * Spotify, Vimeo, SoundCloud, Dailymotion). Null when the URL belongs to no
   * supported provider. Resolved, never stored.
   */
  @Field(() => EmbedPlayerType, { nullable: true })
  player?: EmbedPlayerType | null;

  /**
   * Resolved link preview (title, author, poster, duration) from the
   * `enrich.unfurl` stage — oEmbed for provider links, Wikidata/Wikipedia for
   * Netflix/Prime titles, OpenGraph for everything else. Null until resolved. Read from the
   * cache only; never triggers a fetch.
   */
  @Field(() => UnfurlType, { nullable: true })
  unfurl?: UnfurlType | null;

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
      sourceType: entity.sourceType,
      sourceSystem: entity.sourceSystem,
      sourceId: entity.sourceId,
      createdAt: entity.createdAt,
      sourceData: entity.sourceData,
      tags: [], // Hydrated by resolver
    };
  }
}
