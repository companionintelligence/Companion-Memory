import { Field, Float, Int, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

/**
 * Batch browser-activity ingest input for the importer. Carries the provenance
 * triple (sourceType, sourceSystem, sourceId) so re-ingest is idempotent — see
 * the browser_activity_source_triple_uniq partial unique index and
 * BrowserActivityService.createMany.
 */
@InputType()
export class CreateBrowserActivityInput {
  @Field(() => Date)
  time!: Date;

  @Field(() => String)
  url!: string;

  @Field(() => String, { nullable: true })
  title?: string;

  /** 'visit' | 'reload' | 'bookmark' | 'search' | 'download' | 'form_submit'. */
  @Field(() => String, { nullable: true })
  actionType?: string;

  @Field(() => GraphQLJSONObject, { nullable: true })
  properties?: Record<string, unknown>;

  @Field(() => Int, { nullable: true })
  durationSeconds?: number;

  @Field(() => Float, { nullable: true })
  scrollDepthPercent?: number;

  @Field(() => String, { nullable: true })
  pageSummary?: string;

  @Field(() => String, { nullable: true })
  category?: string;

  @Field(() => Float, { nullable: true })
  productivityScore?: number;

  @Field(() => Boolean, { nullable: true })
  isIncognito?: boolean;

  @Field(() => Boolean, { nullable: true })
  containsSensitive?: boolean;

  @Field(() => String, { nullable: true })
  deviceId?: string;

  @Field(() => String, { nullable: true })
  sourceType?: string;

  @Field(() => String, { nullable: true })
  sourceSystem?: string;

  @Field(() => String, { nullable: true })
  sourceId?: string;
}
