import { Field, Float, ID, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { ItemLifecycleState } from './ItemFilters';
import { ItemCondition } from './ItemType';
import { PhysicalItemPropertiesInput } from './PhysicalItemProperties';

/**
 * Editing a thing. Every field except `id`/`name` is optional and patch-shaped:
 * an omitted field is left alone, an explicit null clears it.
 */
@InputType()
export class UpdateItemInput extends PhysicalItemPropertiesInput {
  @Field(() => ID)
  id!: string;

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

  /**
   * Ownership state — lent out, lost, disposed, and the rest.
   *
   * The UI surfaced this read-only for as long as the API refused it, which
   * made the one field a person most wants to change about a thing they own the
   * one field they could not. `ItemService.update` has always applied it
   * (`objectIdentityPatch`); only the input type was missing.
   *
   * NOT nullable-as-clear like the rest of this patch: `objects.lifecycle_state`
   * is NOT NULL with a CHECK, so "no state" is not a state a thing can be in.
   * Omit the field to leave it alone.
   */
  @Field(() => ItemLifecycleState, { nullable: true })
  lifecycleState?: ItemLifecycleState;

  @Field(() => GraphQLJSONObject, { nullable: true })
  metadata?: Record<string, unknown>;
}
