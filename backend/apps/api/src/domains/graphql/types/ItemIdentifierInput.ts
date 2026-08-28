import { Field, ID, InputType } from '@nestjs/graphql';

import { ObjectIdentifierNamespaceEnum } from './ObjectIdentifierType';

/**
 * The scope half of a claim, for namespaces that are not globally unique.
 *
 * A serial number means nothing on its own — "SN-0001" is a different thing for
 * every manufacturer — so `serial`/`sku`/`mpn`/`order_id` claims carry a
 * qualifier derived from these. They are IGNORED for gtin/isbn/asin/imei/vin,
 * which are unique by construction. The qualifier is computed server-side by
 * `computeQualifier`; a caller never writes one directly, because a qualifier
 * derived by a second rule is a claim that can never be found again.
 */
@InputType()
export class ObjectIdentifierScopeInput {
  @Field(() => String, { nullable: true })
  brand?: string;

  @Field(() => String, { nullable: true })
  sourceSystem?: string;
}

@InputType()
export class AddItemIdentifierInput {
  @Field(() => ID)
  itemId!: string;

  @Field(() => ObjectIdentifierNamespaceEnum)
  namespace!: string;

  /** Raw value; normalized server-side with the shared object-identifier rule. */
  @Field(() => String)
  value!: string;

  @Field(() => ObjectIdentifierScopeInput, { nullable: true })
  scope?: ObjectIdentifierScopeInput;
}

@InputType()
export class RemoveItemIdentifierInput {
  @Field(() => ID)
  itemId!: string;

  @Field(() => ObjectIdentifierNamespaceEnum)
  namespace!: string;

  @Field(() => String)
  value!: string;

  @Field(() => ObjectIdentifierScopeInput, { nullable: true })
  scope?: ObjectIdentifierScopeInput;
}
