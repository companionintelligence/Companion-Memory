import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { type Tag } from '@ci/domains/search-next';

import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

export enum TagKindEnum {
  direction = 'direction',
  intention = 'intention',
  category = 'category',
}

registerEnumType(TagKindEnum, {
  name: 'TagKind',
  description:
    "The taxonomy LEVEL a tag sits at: a brand-set direction (Home/Work/Community), an intention grouped under directions, or a category grouped over intentions. Orthogonal to a tag application's level on EntityTagType, which is a per-entity dilution weight, not a taxonomy level.",
});

@ObjectType({ implements: () => [Node] })
export class TagType {
  __typename = TagType.name;

  __source!: Tag;

  @Field(() => ID)
  id!: string;

  @Field(() => String)
  label!: string;

  @Field(() => String, { nullable: true })
  description!: string | null;

  /** Untyped (null) for every tag that predates the taxonomy. */
  @Field(() => TagKindEnum, { nullable: true })
  kind!: TagKindEnum | null;

  /** Set-aside: excluded from what the app volunteers on its own, never from reads or manual application. */
  @Field(() => Boolean)
  muted!: boolean;

  /** A brand-set direction (Home/Work/Community). Undeletable. */
  @Field(() => Boolean)
  isBase!: boolean;

  /** Resolved by TagResolver.entityCount; the placeholder is never served. */
  @Field(() => Int)
  entityCount!: number;

  static toType(tag: Tag): TagType {
    return {
      __typename: TagType.name,
      __source: tag,
      id: GlobalUID.encode('tag', tag.id),
      label: tag.label,
      description: tag.description,
      kind: tag.kind == null ? null : (tag.kind as TagKindEnum),
      muted: tag.muted,
      isBase: tag.isBase,
      entityCount: 0,
    };
  }
}
