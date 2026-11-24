import { Field, Float, InputType, registerEnumType } from '@nestjs/graphql';

import { GraphQLJSONObject } from '@ci/domains/graphql/scalars/JsonObjectScalar';
import type { AcquisitionMethod, UnitSystem } from '@ci/domains/memory';

/**
 * The GraphQL vocabulary of a physical thing.
 *
 * Both enums are declared as `satisfies Record<Uppercase<T>, T>`, which is the
 * whole point of writing them this way: adding a value to the database CHECK
 * constraint (and therefore to the domain union) without adding it here becomes
 * a compile error, and vice versa. The API and the schema cannot drift apart
 * silently.
 */
export const ItemUnitSystem = {
  METRIC: 'metric',
  IMPERIAL: 'imperial',
} as const satisfies Record<Uppercase<UnitSystem>, UnitSystem>;

export type ItemUnitSystem = (typeof ItemUnitSystem)[keyof typeof ItemUnitSystem];

registerEnumType(ItemUnitSystem, {
  name: 'ItemUnitSystem',
  description:
    'Display preference for measurements. Stored values are always SI (millimetres, grams, millilitres) whichever this is.',
});

export const ItemAcquisitionMethod = {
  PURCHASED: 'purchased',
  GIFT: 'gift',
  INHERITED: 'inherited',
  FOUND: 'found',
  MADE: 'made',
  BORROWED: 'borrowed',
  TRADED: 'traded',
  SAMPLE: 'sample',
  UNKNOWN: 'unknown',
} as const satisfies Record<Uppercase<AcquisitionMethod>, AcquisitionMethod>;

export type ItemAcquisitionMethod = (typeof ItemAcquisitionMethod)[keyof typeof ItemAcquisitionMethod];

registerEnumType(ItemAcquisitionMethod, {
  name: 'ItemAcquisitionMethod',
  description: 'How an item came to be owned. A purchase and a gift mean different things by acquiredAt.',
});

/**
 * The physical attributes shared by every item-writing mutation, so the three
 * inputs cannot drift into three different ideas of what an item is.
 *
 * Measurements are canonical SI — the field names say so — and the server
 * canonicalizes and bounds-checks every one of them before the write (see
 * `physicalProperties.ts`). `dimensions` is the one deliberately loose field:
 * it takes the form things are actually written in ("12 x 8 x 2 in") and fills
 * only the axes not given individually, which is what makes this usable from a
 * capture flow that has a label rather than a tape measure.
 */
@InputType()
export class PhysicalItemPropertiesInput {
  @Field(() => Float, { nullable: true, description: 'Longest dimension, in millimetres.' })
  lengthMm?: number;

  @Field(() => Float, { nullable: true, description: 'Width, in millimetres.' })
  widthMm?: number;

  @Field(() => Float, { nullable: true, description: 'Height, in millimetres.' })
  heightMm?: number;

  @Field(() => Float, { nullable: true, description: 'As-owned mass, in grams.' })
  massG?: number;

  @Field(() => Float, { nullable: true, description: 'Capacity — what it holds — in millilitres.' })
  volumeMl?: number;

  @Field(() => String, {
    nullable: true,
    description: 'Shorthand such as "12 x 8 x 2 in". Fills only the axes not given individually.',
  })
  dimensions?: string;

  @Field(() => ItemUnitSystem, { nullable: true })
  unitSystem?: ItemUnitSystem;

  @Field(() => [String], { nullable: true, description: 'Colour names, dominant first.' })
  colors?: string[];

  @Field(() => String, { nullable: true, description: 'Dominant colour as #rrggbb.' })
  colorHex?: string;

  @Field(() => [String], { nullable: true, description: 'What the object is made of.' })
  materials?: string[];

  @Field(() => GraphQLJSONObject, {
    nullable: true,
    description: '{material: fraction} summing to at most 1. Percentages are accepted and converted.',
  })
  composition?: Record<string, number>;

  @Field(() => ItemAcquisitionMethod, { nullable: true })
  acquisitionMethod?: ItemAcquisitionMethod;

  @Field(() => String, { nullable: true, description: 'Seller, giver or source, as free text.' })
  acquiredFrom?: string;

  @Field(() => Date, { nullable: true, description: 'When the object was made, not when it was acquired.' })
  manufacturedAt?: Date;

  @Field(() => Date, {
    nullable: true,
    description: 'When it stops being usable. Distinct from a warranty, which is a contract.',
  })
  expiresAt?: Date;

  @Field(() => Boolean, {
    nullable: true,
    description: 'A digital item is refused a mass, a size and a volume.',
  })
  isDigital?: boolean;
}
