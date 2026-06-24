import { Field, Float, ID, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

@InputType()
export class CreateItemInput {
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
  purchasePrice?: number;

  @Field(() => Float, { nullable: true })
  currentValue?: number;

  @Field(() => String, { nullable: true })
  currency?: string;

  @Field(() => Date, { nullable: true })
  acquiredAt?: Date;

  @Field(() => GraphQLJSONObject, { nullable: true })
  metadata?: Record<string, unknown>;

  // Provenance triple for imported items, persisted to dedicated columns
  // (inventory_source_triple_uniq). Idempotent re-sync is handled by the batch
  // createInventory mutation (ItemService.createMany); on the singular path here
  // they are simply recorded on the row.
  @Field(() => String, { nullable: true })
  sourceType?: string;

  @Field(() => String, { nullable: true })
  sourceSystem?: string;

  @Field(() => ID, { nullable: true })
  sourceId?: string;
}
