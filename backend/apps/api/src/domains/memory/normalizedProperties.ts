/**
 * Every memory-domain entity is persisted into the shared `ci.entities` table
 * with a single free-form jsonb `properties` column, yet each entity type
 * surfaces a chosen subset of those keys as first-class, named domain fields
 * (e.g. `PersonEntity.firstName` ← `properties.first_name`).
 *
 * These helpers map between the two representations for ANY entity, given that
 * entity's normalized-field map. They deal only in plain records and never
 * reference a concrete entity or DTO type — each entity layers its own typed
 * binding on top.
 */

/** A pair of `[jsonb storage key, camelCase named field]`. */
export type NormalizedFieldEntry = readonly [storageKey: string, fieldName: string];

/** An entity's normalized-field map: which stored keys become named fields. */
export type NormalizedFieldMap = ReadonlyArray<NormalizedFieldEntry>;

/**
 * A free-form properties bag that forbids the normalized storage keys `K` at
 * compile time — their value type collapses to `never`, so the only way to set
 * (or read) a normalized attribute is through its named field.
 */
export type PropertiesBag<K extends string = never> = Record<string, unknown> & Partial<Record<K, never>>;

/**
 * A raw jsonb record split into its normalized named fields and the leftover
 * bag. `K` is the union of normalized storage keys to forbid on `.properties`;
 * callers name it explicitly (e.g. `NormalizedPersonPropertyKey`). It defaults
 * to `never` — matching {@link PropertiesBag} — so an un-parameterized split
 * still yields a usable bag rather than one whose every key collapses to
 * `never`.
 */
export interface SplitProperties<K extends string = never> {
  /** The normalized attributes, keyed by their camelCase named field. */
  fields: Record<string, unknown>;
  /** Everything else — the source-specific data, normalized keys removed. */
  properties: PropertiesBag<K>;
}

/**
 * Maps the provided named fields onto their jsonb storage keys. Only fields
 * that are actually present (not `undefined`) are emitted, so callers can write
 * a subset without clobbering the rest.
 */
export function toNormalizedProperties(
  source: Record<string, unknown>,
  fields: NormalizedFieldMap,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [storageKey, fieldName] of fields) {
    const value = source[fieldName];

    if (value !== undefined) {
      normalized[storageKey] = value;
    }
  }

  return normalized;
}

/**
 * Splits a raw jsonb record into its normalized named fields and the leftover
 * source-specific bag. Read it for whichever half you need: `.properties` for
 * the clean bag (egress), or spread `.fields` to rebuild a domain input.
 *
 * Pass `K` (the union of normalized storage keys) to forbid those keys on the
 * returned `.properties` at compile time; it defaults to `never`, leaving the
 * bag an unrestricted `Record<string, unknown>`.
 */
export function splitProperties<K extends string = never>(
  raw: Record<string, unknown>,
  fields: NormalizedFieldMap,
): SplitProperties<K> {
  const named: Record<string, unknown> = {};
  const properties: Record<string, unknown> = { ...raw };

  for (const [storageKey, fieldName] of fields) {
    if (storageKey in raw) {
      named[fieldName] = raw[storageKey];
      delete properties[storageKey];
    }
  }

  return { fields: named, properties: properties as PropertiesBag<K> };
}
