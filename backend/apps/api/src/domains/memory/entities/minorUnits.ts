import type { ValueTransformer } from 'typeorm';

/**
 * Transformer for the BIGINT money columns introduced with the object-identity
 * tables (`*_minor`: integer minor units of an ISO-4217 currency).
 *
 * It exists because of a bug this codebase already has and must not repeat.
 * node-postgres returns `numeric` AND `bigint` as JavaScript STRINGS, and
 * TypeORM applies no conversion of its own. So `ItemEntity.purchasePrice` is
 * declared `number | null` and is a string at runtime — arithmetic on it
 * silently concatenates rather than adding, and `FileEntity.size` has the same
 * shape. The declared type is a lie no compiler can catch.
 *
 * Rather than declare every new money column `string`, which pushes the parsing
 * onto every caller, the conversion happens once here so the entity's declared
 * `number` is TRUE.
 *
 * Safe for money: JavaScript integers are exact to 2^53-1, which in minor units
 * is about 90 trillion dollars. Postgres BIGINT can technically exceed that, so
 * `from` throws rather than silently returning an imprecise number — a loud
 * failure on an absurd value beats a wrong balance.
 */
export const minorUnitsTransformer: ValueTransformer = {
  /** DB (string | null) -> app (number | null). */
  from(value: string | number | null): number | null {
    if (value == null) {
      return null;
    }

    const parsed = typeof value === 'number' ? value : Number(value);

    if (!Number.isFinite(parsed)) {
      throw new Error(`minorUnitsTransformer: non-numeric money value from database: ${String(value)}`);
    }

    if (!Number.isSafeInteger(parsed)) {
      throw new Error(
        `minorUnitsTransformer: money value ${String(value)} exceeds the exact integer range; ` +
          'it cannot be represented without loss.',
      );
    }

    return parsed;
  },

  /** App (number | null) -> DB. Rejects fractional input: minor units are whole by definition. */
  to(value: number | null | undefined): number | null {
    if (value == null) {
      return null;
    }

    if (!Number.isInteger(value)) {
      throw new Error(
        `minorUnitsTransformer: refusing to write fractional minor units (${value}). ` +
          'Convert to whole minor units before assigning (e.g. dollars * 100).',
      );
    }

    return value;
  },
};

/**
 * ISO-4217 currencies whose minor unit is NOT 1/100.
 *
 * Only the exceptions are listed; everything else is two decimal places. The
 * list matters because the legacy `ci.objects.purchase_price` column is
 * `DECIMAL(10,2)` in MAJOR units, so writing a receipt's minor-unit amount into
 * it needs the divisor — and dividing yen by 100 turns ¥1,200 into ¥12.
 */
const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

/** Decimal places in `currency`'s minor unit. Unknown or absent currencies are treated as 2. */
export function minorUnitExponent(currency: string | null | undefined): number {
  if (currency == null) {
    return 2;
  }

  return MINOR_UNIT_EXPONENTS[currency.trim().toUpperCase()] ?? 2;
}

/**
 * Integer minor units -> major units, for the LEGACY `DECIMAL` money columns
 * only (`ci.objects.purchase_price` / `current_value`).
 *
 * Nothing new should call this: new columns are `*_minor` BIGINT and stay in
 * minor units end to end. It exists so a receipt line can populate the decimal
 * column the existing Things UI already reads, without pretending every
 * currency has two decimal places.
 */
export function minorUnitsToDecimal(
  minor: number | null | undefined,
  currency: string | null | undefined,
): number | null {
  if (minor == null || !Number.isFinite(minor)) {
    return null;
  }

  return minor / 10 ** minorUnitExponent(currency);
}
