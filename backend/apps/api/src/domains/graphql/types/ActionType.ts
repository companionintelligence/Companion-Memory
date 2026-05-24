import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

import { type Action } from '@ci/domains/intelligence';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { Taggable } from './Taggable';

@ObjectType({ description: 'Metadata associated with an action' })
export class ActionMetadataType {
  @Field(() => Boolean, { description: 'Whether the user has seen/interacted with this action' })
  seen!: boolean;

  @Field(() => String, {
    nullable: true,
    description: 'Type of action: conversation_starter or time_suggestion',
  })
  type?: string;

  @Field(() => String, { nullable: true, description: 'Context explaining why this action is relevant' })
  context?: string;

  @Field(() => String, { nullable: true, description: 'Name of related person if applicable' })
  relatedPerson?: string;
}

@ObjectType({ implements: () => [Node, Taggable] })
export class ActionType implements Node, Taggable {
  __typename = ActionType.name;

  __source!: Action;

  @Field(() => ID)
  id!: string;

  @Field(() => String)
  title!: string | null;

  @Field(() => String)
  text!: string | null;

  @Field(() => String, { nullable: true })
  imageUrl!: string | null;

  @Field(() => Boolean)
  seen!: boolean;

  @Field(() => Boolean)
  dismissed!: boolean;

  @Field(() => Int, { nullable: true, description: 'Priority/relevance level 1-10' })
  priority!: number | null;

  @Field(() => ActionMetadataType, { description: 'Action metadata including seen status' })
  metadata!: ActionMetadataType;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  static toType(action: Action): ActionType {
    const metadata = (action.metadata || {}) as Record<string, unknown>;

    return {
      __typename: ActionType.name,
      __source: action,
      id: GlobalUID.encode('action', action.id),
      title: action.title,
      text: action.text,
      imageUrl: action.imageUrl,
      seen: action.seen ?? false,
      dismissed: action.dismissed ?? false,
      priority: action.priority,
      metadata: {
        seen: Boolean(metadata.seen),
        type: metadata.type as string | undefined,
        context: metadata.context as string | undefined,
        relatedPerson: metadata.related_person as string | undefined,
      },
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
      tags: [], // Resolved by ActionResolver
    };
  }
}
