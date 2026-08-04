/**
 * Object-identifier normalization — the single source of truth for the rule
 * shared by the importer (which pre-normalizes barcodes off receipts and
 * product feeds) and the server (which normalizes scanned codes, receipt-OCR
 * output and defensively re-normalizes ingested identifiers). The two copies
 * MUST stay byte-identical or the `ci.object_identifiers` lookup silently
 * misses — the same failure mode documented on {@link normalizeIdentifier} for
 * people.
 *
 * The twin lives at CI-Import-Tools `backend/src/ci-server/objectIdentifiers.ts`
 * and is covered by the same vector table in both test suites.
 *
 * This is deliberately NOT reimplementable in SQL. GTIN-14 zero-padding with
 * mod-10 validation, ISBN-10 -> ISBN-13 conversion and IMEI Luhn cannot be kept
 * byte-identical between a SQL expression and this file, which is why the
 * backfill is a maintenance job that calls this function rather than an UPDATE.
 *
 * Rules, by namespace:
 *   - gtin   digits only; accept GTIN-8/12/13/14 with a valid mod-10 check
 *            digit; store zero-padded to 14. One barcode, one value, however
 *            it was printed. EXCEPT a Bookland (978/979) code with indicator
 *            digit 0, which is a book and is re-routed to `isbn` — see below.
 *   - isbn   ISBN-10 (check digit may be 'X') upconverted to ISBN-13 with the
 *            978 prefix and a recomputed check digit; ISBN-13 validated as a
 *            GTIN-13. Stored as 13 digits.
 *
 *            A book has ONE identity here regardless of how it arrives: its
 *            printed barcode (gtin), its ISBN-10 or ISBN-13, and the all-digit
 *            ASIN Amazon uses for books all normalize to the same 13 digits.
 *            Getting this wrong is not cosmetic — it means the book you bought
 *            and the book you scanned are two different things forever.
 *   - asin   10 alphanumerics, uppercased. An ALL-DIGIT "ASIN" is an ISBN-10 —
 *            Amazon reuses the field for books — and is re-routed to `isbn`.
 *   - imei   15 digits with a valid Luhn check.
 *   - vin    17 uppercase alphanumerics; I, O and Q are not valid VIN
 *            characters (they are excluded to avoid confusion with 1 and 0).
 *   - mpn/sku/serial/order_id
 *            uppercased, trimmed, internal whitespace collapsed, and
 *            punctuation that vendors add inconsistently (spaces, hyphens) is
 *            removed for `serial` only — hyphens are load-bearing in SKUs and
 *            part numbers.
 *   - rfid/qr/custom
 *            trimmed only. Opaque values; we have no grammar to validate.
 *
 * Returns `null` when the value cannot be normalized into a matchable
 * identifier (empty, wrong length, failed check digit), so callers skip it
 * rather than storing a value that can never be found again. A rejected value
 * is NOT an error — `value_raw` on the row keeps whatever the source said.
 */

/** Namespaces accepted by ci.object_identifiers.namespace. */
export type ObjectIdentifierNamespace =
  | 'gtin'
  | 'isbn'
  | 'asin'
  | 'mpn'
  | 'sku'
  | 'serial'
  | 'imei'
  | 'vin'
  | 'order_id'
  | 'rfid'
  | 'qr'
  | 'custom';

/**
 * Namespaces whose values are globally unique, so a claim needs no qualifier.
 * Everything NOT in this set is unique only within some scope and MUST carry a
 * qualifier — see {@link computeQualifier}.
 */
const GLOBALLY_UNIQUE: ReadonlySet<ObjectIdentifierNamespace> = new Set([
  'gtin',
  'isbn',
  'asin',
  'imei',
  'vin',
]);

/**
 * A normalized identifier, ready to be written to ci.object_identifiers.
 * `namespace` may differ from the requested one — an all-digit ASIN is an ISBN.
 */
export interface NormalizedObjectIdentifier {
  namespace: ObjectIdentifierNamespace;
  valueNormalized: string;
  valueRaw: string;
}

/** GS1 / ISBN-13 mod-10: weights alternate 3 and 1 from the right, check digit excluded. */
function mod10CheckDigit(digitsWithoutCheck: string): number {
  let sum = 0;
  // Rightmost digit of the payload carries weight 3, then alternating.
  for (let i = digitsWithoutCheck.length - 1, weight = 3; i >= 0; i -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(digitsWithoutCheck[i]) * weight;
  }

  return (10 - (sum % 10)) % 10;
}

function hasValidMod10(digits: string): boolean {
  return mod10CheckDigit(digits.slice(0, -1)) === Number(digits[digits.length - 1]);
}

/** Luhn, as used by IMEI. Distinct from mod-10 above: weights are 2/1, and doubled digits fold. */
function hasValidLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;

  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i]);
    if (double) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }

    sum += value;
    double = !double;
  }

  return sum % 10 === 0;
}

/**
 * ISBN-10 -> ISBN-13. The 978 prefix plus the first 9 digits of the ISBN-10
 * (its own check digit is discarded, not carried over) and a freshly computed
 * mod-10 check digit.
 */
function isbn10To13(isbn10: string): string | null {
  const body = isbn10.slice(0, 9);
  if (!/^[0-9]{9}$/.test(body)) {
    return null;
  }

  const payload = `978${body}`;

  return `${payload}${mod10CheckDigit(payload)}`;
}

/** ISBN-10 check digit is mod-11 over weights 10..2, and may be 'X' for 10. */
function hasValidIsbn10Check(isbn10: string): boolean {
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    sum += Number(isbn10[i]) * (10 - i);
  }

  const check = isbn10[9] === 'X' ? 10 : Number(isbn10[9]);

  return (sum + check * 1) % 11 === 0;
}

function normalizeGtin(raw: string): NormalizedObjectIdentifier | null {
  const digits = raw.replace(/\D/g, '');

  // GTIN-8 / GTIN-12 (UPC-A) / GTIN-13 (EAN-13) / GTIN-14 (ITF-14) are the
  // only valid lengths. Anything else is not a barcode we can match on.
  if (![8, 12, 13, 14].includes(digits.length) || !hasValidMod10(digits)) {
    return null;
  }

  // Zero-pad to 14 so the same product scanned as a UPC-A and an EAN-13
  // collapses to one value.
  const gtin14 = digits.padStart(14, '0');

  // A book's barcode IS its ISBN-13, printed under GS1 prefix 978/979
  // ("Bookland"). Left alone, one book would end up with two unmergeable
  // claims — '9780306406157' via the isbn path and '09780306406157' via this
  // one — so a Bookland code is handed to the ISBN path no matter which
  // namespace the caller asked for. `isbn` is the more specific identity and
  // the one an all-digit ASIN also resolves to.
  //
  // The indicator digit must be 0: '19780306406157' is a CASE of that book,
  // which is a genuinely different packaging level and stays a GTIN.
  if (/^0(97[89])/.test(gtin14)) {
    // Dropping the pad zero is safe — a leading zero contributes nothing to the
    // mod-10 sum, so the 13-digit form carries the same, already-validated
    // check digit.
    return { namespace: 'isbn', valueNormalized: gtin14.slice(1), valueRaw: raw };
  }

  return { namespace: 'gtin', valueNormalized: gtin14, valueRaw: raw };
}

function normalizeIsbn(raw: string): NormalizedObjectIdentifier | null {
  const cleaned = raw.replace(/[^0-9Xx]/g, '').toUpperCase();

  if (cleaned.length === 10) {
    if (!hasValidIsbn10Check(cleaned)) {
      return null;
    }

    const isbn13 = isbn10To13(cleaned);

    return isbn13 ? { namespace: 'isbn', valueNormalized: isbn13, valueRaw: raw } : null;
  }

  if (cleaned.length === 13) {
    // An ISBN-13 IS a GTIN-13, so it validates with the same mod-10 rule. 'X'
    // is not legal in an ISBN-13.
    if (cleaned.includes('X') || !hasValidMod10(cleaned)) {
      return null;
    }

    return { namespace: 'isbn', valueNormalized: cleaned, valueRaw: raw };
  }

  return null;
}

function normalizeAsin(raw: string): NormalizedObjectIdentifier | null {
  const cleaned = raw.trim().toUpperCase();

  if (!/^[A-Z0-9]{10}$/.test(cleaned)) {
    return null;
  }

  // Amazon reuses the ASIN field for the book's ISBN-10. Route it to `isbn` so
  // a book bought on Amazon and the same book scanned off its barcode resolve
  // to ONE identifier instead of two that never meet.
  if (/^[0-9]{10}$/.test(cleaned)) {
    return normalizeIsbn(cleaned);
  }

  return { namespace: 'asin', valueNormalized: cleaned, valueRaw: raw };
}

function normalizeImei(raw: string): NormalizedObjectIdentifier | null {
  const digits = raw.replace(/\D/g, '');

  if (digits.length !== 15 || !hasValidLuhn(digits)) {
    return null;
  }

  return { namespace: 'imei', valueNormalized: digits, valueRaw: raw };
}

function normalizeVin(raw: string): NormalizedObjectIdentifier | null {
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

  // I, O and Q are excluded from the VIN alphabet precisely because they are
  // confusable with 1 and 0 — a "VIN" containing one is a misread, not a VIN.
  if (cleaned.length !== 17 || /[IOQ]/.test(cleaned)) {
    return null;
  }

  return { namespace: 'vin', valueNormalized: cleaned, valueRaw: raw };
}

/**
 * Serial numbers are printed with wildly inconsistent spacing and hyphenation
 * ("F2LX-1234 56" vs "F2LX123456"), so those are stripped. SKUs, MPNs and order
 * ids keep their hyphens — a hyphen is part of the value there, and stripping
 * it merges genuinely different parts.
 */
function normalizeLoose(
  raw: string,
  namespace: ObjectIdentifierNamespace,
  stripPunctuation: boolean,
): NormalizedObjectIdentifier | null {
  const collapsed = raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, stripPunctuation ? '' : ' ');
  const cleaned = stripPunctuation ? collapsed.replace(/[^A-Z0-9]/g, '') : collapsed;

  return cleaned.length > 0 ? { namespace, valueNormalized: cleaned, valueRaw: raw } : null;
}

function normalizeOpaque(
  raw: string,
  namespace: ObjectIdentifierNamespace,
): NormalizedObjectIdentifier | null {
  const cleaned = raw.trim();

  return cleaned.length > 0 ? { namespace, valueNormalized: cleaned, valueRaw: raw } : null;
}

/**
 * Normalize one raw identifier value into the form stored in
 * `ci.object_identifiers.value_normalized`.
 *
 * Returns `null` when the value cannot become a matchable identifier. Callers
 * MUST treat that as "skip this identifier", never as an error — a receipt line
 * with an unreadable barcode is still a valid line.
 */
export function normalizeObjectIdentifier(
  namespace: ObjectIdentifierNamespace,
  raw: string | null | undefined,
): NormalizedObjectIdentifier | null {
  if (raw == null) {
    return null;
  }

  const value = String(raw);
  if (value.trim().length === 0) {
    return null;
  }

  switch (namespace) {
    case 'gtin':
      return normalizeGtin(value);
    case 'isbn':
      return normalizeIsbn(value);
    case 'asin':
      return normalizeAsin(value);
    case 'imei':
      return normalizeImei(value);
    case 'vin':
      return normalizeVin(value);
    case 'serial':
      return normalizeLoose(value, 'serial', true);
    case 'sku':
    case 'mpn':
    case 'order_id':
      return normalizeLoose(value, namespace, false);
    case 'rfid':
    case 'qr':
    case 'custom':
      return normalizeOpaque(value, namespace);
    default: {
      // Exhaustiveness guard: a new namespace added to the union without a case
      // here is a compile error, not a silent passthrough.
      const never: never = namespace;

      return never;
    }
  }
}

/**
 * Scan-anything resolution: a user scanning a barcode does not know whether it
 * is a GTIN, an ISBN or something else. Try the structured namespaces in order
 * of how strongly their grammar constrains the value, so a value that could be
 * read two ways lands in the more specific one.
 *
 * GTIN goes first even for books: `normalizeGtin` itself re-routes a Bookland
 * (978/979) code to the ISBN namespace, so both entry points agree on one value
 * for one book. That routing lives there rather than here on purpose — a caller
 * that asks for the 'gtin' namespace explicitly must get the same answer as a
 * scan, or the book ends up with two claims that never meet.
 */
export function detectObjectIdentifier(raw: string | null | undefined): NormalizedObjectIdentifier | null {
  if (raw == null || String(raw).trim().length === 0) {
    return null;
  }

  const value = String(raw);

  return (
    normalizeGtin(value) ??
    normalizeIsbn(value) ??
    normalizeImei(value) ??
    normalizeVin(value) ??
    normalizeAsin(value)
  );
}

/**
 * The scope a non-globally-unique identifier is claimed within, stored in
 * `ci.object_identifiers.qualifier` and part of the claim uniqueness key.
 *
 * Serial numbers are unique only within a manufacturer: a Dell service tag
 * '0001' and an Anker serial '0001' are different objects, and without a
 * qualifier the first writer would silently swallow the second.
 *
 * STABILITY IS THE WHOLE POINT. If a serial is first claimed under a brand
 * qualifier and later under a product-id one, the two claims do not collide and
 * the object splits into two identities. So the precedence below is fixed and
 * brand-first — brand is the value most consistently available across receipts,
 * product feeds and user entry, whereas product_id only exists after the
 * catalog resolves.
 *
 * Returns '' for globally-unique namespaces, matching the column default.
 */
export function computeQualifier(
  namespace: ObjectIdentifierNamespace,
  scope: { brand?: string | null; sourceSystem?: string | null },
): string {
  if (GLOBALLY_UNIQUE.has(namespace)) {
    return '';
  }

  const brand = scope.brand?.trim().toLowerCase();
  if (brand) {
    return brand;
  }

  // No brand: fall back to the system that asserted the value. Two retailers'
  // SKU spaces are unrelated, so this at least prevents a cross-retailer
  // collision. Weaker than brand, and deliberately last.
  const system = scope.sourceSystem?.trim().toLowerCase();

  return system ?? '';
}

/** True when `namespace` needs no qualifier because its values are globally unique. */
export function isGloballyUniqueNamespace(namespace: ObjectIdentifierNamespace): boolean {
  return GLOBALLY_UNIQUE.has(namespace);
}
