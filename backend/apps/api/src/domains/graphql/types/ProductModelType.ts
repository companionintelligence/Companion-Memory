import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import { type ProductModel } from '@ci/domains/memory';

import { EntityTagType } from './EntityTagType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';
import { ObjectIdentifierType } from './ObjectIdentifierType';
import { Taggable } from './Taggable';

/**
 * A catalog MODEL — the kind of thing, not a thing you own.
 *
 * The product/instance split is the whole point of this type: "Bose QC45" is a
 * product model, and the pair on your desk is an {@link ItemType} that is an
 * INSTANCE_OF it. A GTIN identifies the model (every unit shares it); a serial
 * identifies one unit. Merging that distinction away is what made the old
 * objects table unable to answer either question well.
 *
 * Money is integer MINOR units of `currency` (1299 = $12.99). Never a float of
 * dollars — see `minorUnits.ts`.
 */
@ObjectType({ implements: () => [Node, Taggable] })
export class ProductModelType implements Node, Taggable {
  __typename = ProductModelType.name;

  __source!: ProductModel;

  @Field(() => ID)
  id!: string;

  @Field(() => String)
  title!: string;

  @Field(() => String, { nullable: true })
  brand!: string | null;

  @Field(() => String, { nullable: true })
  manufacturer!: string | null;

  @Field(() => String, { nullable: true })
  modelNumber!: string | null;

  @Field(() => String, { nullable: true })
  category!: string | null;

  @Field(() => String, { nullable: true })
  subcategory!: string | null;

  @Field(() => String, { nullable: true })
  productType!: string | null;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => GraphQLJSONObject, {
    description: 'Variant AXES only ({color, capacity, size}) — never descriptive specs.',
  })
  variantAttributes!: Record<string, unknown>;

  @Field(() => GraphQLJSONObject, { description: 'Descriptive specifications.' })
  spec!: Record<string, unknown>;

  @Field(() => Int, {
    nullable: true,
    description: 'Manufacturer list price in integer MINOR units of `currency`.',
  })
  msrpMinor!: number | null;

  @Field(() => String, { nullable: true })
  currency!: string | null;

  @Field(() => ID, { nullable: true, description: 'ci.content row holding the catalog image.' })
  imageContentId!: string | null;

  @Field(() => [ID], { nullable: true, description: 'ci.content rows holding manuals.' })
  manualContentIds!: string[] | null;

  @Field(() => Boolean)
  isDigital!: boolean;

  @Field(() => Float, {
    description:
      'How sure we are this model is a real, distinct product. 1.0 = asserted by a human or a catalog; lower = derived from a receipt line or a vision guess.',
  })
  identityConfidence!: number;

  @Field(() => ID, { nullable: true, description: 'The ci.entities node mirroring this model.' })
  productEntityId!: string | null;

  @Field(() => GraphQLJSONObject)
  metadata!: Record<string, unknown>;

  // --- Provenance triple ---------------------------------------------------

  @Field(() => String, { nullable: true })
  sourceType!: string | null;

  @Field(() => String, { nullable: true })
  sourceSystem!: string | null;

  @Field(() => String, { nullable: true })
  sourceId!: string | null;

  /** Identifiers claimed by the MODEL (gtin, asin, mpn). Hydrated by the resolver. */
  @Field(() => [ObjectIdentifierType])
  identifiers!: ObjectIdentifierType[];

  @Field(() => [EntityTagType])
  tags!: EntityTagType[];

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  static toType(product: ProductModel): ProductModelType {
    return {
      __typename: ProductModelType.name,
      __source: product,
      id: GlobalUID.encode('product', product.id),
      title: product.title,
      brand: product.brand,
      manufacturer: product.manufacturer,
      modelNumber: product.modelNumber,
      category: product.category,
      subcategory: product.subcategory,
      productType: product.productType,
      description: product.description,
      variantAttributes: product.variantAttributes ?? {},
      spec: product.spec ?? {},
      msrpMinor: product.msrpMinor,
      currency: product.currency,
      imageContentId: product.imageContentId,
      manualContentIds: product.manualContentIds,
      isDigital: product.isDigital,
      identityConfidence: product.identityConfidence,
      productEntityId: product.productEntityId,
      metadata: product.metadata ?? {},
      sourceType: product.sourceType,
      sourceSystem: product.sourceSystem,
      sourceId: product.sourceId,

      identifiers: [], // Hydrated by resolver
      tags: [], // Hydrated by resolver
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }
}
