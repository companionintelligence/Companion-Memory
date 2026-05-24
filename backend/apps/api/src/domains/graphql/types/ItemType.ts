import { Field, ID, ObjectType, Float, registerEnumType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { type Item } from '@ci/domains/memory';

import { EntityTagType } from './EntityTagType';
import { FileType } from './FileType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { Taggable } from './Taggable';

export enum ItemCondition {
  NEW = 'new',
  LIKE_NEW = 'like_new',
  GOOD = 'good',
  FAIR = 'fair',
  POOR = 'poor',
  BROKEN = 'broken',
  NA = 'n/a',
}

registerEnumType(ItemCondition, {
  name: 'ItemCondition',
});

@ObjectType({ implements: () => [Node, Taggable] })
export class ItemType implements Node, Taggable {
  __typename = ItemType.name;

  __source!: Item;

  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => String, { nullable: true })
  category!: string | null;

  @Field(() => String, { nullable: true })
  subcategory!: string | null;

  @Field(() => String, { nullable: true })
  brand!: string | null;

  @Field(() => String, { nullable: true })
  model!: string | null;

  @Field(() => Float, { nullable: true })
  currentValue!: number | null;

  @Field(() => String)
  currency!: string;

  @Field(() => Date, { nullable: true })
  acquiredAt!: Date | null;

  @Field(() => ItemCondition, { nullable: true })
  condition!: string | null;

  @Field(() => GraphQLJSONObject, { nullable: true })
  metadata?: Record<string, unknown> | null;

  @Field(() => FileType, { nullable: true, complexity: 5 })
  file?: FileType | null;

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  static toType(item: Item): ItemType {
    return {
      __typename: ItemType.name,
      __source: item,
      id: GlobalUID.encode('item', item.id),
      name: item.name,
      description: item.description,
      category: item.category,
      subcategory: item.subcategory,
      brand: item.brand,
      model: item.model,
      currentValue: item.currentValue,
      currency: item.currency,
      condition: item.condition,
      metadata: item.metadata,
      acquiredAt: item.acquiredAt,
      tags: [], // Hydrated by resolver
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
