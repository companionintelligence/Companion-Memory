import { Field, Int, ObjectType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import type { UnfurlView } from '../loaders/UnfurlLoader';

/**
 * A resolved link preview for a content row (`ci.unfurls`): what the provider
 * said the link is — title, author, poster, duration — fetched once by the
 * `enrich.unfurl` pipeline stage and cached. Null until that stage has
 * visited the row.
 */
@ObjectType()
export class UnfurlType {
  /** ok | not_found | not_embeddable | blocked | transport_error | rate_limited */
  @Field(() => String)
  status!: string;

  /** oembed | wikidata | opengraph */
  @Field(() => String)
  resolver!: string;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  authorName?: string | null;

  @Field(() => String, { nullable: true })
  authorUrl?: string | null;

  @Field(() => String, { nullable: true })
  siteName?: string | null;

  @Field(() => String, { nullable: true })
  description?: string | null;

  /** The provider's own page for the thing (Wikipedia article, canonical watch URL). */
  @Field(() => String, { nullable: true })
  canonicalUrl?: string | null;

  /** Poster: the locally cached copy when one exists, else the provider's URL. */
  @Field(() => String, { nullable: true })
  thumbnailUrl?: string | null;

  @Field(() => Int, { nullable: true })
  durationSeconds?: number | null;

  /** Stable catalogue reference, e.g. `wikidata:Q28443710`. */
  @Field(() => String, { nullable: true })
  externalRef?: string | null;

  /** Provider-specific extras (year, rating, season/episode, og:type…). */
  @Field(() => GraphQLJSONObject)
  payload!: Record<string, unknown>;

  @Field(() => Date)
  fetchedAt!: Date;

  static toType(view: UnfurlView): UnfurlType {
    return { ...view };
  }
}
