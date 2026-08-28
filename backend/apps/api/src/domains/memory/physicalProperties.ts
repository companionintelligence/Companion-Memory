/**
 * The physical half of an thing: how big it is, what it weighs, what
 * colour it is, and what it is made of.
 *
 * `ci.objects` stores one unit per measurement — millimetres, grams,
 * millilitres — and the database refuses anything else (see migration
 * `20260818020839_expand_inventory_physical_properties`). Units therefore have
 * to be resolved BEFORE a write, and exactly once, or the same column ends up
 * holding inches from one writer and millimetres from another. This module is
 * that one place.
 *
 * It has to be tolerant on the way in, because the writers are not uniform: a
 * human types `12"`, a vision model emits `"about 30 cm"`, an importer sends a
 * bare number, a marketplace feed sends `1,200 g`. It is strict on the way out:
 * every value it returns is canonical, finite, strictly positive, rounded to
 * the scale of its column, and inside the bounds the CHECK constraints enforce
 * — so a value that survives this module cannot be rejected by the database.
 *
 * Every invariant here has a twin in SQL. When one changes, change both:
 *
 * | here                        | schema                                  |
 * |-----------------------------|-----------------------------------------|
 * | `MAX_DIMENSION_MM` etc.     | `objects_*_positive_check`            |
 * | `normalizeColors`           | `objects_colors_check`                |
 * | `normalizeMaterials`        | `objects_materials_check`             |
 * | `normalizeColorHex`         | `objects_color_hex_check`             |
 * | `normalizeComposition`      | `ci.is_normalized_composition`          |
 * | `UNIT_SYSTEMS`              | `objects_unit_system_check`           |
 * | `ACQUISITION_METHODS`       | `objects_acquisition_method_check`    |
 * | digital-item rule           | `objects_digital_is_incorporeal_check`|
 *
 * One rule has no twin in SQL, and cannot: a measurement that is merely WRONG
 * is indistinguishable from a right one to a CHECK constraint. The bounds catch
 * a unit mix-up that reads high (metres into a millimetre column) and nothing
 * catches one that reads low — an unlabelled `30` for a 30 cm object stores
 * 30 mm and looks perfectly reasonable. Hence {@link MeasurementOptions.requireUnit}
 * and the mandatory unit on {@link parseDimensions}: the only defence against a
 * silent under-read is refusing to guess in the first place.
 */

/** Thrown for input this module cannot honestly canonicalize. Callers map it to a 400. */
export class PhysicalPropertyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhysicalPropertyError';
  }
}

/** Display preference only — stored measurements are always SI. */
export const UNIT_SYSTEMS = ['metric', 'imperial'] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

export const ACQUISITION_METHODS = [
  'purchased',
  'gift',
  'inherited',
  'found',
  'made',
  'borrowed',
  'traded',
  'sample',
  'unknown',
] as const;
export type AcquisitionMethod = (typeof ACQUISITION_METHODS)[number];

// Bounds mirror the CHECK constraints. They are far above any real possession;
// their job is to catch a caller writing the wrong unit into a canonical
// column, which is always wrong by a factor of a thousand or more.
export const MAX_DIMENSION_MM = 10_000_000; // 10 km
export const MAX_MASS_G = 1_000_000_000; // 1000 t
export const MAX_VOLUME_ML = 100_000_000; // 100 kL

/** Matches `cardinality(...) BETWEEN 1 AND 12` in both array CHECKs. */
export const MAX_ARRAY_TERMS = 12;

/** Matches the `<= 1.001` tolerance in `ci.is_normalized_composition`. */
const COMPOSITION_SUM_TOLERANCE = 1.001;

/** Numeric scale of the measurement columns — round here so a read-back is identical. */
const MEASUREMENT_SCALE = 3;

// Conversion factors are exact by definition of the international inch/pound
// (1 in = 25.4 mm, 1 lb = 453.59237 g), so no value here is an approximation.
const LENGTH_UNITS_TO_MM: Record<string, number> = {
  nm: 0.000001,
  um: 0.001,
  µm: 0.001,
  micron: 0.001,
  microns: 0.001,
  mm: 1,
  millimeter: 1,
  millimeters: 1,
  millimetre: 1,
  millimetres: 1,
  cm: 10,
  centimeter: 10,
  centimeters: 10,
  centimetre: 10,
  centimetres: 10,
  dm: 100,
  m: 1000,
  meter: 1000,
  meters: 1000,
  metre: 1000,
  metres: 1000,
  km: 1_000_000,
  kilometer: 1_000_000,
  kilometers: 1_000_000,
  in: 25.4,
  inch: 25.4,
  inches: 25.4,
  '"': 25.4,
  '”': 25.4,
  '″': 25.4,
  ft: 304.8,
  foot: 304.8,
  feet: 304.8,
  "'": 304.8,
  '’': 304.8,
  '′': 304.8,
  yd: 914.4,
  yard: 914.4,
  yards: 914.4,
};

const MASS_UNITS_TO_G: Record<string, number> = {
  mcg: 0.000001,
  ug: 0.000001,
  µg: 0.000001,
  mg: 0.001,
  milligram: 0.001,
  milligrams: 0.001,
  g: 1,
  gram: 1,
  grams: 1,
  gramme: 1,
  grammes: 1,
  kg: 1000,
  kilo: 1000,
  kilos: 1000,
  kilogram: 1000,
  kilograms: 1000,
  kilogramme: 1000,
  kilogrammes: 1000,
  t: 1_000_000,
  tonne: 1_000_000,
  tonnes: 1_000_000,
  oz: 28.349523125,
  ounce: 28.349523125,
  ounces: 28.349523125,
  lb: 453.59237,
  lbs: 453.59237,
  pound: 453.59237,
  pounds: 453.59237,
  st: 6350.29318,
  stone: 6350.29318,
};

// US customary for the fluid units — the volumes a US-facing appliance is
// handed. An imperial pint is a different quantity; it is deliberately absent
// rather than silently wrong.
const VOLUME_UNITS_TO_ML: Record<string, number> = {
  ml: 1,
  milliliter: 1,
  milliliters: 1,
  millilitre: 1,
  millilitres: 1,
  cc: 1,
  cm3: 1,
  cl: 10,
  dl: 100,
  l: 1000,
  liter: 1000,
  liters: 1000,
  litre: 1000,
  litres: 1000,
  m3: 1_000_000,
  tsp: 4.92892159375,
  teaspoon: 4.92892159375,
  teaspoons: 4.92892159375,
  tbsp: 14.78676478125,
  tablespoon: 14.78676478125,
  tablespoons: 14.78676478125,
  floz: 29.5735295625,
  'fl oz': 29.5735295625,
  cup: 236.5882365,
  cups: 236.5882365,
  pt: 473.176473,
  pint: 473.176473,
  pints: 473.176473,
  qt: 946.352946,
  quart: 946.352946,
  quarts: 946.352946,
  gal: 3785.411784,
  gallon: 3785.411784,
  gallons: 3785.411784,
};

interface Dimension {
  /** Canonical-unit factors keyed by every spelling we accept. */
  units: Record<string, number>;
  /** The unit a bare number is already in. */
  canonical: string;
  max: number;
  label: string;
}

const LENGTH: Dimension = {
  units: LENGTH_UNITS_TO_MM,
  canonical: 'mm',
  max: MAX_DIMENSION_MM,
  label: 'length',
};
const MASS: Dimension = { units: MASS_UNITS_TO_G, canonical: 'g', max: MAX_MASS_G, label: 'mass' };
const VOLUME: Dimension = { units: VOLUME_UNITS_TO_ML, canonical: 'ml', max: MAX_VOLUME_ML, label: 'volume' };

/** `12`, `12.5 cm`, `5 ft 11 in`, `1 kg 250 g`, `12"`. */
const QUANTITY_PATTERN = /(-?\d+(?:\.\d+)?)\s*([a-zµ³²"'’′”″]*)/g;

/** Hedges a human or a vision model puts around a measurement. Ignorable, not unreadable. */
const HEDGE_WORDS = new Set([
  'about',
  'approx',
  'approx.',
  'approximately',
  '~',
  'circa',
  'ca',
  'ca.',
  'roughly',
  'around',
  'est',
  'est.',
  'estimated',
  'or',
  'so',
]);

/**
 * Digits with a comma are ambiguous across locales, and both readings are
 * common in the data this ingests. Resolve the unambiguous case (a comma with
 * exactly three digits after it is a thousands separator) and treat the rest as
 * a decimal point, which is the only reading that can be right for `1,5`.
 */
function normalizeDecimalSeparators(input: string): string {
  return input.replace(/(\d),(\d{3})(?!\d)/g, '$1$2').replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2');
}

function lookupUnit(dimension: Dimension, token: string): number | null {
  const cleaned = token.trim().replace(/\s+/g, ' ').replace(/\.$/, '');

  if (cleaned === '') {
    return null;
  }

  const factor = dimension.units[cleaned] ?? dimension.units[cleaned.replace(/\s+/g, '')];

  return factor ?? null;
}

/**
 * Resolves any accepted spelling of a measurement to its canonical unit.
 *
 * A bare number is taken as already canonical — the fields are named for their
 * unit (`lengthMm`, `massG`), so that reading is the one the caller declared.
 * Multi-term input sums (`5 ft 11 in`), which is how humans and vision models
 * write a single measurement.
 */
function parseMeasurement(
  dimension: Dimension,
  input: unknown,
  field: string,
  options: MeasurementOptions = {},
): number | null {
  if (input == null || input === '') {
    return null;
  }

  if (typeof input === 'number') {
    if (options.requireUnit) {
      throw new PhysicalPropertyError(
        `${field}: a bare number cannot be trusted from this source — state the unit (e.g. "30 cm").`,
      );
    }

    return finalizeMeasurement(dimension, input, field);
  }

  if (typeof input !== 'string') {
    throw new PhysicalPropertyError(
      `${field}: expected a number or a measurement string, got ${typeof input}`,
    );
  }

  // `fl oz` is the one accepted unit spelled with a space; folding it here
  // keeps the quantity pattern's unit token space-free, which is what makes
  // leftover text detectable at all.
  const text = normalizeDecimalSeparators(input.trim().toLowerCase()).replace(/\bfl\.?\s*oz\b/g, 'floz');

  if (text === '' || /^(unknown|n\/a|na|none|null)$/.test(text)) {
    return null;
  }

  let total = 0;
  let terms = 0;

  for (const match of text.matchAll(QUANTITY_PATTERN)) {
    const [, rawValue, rawUnit] = match;
    const value = Number(rawValue);

    if (!Number.isFinite(value)) {
      throw new PhysicalPropertyError(`${field}: cannot read a number from ${JSON.stringify(input)}`);
    }

    const factor = lookupUnit(dimension, rawUnit ?? '');

    if (factor == null) {
      const unit = (rawUnit ?? '').trim();

      // A bare number is canonical ONLY when the caller vouches for the unit —
      // which a named field like `lengthMm` does and a machine-written string
      // does not. Guessing is exactly the failure this module exists to
      // prevent, and guessing LOW is the dangerous direction: the sanity bounds
      // are upper-only, so an unlabelled "30" for a 30 cm object reads as 30 mm
      // and passes every check.
      if (unit === '' && options.requireUnit) {
        throw new PhysicalPropertyError(
          `${field}: ${JSON.stringify(String(input))} has no unit. State it (e.g. "30 cm", "12 in") — ` +
            'an unlabelled number would be read as ' +
            `${dimension.canonical} and silently under-read the object.`,
        );
      }

      if (unit !== '') {
        throw new PhysicalPropertyError(
          `${field}: unknown ${dimension.label} unit ${JSON.stringify(unit)}. ` +
            `Use one of: ${Object.keys(dimension.units).slice(0, 8).join(', ')}, … or a bare number in ${dimension.canonical}.`,
        );
      }

      total += value;
    } else {
      total += value * factor;
    }

    terms += 1;
  }

  if (terms === 0) {
    throw new PhysicalPropertyError(
      `${field}: cannot read a ${dimension.label} from ${JSON.stringify(input)}`,
    );
  }

  // Whatever the pattern did not consume is text this module did not
  // understand. Silence there is the dangerous outcome: `12 cm wide by 8 deep`
  // would otherwise store 12 mm and drop the rest without a word.
  const leftover = text
    .replace(QUANTITY_PATTERN, ' ')
    .split(/\s+/)
    .filter((word) => word !== '' && !HEDGE_WORDS.has(word));

  if (leftover.length > 0) {
    throw new PhysicalPropertyError(
      `${field}: could not interpret ${JSON.stringify(leftover.join(' '))} in ${JSON.stringify(input)}`,
    );
  }

  return finalizeMeasurement(dimension, total, field);
}

function finalizeMeasurement(dimension: Dimension, value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new PhysicalPropertyError(`${field}: ${dimension.label} must be a finite number`);
  }

  const rounded = Number(value.toFixed(MEASUREMENT_SCALE));

  // Zero is not a measurement, it is an unmeasured field wearing a number. NULL
  // is the only honest way to say "unknown", and the CHECK constraints agree.
  if (rounded <= 0) {
    throw new PhysicalPropertyError(
      `${field}: ${dimension.label} must be greater than zero (got ${value}). Leave it unset if it is unknown.`,
    );
  }

  if (rounded > dimension.max) {
    throw new PhysicalPropertyError(
      `${field}: ${rounded}${dimension.canonical} exceeds the maximum of ${dimension.max}${dimension.canonical} — ` +
        'this is usually a unit mix-up rather than a real object.',
    );
  }

  return rounded;
}

/**
 * How much the caller is trusted to have meant the canonical unit.
 *
 * `requireUnit` is for writers that cannot vouch for it — a vision model asked
 * for "30 x 20 x 5 cm" that answers "30 x 20 x 5", an importer echoing a
 * product feed's unlabelled number. For those, a missing unit must be an error,
 * never an assumption.
 */
export interface MeasurementOptions {
  requireUnit?: boolean;
}

/** Canonicalizes a length to millimetres. Bare numbers are already millimetres. */
export function parseLengthMm(input: unknown, field = 'length', options?: MeasurementOptions): number | null {
  return parseMeasurement(LENGTH, input, field, options);
}

/** Canonicalizes a mass to grams. Bare numbers are already grams. */
export function parseMassG(input: unknown, field = 'mass', options?: MeasurementOptions): number | null {
  return parseMeasurement(MASS, input, field, options);
}

/** Canonicalizes a volume to millilitres. Bare numbers are already millilitres. */
export function parseVolumeMl(input: unknown, field = 'volume', options?: MeasurementOptions): number | null {
  return parseMeasurement(VOLUME, input, field, options);
}

export interface ParsedDimensions {
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

/**
 * Reads the form dimensions are actually written in — `12 x 8 x 2 in`,
 * `30×20cm`, `10" x 4"` — where a trailing unit governs every term before it.
 * Two terms mean length and width; the height stays unknown.
 *
 * A UNIT IS MANDATORY here, unlike the named `lengthMm`-style fields. This
 * shorthand exists for text a human or a model wrote, and `30 x 20 x 5` from
 * either of them means centimetres far more often than millimetres — but read
 * as canonical it becomes a 30 mm desk that every CHECK constraint accepts,
 * because the sanity bounds only guard the high side. A caller that genuinely
 * has millimetres has the millimetre fields.
 */
export function parseDimensions(input: unknown, field = 'dimensions'): ParsedDimensions {
  const empty: ParsedDimensions = { lengthMm: null, widthMm: null, heightMm: null };

  if (input == null || typeof input !== 'string' || input.trim() === '') {
    return empty;
  }

  const parts = input
    .toLowerCase()
    .split(/\s*[x×*]\s*/)
    .map((part) => part.trim())
    .filter((part) => part !== '');

  if (parts.length === 0) {
    return empty;
  }

  if (parts.length > 3) {
    throw new PhysicalPropertyError(`${field}: expected at most three terms, got ${parts.length}`);
  }

  // The unit is conventionally written once, at the end: `12 x 8 x 2 in`.
  const trailingUnit = /[a-z"'’′”″µ]+\s*$/.exec(parts[parts.length - 1] ?? '')?.[0]?.trim() ?? '';
  const suffix = trailingUnit === '' ? '' : ` ${trailingUnit}`;

  const values = parts.map((part, index) => {
    const hasOwnUnit = /[a-z"'’′”″µ]/.test(part);

    return parseLengthMm(hasOwnUnit ? part : `${part}${suffix}`, `${field}[${index}]`, {
      requireUnit: true,
    });
  });

  return {
    lengthMm: values[0] ?? null,
    widthMm: values[1] ?? null,
    heightMm: values[2] ?? null,
  };
}

function normalizeTerms(input: unknown, field: string): string[] | null {
  if (input == null) {
    return null;
  }

  const raw = typeof input === 'string' ? input.split(/[,;/]|\band\b/) : input;

  if (!Array.isArray(raw)) {
    throw new PhysicalPropertyError(`${field}: expected a list of terms or a comma-separated string`);
  }

  const seen = new Set<string>();

  for (const term of raw) {
    if (term == null) {
      continue;
    }

    if (typeof term !== 'string') {
      throw new PhysicalPropertyError(`${field}: every term must be a string, got ${typeof term}`);
    }

    // Lowercase + whitespace-collapsed is what the CHECK constraints test for;
    // the edge punctuation strip is what makes "leather." and "(leather)" the
    // same term as "leather" rather than three.
    const normalized = term
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

    if (normalized === '') {
      continue;
    }

    seen.add(normalized);
  }

  if (seen.size === 0) {
    // The empty array fails `cardinality(...) BETWEEN 1 AND 12`; NULL is how
    // the schema spells "none recorded".
    return null;
  }

  if (seen.size > MAX_ARRAY_TERMS) {
    throw new PhysicalPropertyError(
      `${field}: at most ${MAX_ARRAY_TERMS} terms are allowed, got ${seen.size}. ` +
        'A list this long is a description, not a set of attributes.',
    );
  }

  return [...seen];
}

/** Colour names, dominant first, lowercased and deduplicated. */
export function normalizeColors(input: unknown, field = 'colors'): string[] | null {
  return normalizeTerms(input, field);
}

/** Material names, lowercased and deduplicated. */
export function normalizeMaterials(input: unknown, field = 'materials'): string[] | null {
  return normalizeTerms(input, field);
}

/** `#rrggbb`, lowercased. Accepts `#rgb` shorthand and a missing `#`. */
export function normalizeColorHex(input: unknown, field = 'colorHex'): string | null {
  if (input == null || input === '') {
    return null;
  }

  if (typeof input !== 'string') {
    throw new PhysicalPropertyError(`${field}: expected a hex colour string, got ${typeof input}`);
  }

  const cleaned = input.trim().toLowerCase().replace(/^#/, '');

  if (/^[0-9a-f]{3}$/.test(cleaned)) {
    return `#${cleaned[0]!.repeat(2)}${cleaned[1]!.repeat(2)}${cleaned[2]!.repeat(2)}`;
  }

  if (/^[0-9a-f]{6}$/.test(cleaned)) {
    return `#${cleaned}`;
  }

  throw new PhysicalPropertyError(`${field}: ${JSON.stringify(input)} is not a #rrggbb colour`);
}

/**
 * `{material: fraction}` with lowercase keys and fractions in (0,1] summing to
 * at most 1.
 *
 * Percentages are accepted and converted, because that is how compositions are
 * written everywhere they are printed — a garment label says 80% cotton, and a
 * model asked for a composition returns `{"cotton": 80}`. The conversion only
 * fires when the values cannot be fractions (they sum above 1), so a genuine
 * `{"cotton": 0.8}` is never rescaled.
 */
export function normalizeComposition(input: unknown, field = 'composition'): Record<string, number> {
  if (input == null) {
    return {};
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new PhysicalPropertyError(`${field}: expected an object of {material: fraction}`);
  }

  const entries: Array<[string, number]> = [];

  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = rawKey.trim().toLowerCase().replace(/\s+/g, ' ');

    if (key === '') {
      throw new PhysicalPropertyError(`${field}: material names cannot be blank`);
    }

    const value = typeof rawValue === 'string' ? Number(rawValue.replace('%', '').trim()) : rawValue;

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new PhysicalPropertyError(`${field}: ${key} must be a number, got ${JSON.stringify(rawValue)}`);
    }

    if (value <= 0) {
      throw new PhysicalPropertyError(`${field}: ${key} must be greater than zero (got ${value})`);
    }

    entries.push([key, value]);
  }

  if (entries.length === 0) {
    return {};
  }

  if (entries.length > MAX_ARRAY_TERMS) {
    throw new PhysicalPropertyError(`${field}: at most ${MAX_ARRAY_TERMS} materials are allowed`);
  }

  const total = entries.reduce((sum, [, value]) => sum + value, 0);

  // Percentages are only recognised where the reading is unambiguous: a set
  // that totals about a hundred, or one whose every term is at least 1 (which
  // no set of fractions can be unless it is a single whole). `{cotton: 0.8,
  // wool: 0.8}` matches neither, so it stays a pair of fractions and is
  // correctly rejected below for claiming 160% of the object.
  const looksLikePercentages =
    total > COMPOSITION_SUM_TOLERANCE &&
    total <= 100.5 &&
    (total >= 50 || entries.every(([, value]) => value >= 1));
  const scale = looksLikePercentages ? 100 : 1;

  const normalized: Record<string, number> = {};
  let scaledTotal = 0;

  for (const [key, value] of entries) {
    // Four decimals keeps 1/3 honest while staying well inside the tolerance
    // the SQL predicate allows for the rounding it causes.
    const fraction = Number((value / scale).toFixed(4));

    if (fraction <= 0 || fraction > 1) {
      throw new PhysicalPropertyError(
        `${field}: ${key} resolves to ${fraction}, which is not a fraction between 0 and 1`,
      );
    }

    normalized[key] = fraction;
    scaledTotal += fraction;
  }

  if (scaledTotal > COMPOSITION_SUM_TOLERANCE) {
    throw new PhysicalPropertyError(
      `${field}: fractions sum to ${Number(scaledTotal.toFixed(4))}, which is more than the whole object`,
    );
  }

  return normalized;
}

export function normalizeUnitSystem(input: unknown, field = 'unitSystem'): UnitSystem | null {
  if (input == null || input === '') {
    return null;
  }

  const value = String(input).trim().toLowerCase();

  if ((UNIT_SYSTEMS as readonly string[]).includes(value)) {
    return value as UnitSystem;
  }

  // The two spellings a client is most likely to send for the same idea.
  if (value === 'us' || value === 'customary') {
    return 'imperial';
  }

  if (value === 'si') {
    return 'metric';
  }

  throw new PhysicalPropertyError(
    `${field}: expected one of ${UNIT_SYSTEMS.join(', ')}, got ${JSON.stringify(input)}`,
  );
}

export function normalizeAcquisitionMethod(
  input: unknown,
  field = 'acquisitionMethod',
): AcquisitionMethod | null {
  if (input == null || input === '') {
    return null;
  }

  const value = String(input)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if ((ACQUISITION_METHODS as readonly string[]).includes(value)) {
    return value as AcquisitionMethod;
  }

  const aliases: Record<string, AcquisitionMethod> = {
    bought: 'purchased',
    buy: 'purchased',
    purchase: 'purchased',
    gifted: 'gift',
    present: 'gift',
    given: 'gift',
    inherit: 'inherited',
    handed_down: 'inherited',
    built: 'made',
    diy: 'made',
    homemade: 'made',
    loan: 'borrowed',
    loaned: 'borrowed',
    trade: 'traded',
    swap: 'traded',
    free: 'sample',
    freebie: 'sample',
  };

  const alias = aliases[value];

  if (alias) {
    return alias;
  }

  throw new PhysicalPropertyError(
    `${field}: expected one of ${ACQUISITION_METHODS.join(', ')}, got ${JSON.stringify(input)}`,
  );
}

/** The physical attributes as they arrive — any accepted spelling, any unit. */
export interface PhysicalPropertiesInput {
  lengthMm?: unknown;
  widthMm?: unknown;
  heightMm?: unknown;
  massG?: unknown;
  volumeMl?: unknown;
  /** `12 x 8 x 2 in` — a shorthand for the three dimensions, applied when they are not given individually. */
  dimensions?: unknown;
  unitSystem?: unknown;
  colors?: unknown;
  colorHex?: unknown;
  materials?: unknown;
  composition?: unknown;
  acquisitionMethod?: unknown;
  isDigital?: unknown;
}

/** The same attributes, canonical and storable. Only the given keys are present. */
export interface NormalizedPhysicalProperties {
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  massG?: number | null;
  volumeMl?: number | null;
  unitSystem?: UnitSystem | null;
  colors?: string[] | null;
  colorHex?: string | null;
  materials?: string[] | null;
  composition?: Record<string, number>;
  acquisitionMethod?: AcquisitionMethod | null;
}

/**
 * Canonicalizes a whole patch of physical attributes, preserving the difference
 * between "not mentioned" (key absent) and "cleared" (key present, null) so it
 * is safe for partial updates.
 *
 * Two consistency rules are applied here rather than left to callers:
 * materials are derived from a composition that names materials the list
 * omits, and a digital item is refused a body.
 */
export function normalizePhysicalProperties(
  input: PhysicalPropertiesInput,
  options: MeasurementOptions = {},
): NormalizedPhysicalProperties {
  const result: NormalizedPhysicalProperties = {};

  if (input.lengthMm !== undefined) {
    result.lengthMm = parseLengthMm(input.lengthMm, 'lengthMm', options);
  }

  if (input.widthMm !== undefined) {
    result.widthMm = parseLengthMm(input.widthMm, 'widthMm', options);
  }

  if (input.heightMm !== undefined) {
    result.heightMm = parseLengthMm(input.heightMm, 'heightMm', options);
  }

  if (input.massG !== undefined) {
    result.massG = parseMassG(input.massG, 'massG', options);
  }

  if (input.volumeMl !== undefined) {
    result.volumeMl = parseVolumeMl(input.volumeMl, 'volumeMl', options);
  }

  // The shorthand fills only the axes the caller did not state outright, so an
  // explicit `heightMm` always wins over the third term of `dimensions`.
  if (input.dimensions != null && input.dimensions !== '') {
    const parsed = parseDimensions(input.dimensions, 'dimensions');

    if (result.lengthMm == null && parsed.lengthMm != null) {
      result.lengthMm = parsed.lengthMm;
    }

    if (result.widthMm == null && parsed.widthMm != null) {
      result.widthMm = parsed.widthMm;
    }

    if (result.heightMm == null && parsed.heightMm != null) {
      result.heightMm = parsed.heightMm;
    }
  }

  if (input.unitSystem !== undefined) {
    result.unitSystem = normalizeUnitSystem(input.unitSystem);
  }

  if (input.colors !== undefined) {
    result.colors = normalizeColors(input.colors);
  }

  if (input.colorHex !== undefined) {
    result.colorHex = normalizeColorHex(input.colorHex);
  }

  if (input.materials !== undefined) {
    result.materials = normalizeMaterials(input.materials);
  }

  if (input.composition !== undefined) {
    result.composition = normalizeComposition(input.composition);

    // A composition that names a material the list does not is a contradiction
    // between two columns describing the same fact. The composition is the
    // stricter statement, so it wins.
    const named = Object.keys(result.composition);

    if (named.length > 0) {
      const merged = [...new Set([...(result.materials ?? []), ...named])];

      if (merged.length <= MAX_ARRAY_TERMS) {
        result.materials = merged;
      }
    }
  }

  if (input.acquisitionMethod !== undefined) {
    result.acquisitionMethod = normalizeAcquisitionMethod(input.acquisitionMethod);
  }

  if (input.isDigital === true) {
    const corporeal = (['lengthMm', 'widthMm', 'heightMm', 'massG', 'volumeMl'] as const).filter(
      (key) => result[key] != null,
    );

    if (corporeal.length > 0) {
      throw new PhysicalPropertyError(
        `A digital item cannot have ${corporeal.join(', ')} — it has no physical body. ` +
          'Unset is_digital if this is a physical object.',
      );
    }
  }

  return result;
}
