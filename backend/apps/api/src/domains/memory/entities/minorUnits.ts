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
