import { Field, Float, ObjectType, registerEnumType } from '@nestjs/graphql';

import type { ObjectIdentifier, ObjectIdentifierNamespace } from '@ci/domains/graph';

/**
 * The identifier namespaces `ci.object_identifiers.namespace` accepts.
 *
 * Declared as `satisfies Record<Uppercase<T>, T>` for the same reason
 * {@link ItemUnitSystem} is: widening the domain union (and the CHECK
 * constraint behind it) without widening this enum becomes a compile error, so
 * the API vocabulary and the database vocabulary cannot drift apart silently.
 */
export const ObjectIdentifierNamespaceEnum = {
  GTIN: 'gtin',
  ISBN: 'isbn',
  ASIN: 'asin',
  MPN: 'mpn',
  SKU: 'sku',
  SERIAL: 'serial',
  IMEI: 'imei',
  VIN: 'vin',
  ORDER_ID: 'order_id',
  RFID: 'rfid',
  QR: 'qr',
  CUSTOM: 'custom',
} as const satisfies Record<Uppercase<ObjectIdentifierNamespace>, ObjectIdentifierNamespace>;

export type ObjectIdentifierNamespaceEnum =
  (typeof ObjectIdentifierNamespaceEnum)[keyof typeof ObjectIdentifierNamespaceEnum];

registerEnumType(ObjectIdentifierNamespaceEnum, {
  name: 'ObjectIdentifierNamespace',
  description:
    'What kind of code an identifier is. gtin/isbn/asin/imei/vin are globally unique; the rest are unique only within a scope.',
});

/**
 * One identifier claimed by a physical thing — a barcode, a serial, an order
 * number — as stored in `ci.object_identifiers`.
 *
 * `value` is the NORMALIZED form (the one lookups match on) and `rawValue` is
 * whatever the source printed. Both are surfaced because they answer different
 * questions: the normalized value is what a scan will find, the raw value is
 * what the user will recognise on the label.
 */
@ObjectType()
export class ObjectIdentifierType {
  @Field(() => ObjectIdentifierNamespaceEnum)
  namespace!: ObjectIdentifierNamespace;

  /** Normalized value — the form `normalizeObjectIdentifier` produced. */
  @Field(() => String)
  value!: string;

  /** Exactly what the source said, when it differed from the normalized form. */
  @Field(() => String, { nullable: true })
  rawValue!: string | null;

  /**
   * Scope for namespaces that are not globally unique (serial, sku); empty for
   * gtin/isbn/asin/imei/vin.
   */
  @Field(() => String)
  qualifier!: string;

  /** Confidence in the CLAIM: 1.0 = a human said so or it was scanned. */
  @Field(() => Float)
  confidence!: number;

  @Field(() => Boolean)
  isPrimary!: boolean;

  /** Provenance of the assertion (user, barcode_scan, receipt_ocr, importer:amazon, ...). */
  @Field(() => String, { nullable: true })
  source!: string | null;

  @Field(() => Date)
  createdAt!: Date;

  static toType(row: ObjectIdentifier): ObjectIdentifierType {
    return {
      namespace: row.namespace,
      value: row.valueNormalized,
      rawValue: row.valueRaw ?? null,
      qualifier: row.qualifier ?? '',
      confidence: row.confidence,
      isPrimary: row.isPrimary ?? false,
      source: row.source ?? null,
      createdAt: row.createdAt,
    };
  }
}
