import { Field, Float, InputType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { ItemCondition } from './ItemType';
import { PhysicalItemPropertiesInput } from './PhysicalItemProperties';

/**
 * Batch things ingest input for the importer. Carries the provenance triple
 * (sourceType, sourceSystem, sourceId) so re-ingest is idempotent — see the
 * objects_source_triple_uniq partial unique index and ItemService.createMany.
 *
 * Inherits the physical half from {@link PhysicalItemPropertiesInput}: an
 * importer that knows a product's size and weight (most product feeds do) has
 * somewhere to put them, and the server canonicalizes the units on the way in.
 */
@InputType()
export class CreateThingInput extends PhysicalItemPropertiesInput {
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

  @Field(() => ItemCondition, { nullable: true })
  condition?: ItemCondition;

  /** Serial number, UPC, ISBN, Amazon order id, etc. */
  @Field(() => GraphQLJSONObject, { nullable: true })
  identifierCodes?: Record<string, unknown>;

  /**
   * Full source metadata bag (importer-parsed fields without a first-class
   * column home — e.g. Amazon `Source`, raw `Total`, future fields). Persists
   * to objects.metadata so importers stop dropping correctly-parsed data.
   */
  @Field(() => GraphQLJSONObject, { nullable: true })
  metadata?: Record<string, unknown>;

  @Field(() => String, { nullable: true })
  sourceType?: string;

  @Field(() => String, { nullable: true })
  sourceSystem?: string;

  @Field(() => String, { nullable: true })
  sourceId?: string;
}
