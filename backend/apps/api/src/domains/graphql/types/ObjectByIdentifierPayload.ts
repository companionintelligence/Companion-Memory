import { Field, Float, ObjectType, registerEnumType } from '@nestjs/graphql';

import type { ObjectIdentifierSubjectType } from '@ci/domains/graph';

import { ItemType } from './ItemType';
import { ObjectIdentifierNamespaceEnum } from './ObjectIdentifierType';
import { ProductModelType } from './ProductModelType';

/** Which table a resolved claim points into. */
export const ObjectIdentifierSubjectKind = {
  PRODUCT_MODEL: 'product_model',
  OBJECT_INSTANCE: 'object_instance',
} as const satisfies Record<Uppercase<ObjectIdentifierSubjectType>, ObjectIdentifierSubjectType>;

export type ObjectIdentifierSubjectKind =
  (typeof ObjectIdentifierSubjectKind)[keyof typeof ObjectIdentifierSubjectKind];

registerEnumType(ObjectIdentifierSubjectKind, {
  name: 'ObjectIdentifierSubjectType',
  description:
    'Whether a claim identifies a catalog MODEL (every unit shares a GTIN) or one owned INSTANCE (a serial).',
});

/**
 * The answer to a scan: what, if anything, this code already refers to.
 *
 * The entry point for the barcode flow, and deliberately not a bare item —
 * subject-polymorphism is the whole reason `ci.object_identifiers` exists. A
 * GTIN identifies the MODEL (`product` is set, `item` is not, and the caller is
 * being told "you know what this is"; `ownedItem` says whether you own one); a
 * serial identifies one owned INSTANCE (`item` is set). `matched: false` means
 * the code normalized fine and nothing claims it.
 *
 * A code that cannot be normalized at all — an unreadable barcode, a failed
 * check digit — also comes back unmatched rather than as an error: an
 * unreadable scan is a scan, not a client bug.
 */
@ObjectType()
export class ObjectByIdentifierPayload {
  @Field(() => Boolean)
  matched!: boolean;

  @Field(() => ObjectIdentifierNamespaceEnum, {
    nullable: true,
    description: 'The namespace the value normalized into — not always the one asked for.',
  })
  namespace?: string | null;

  /** The normalized value that was looked up. Null when it does not normalize. */
  @Field(() => String, { nullable: true })
  value?: string | null;

  @Field(() => ObjectIdentifierSubjectKind, { nullable: true })
  subjectType?: ObjectIdentifierSubjectType | null;

  @Field(() => Float, { nullable: true, description: 'Confidence in the CLAIM that was matched.' })
  confidence?: number | null;

  /** Set when the code identifies one owned unit (a serial, an IMEI, a VIN). */
  @Field(() => ItemType, { nullable: true })
  item?: ItemType | null;

  /**
   * For a model code, a unit of that model you own: linked to the model, or
   * carrying the code in its own `identifier_codes`, which is where an Amazon
   * import leaves an ASIN. One you still have comes first; a unit you returned
   * or used up is answered only when it is the only one. Null when you have no
   * unit of the model, and for an instance code.
   *
   * Not the claim holder, which is why it is not `item`: a caller asking who
   * holds a code (to offer a merge) must not be handed a unit that merely
   * shares the model.
   */
  @Field(() => ItemType, { nullable: true })
  ownedItem?: ItemType | null;

  /**
   * Set when the code identifies a catalog model (a GTIN, an ASIN).
   *
   * Also set when `item` is: an owned unit resolved by serial still carries the
   * model it is an instance of, so a scan answers "which one" and "what is it"
   * in one round trip.
   */
  @Field(() => ProductModelType, { nullable: true })
  product?: ProductModelType | null;
}
