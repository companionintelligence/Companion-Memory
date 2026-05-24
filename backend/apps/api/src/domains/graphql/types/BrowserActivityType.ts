import { Field, ID, ObjectType } from '@nestjs/graphql';

import { type BrowserActivity } from '@ci/domains/browser-activity';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { Taggable } from './Taggable';

@ObjectType({ implements: () => [Node, Taggable] })
export class BrowserActivityType implements Node, Taggable {
  __typename = BrowserActivityType.name;

  __source!: BrowserActivity;

  @Field(() => ID)
  id!: string;

  @Field(() => String)
  url!: string;

  @Field(() => String, { nullable: true })
  title!: string | null;

  @Field(() => String, { nullable: true })
  actionType!: string | null;

  @Field(() => Number, { nullable: true })
  duration!: number | null;

  @Field(() => Number, { nullable: true })
  scrollDepth!: number | null;

  @Field(() => Date)
  time!: Date;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  static toType(activity: BrowserActivity): BrowserActivityType {
    return {
      __typename: BrowserActivityType.name,
      __source: activity,
      id: GlobalUID.encode('browser-activity', activity.id),
      url: activity.url,
      title: activity.title ?? null,
      actionType: activity.action_type ?? null,
      duration: activity.duration_seconds ?? null,
      scrollDepth: activity.scroll_depth_percent ?? null,
      time: activity.time,
      tags: [], // Hydrated by resolver
    };
  }
}
