import { Field, Float, InputType, Int } from '@nestjs/graphql';
import { GraphQLJSONObject } from '@ci/domains/graphql/scalars/JsonObjectScalar';

import { ItemCondition } from './ItemType';
import { PhysicalItemPropertiesInput } from './PhysicalItemProperties';

/**
 * Creating a thing by hand. Extends {@link PhysicalItemPropertiesInput}, which
 * carries the size/mass/colour/material half — the same fields the update and
 * bulk-ingest inputs get, so all three describe one concept of an item.
 */
@InputType()
export class CreateItemInput extends PhysicalItemPropertiesInput {
  @Field(() => String)
  name!: string;

  @Field(() => String, { nullable: true })
  description?: string;

  @Field(() => String, { nullable: true })
  category?: string;

  @Field(() => String, { nullable: true })
  subcategory?: string;

  @Field(() => String, { nullable: true })
  brand?: string;

  @Field(() => String, { nullable: true })
  model?: string;

  @Field(() => Float, { nullable: true })
  currentValue?: number;

  @Field(() => Float, { nullable: true })
  purchasePrice?: number;

  @Field(() => String, { nullable: true })
  currency?: string;

  @Field(() => Date, { nullable: true, description: 'When it was bought or received.' })
  acquiredAt?: Date;

  @Field(() => ItemCondition, { nullable: true })
  condition?: ItemCondition;

  @Field(() => Int, { nullable: true })
  quantity?: number;

  @Field(() => GraphQLJSONObject, { nullable: true, description: 'Serial number, UPC, ISBN, order id, …' })
  identifierCodes?: Record<string, unknown>;

  @Field(() => GraphQLJSONObject, { nullable: true })
  metadata?: Record<string, unknown>;
}
