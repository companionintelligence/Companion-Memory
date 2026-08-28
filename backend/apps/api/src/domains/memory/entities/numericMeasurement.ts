import type { ValueTransformer } from 'typeorm';

/**
 * Transformer for the `NUMERIC` measurement columns on `ci.objects`
 * (`length_mm`, `mass_g`, `volume_ml`, …).
 *
 * node-postgres hands `numeric` back as a JavaScript STRING and TypeORM adds no
 * conversion, so a column declared `number | null` on an entity is a string at
 * runtime — the bug `ItemEntity.purchasePrice` and `FileEntity.size` still
 * carry, where `mass + mass` concatenates instead of adding. Sibling of
 * {@link minorUnitsTransformer}, which fixes the same hazard for money; this
 * one is for measurements, which are legitimately fractional.
 *
 * Unlike money, a lossy read here is not a silent wrong balance — but it is
 * still a wrong number, so an unparseable or non-finite value throws rather
 * than becoming `NaN` and propagating.
 */
export const numericMeasurementTransformer: ValueTransformer = {
  /** DB (string | null) -> app (number | null). */
  from(value: string | number | null): number | null {
    if (value == null) {
      return null;
    }

    const parsed = typeof value === 'number' ? value : Number(value);

    if (!Number.isFinite(parsed)) {
      throw new Error(
        `numericMeasurementTransformer: non-numeric measurement from database: ${String(value)}`,
      );
    }

    return parsed;
  },

  /** App (number | null) -> DB. */
  to(value: number | null | undefined): number | null {
    if (value == null) {
      return null;
    }

    if (!Number.isFinite(value)) {
      throw new Error(
        `numericMeasurementTransformer: refusing to write a non-finite measurement (${value}).`,
      );
    }

    return value;
  },
};
