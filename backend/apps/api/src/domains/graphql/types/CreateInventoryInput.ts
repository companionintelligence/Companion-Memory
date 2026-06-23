import { Field, Float, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { ItemCondition } from './ItemType';

/**
 * Batch inventory ingest input for the importer. Carries the provenance triple
 * (sourceType, sourceSystem, sourceId) so re-ingest is idempotent — see the
 * inventory_source_triple_uniq partial unique index and ItemService.createMany.
 */
@InputType()
export class CreateInventoryInput {
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

  @Field(() => Float, { nullable: true })
  purchasePrice?: number;

  @Field(() => Float, { nullable: true })
  currentValue?: number;

  @Field(() => String, { nullable: true })
  currency?: string;

  @Field(() => Date, { nullable: true })
  acquiredAt?: Date;

  @Field(() => ItemCondition, { nullable: true })
  condition?: ItemCondition;

  /** Serial number, UPC, ISBN, Amazon order id, etc. */
  @Field(() => GraphQLJSONObject, { nullable: true })
  identifierCodes?: Record<string, unknown>;

  @Field(() => String, { nullable: true })
  sourceType?: string;

  @Field(() => String, { nullable: true })
  sourceSystem?: string;

  @Field(() => String, { nullable: true })
  sourceId?: string;
}
