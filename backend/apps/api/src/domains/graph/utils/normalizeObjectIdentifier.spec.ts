import {
  computeQualifier,
  detectObjectIdentifier,
  isGloballyUniqueNamespace,
  normalizeObjectIdentifier,
  type ObjectIdentifierNamespace,
} from './normalizeObjectIdentifier';

/**
 * THE SHARED VECTOR TABLE.
 *
 * This exact table is duplicated into CI-Import-Tools
 * (`backend/src/ci-server/__tests__/objectIdentifiers.test.ts`). The two
 * normalizers must agree byte-for-byte or the ci.object_identifiers lookup
 * silently misses — a receipt-side GTIN that normalizes differently from the
 * scan-side one produces two claims that never meet.
 *
 * When you add a case here, add it there in the same commit.
 */
const VECTORS: ReadonlyArray<{
  name: string;
  namespace: ObjectIdentifierNamespace;
  raw: string;
  expected: { namespace: ObjectIdentifierNamespace; value: string } | null;
}> = [
  // --- GTIN: every printed form of one barcode collapses to one GTIN-14 ---
  {
    name: 'UPC-A padded to GTIN-14',
    namespace: 'gtin',
    raw: '012345678905',
    expected: { namespace: 'gtin', value: '00012345678905' },
  },
  {
    name: 'UPC-A with spaces',
    namespace: 'gtin',
    raw: ' 0 12345 67890 5 ',
    expected: { namespace: 'gtin', value: '00012345678905' },
  },
  {
    name: 'EAN-13 padded',
    namespace: 'gtin',
    raw: '4006381333931',
    expected: { namespace: 'gtin', value: '04006381333931' },
  },
  {
    name: 'GTIN-8',
    namespace: 'gtin',
    raw: '96385074',
    expected: { namespace: 'gtin', value: '00000096385074' },
  },
  {
    name: 'GTIN-14 unchanged',
    namespace: 'gtin',
    raw: '00012345678905',
    expected: { namespace: 'gtin', value: '00012345678905' },
  },
  { name: 'GTIN bad check digit rejected', namespace: 'gtin', raw: '012345678904', expected: null },
  { name: 'GTIN wrong length rejected', namespace: 'gtin', raw: '12345', expected: null },

  // --- ISBN: ISBN-10 upconverts; the check digit is recomputed, not carried ---
  {
    name: 'ISBN-10 to ISBN-13',
    namespace: 'isbn',
    raw: '0306406152',
    expected: { namespace: 'isbn', value: '9780306406157' },
  },
  {
    name: 'ISBN-10 hyphenated',
    namespace: 'isbn',
    raw: '0-306-40615-2',
    expected: { namespace: 'isbn', value: '9780306406157' },
  },
  {
    name: 'ISBN-10 with X check digit',
    namespace: 'isbn',
    raw: '043942089X',
    expected: { namespace: 'isbn', value: '9780439420891' },
  },
  {
    name: 'ISBN-13 passthrough',
    namespace: 'isbn',
    raw: '9780306406157',
    expected: { namespace: 'isbn', value: '9780306406157' },
  },
  { name: 'ISBN-10 bad check rejected', namespace: 'isbn', raw: '0306406153', expected: null },
  { name: 'ISBN-13 bad check rejected', namespace: 'isbn', raw: '9780306406158', expected: null },

  // --- Bookland: a book's barcode IS its ISBN-13, so the gtin namespace must
  //     not mint a second, unmergeable identity for it. ---
  {
    name: 'Bookland code asked for as gtin reroutes to isbn',
    namespace: 'gtin',
    raw: '9780306406157',
    expected: { namespace: 'isbn', value: '9780306406157' },
  },
  {
    name: 'zero-padded Bookland GTIN-14 reroutes to isbn',
    namespace: 'gtin',
    raw: '09780306406157',
    expected: { namespace: 'isbn', value: '9780306406157' },
  },
  {
    name: 'case-pack of a book (indicator digit 1) stays a gtin',
    namespace: 'gtin',
    raw: '19780306406154',
    expected: { namespace: 'gtin', value: '19780306406154' },
  },

  // --- ASIN: the all-digit case is the trap. Amazon reuses it for ISBN-10. ---
  {
    name: 'ASIN alphanumeric',
    namespace: 'asin',
    raw: 'b08n5wrwnw',
    expected: { namespace: 'asin', value: 'B08N5WRWNW' },
  },
  {
    name: 'all-digit ASIN reroutes to isbn',
    namespace: 'asin',
    raw: '0306406152',
    expected: { namespace: 'isbn', value: '9780306406157' },
  },
  { name: 'ASIN wrong length rejected', namespace: 'asin', raw: 'B08N5WRW', expected: null },

  // --- IMEI: Luhn ---
  {
    name: 'valid IMEI',
    namespace: 'imei',
    raw: '490154203237518',
    expected: { namespace: 'imei', value: '490154203237518' },
  },
  {
    name: 'IMEI with separators',
    namespace: 'imei',
    raw: '49-015420-323751-8',
    expected: { namespace: 'imei', value: '490154203237518' },
  },
  { name: 'IMEI bad Luhn rejected', namespace: 'imei', raw: '490154203237519', expected: null },

  // --- VIN: I/O/Q are misreads of 1/0, never valid ---
  {
    name: 'valid VIN uppercased',
    namespace: 'vin',
    raw: '1hgbh41jxmn109186',
    expected: { namespace: 'vin', value: '1HGBH41JXMN109186' },
  },
  { name: 'VIN containing O rejected', namespace: 'vin', raw: '1HGBH41JXMN1O9186', expected: null },
  { name: 'VIN wrong length rejected', namespace: 'vin', raw: '1HGBH41JXMN10918', expected: null },

  // --- serial strips punctuation; sku/mpn keep hyphens (load-bearing there) ---
  {
    name: 'serial strips spaces and hyphens',
    namespace: 'serial',
    raw: ' f2lx-1234 56 ',
    expected: { namespace: 'serial', value: 'F2LX123456' },
  },
  {
    name: 'sku keeps hyphens',
    namespace: 'sku',
    raw: ' ab-1234-xl ',
    expected: { namespace: 'sku', value: 'AB-1234-XL' },
  },
  {
    name: 'mpn keeps hyphens',
    namespace: 'mpn',
    raw: 'mz-v8p1t0b/am',
    expected: { namespace: 'mpn', value: 'MZ-V8P1T0B/AM' },
  },
  {
    name: 'order_id uppercased',
    namespace: 'order_id',
    raw: ' 114-3941689-1234567 ',
    expected: { namespace: 'order_id', value: '114-3941689-1234567' },
  },

  // --- opaque namespaces: trim only, case preserved ---
  {
    name: 'qr preserves case',
    namespace: 'qr',
    raw: '  https://Example.com/x  ',
    expected: { namespace: 'qr', value: 'https://Example.com/x' },
  },

  // --- empties are skips, not errors ---
  { name: 'empty string', namespace: 'gtin', raw: '', expected: null },
  { name: 'whitespace only', namespace: 'serial', raw: '   ', expected: null },
];

describe('normalizeObjectIdentifier', () => {
  it.each(VECTORS)('$name', ({ namespace, raw, expected }) => {
    const result = normalizeObjectIdentifier(namespace, raw);

    if (expected === null) {
      expect(result).toBeNull();

      return;
    }

    expect(result).not.toBeNull();
    expect(result?.namespace).toBe(expected.namespace);
    expect(result?.valueNormalized).toBe(expected.value);
    // value_raw always preserves exactly what the source said, so a normalizer
    // fix can re-derive from it later.
    expect(result?.valueRaw).toBe(raw);
  });

  it('returns null for null and undefined', () => {
    expect(normalizeObjectIdentifier('gtin', null)).toBeNull();
    expect(normalizeObjectIdentifier('gtin', undefined)).toBeNull();
  });

  it('is idempotent — normalizing a normalized value is a no-op', () => {
    for (const { namespace, raw, expected } of VECTORS) {
      if (expected === null) {
        continue;
      }

      const once = normalizeObjectIdentifier(namespace, raw);
      const twice = normalizeObjectIdentifier(once!.namespace, once!.valueNormalized);

      expect(twice?.valueNormalized).toBe(once?.valueNormalized);
    }
  });

  it('collapses UPC-A and EAN-13 spellings of the same product to one value', () => {
    // The whole point of padding to 14: a product scanned in the US and in the
    // EU must produce ONE claim, not two.
    const upc = normalizeObjectIdentifier('gtin', '012345678905');
    const ean = normalizeObjectIdentifier('gtin', '0012345678905');

    expect(upc?.valueNormalized).toBe(ean?.valueNormalized);
  });

  it('gives one book ONE identity across every entry point', () => {
    // The regression this guards: normalizeGtin used to pad a Bookland code to
    // 14 digits while the isbn path stored 13, so a book scanned off its
    // barcode and the same book from an Amazon order produced two claims that
    // could never meet. All four of these must agree.
    const viaGtin = normalizeObjectIdentifier('gtin', '9780306406157');
    const viaIsbn13 = normalizeObjectIdentifier('isbn', '9780306406157');
    const viaIsbn10 = normalizeObjectIdentifier('isbn', '0306406152');
    const viaAsin = normalizeObjectIdentifier('asin', '0306406152');
    const viaScan = detectObjectIdentifier('9780306406157');

    for (const result of [viaGtin, viaIsbn13, viaIsbn10, viaAsin, viaScan]) {
      expect(result?.namespace).toBe('isbn');
      expect(result?.valueNormalized).toBe('9780306406157');
    }
  });

  it('keeps a case-pack of a book distinct from the book itself', () => {
    // Indicator digit 0 means "the item"; anything else is a different
    // packaging level and must NOT collapse into the book's ISBN.
    const book = normalizeObjectIdentifier('gtin', '09780306406157');
    const casePack = normalizeObjectIdentifier('gtin', '19780306406154');

    expect(book?.namespace).toBe('isbn');
    expect(casePack?.namespace).toBe('gtin');
    expect(book?.valueNormalized).not.toBe(casePack?.valueNormalized);
  });
});

describe('detectObjectIdentifier', () => {
  it('prefers ISBN for Bookland-prefixed 13-digit codes', () => {
    // 978/979 codes are books; without this an ISBN would land in `gtin` and a
    // book bought on Amazon (ASIN -> isbn) would never meet its own barcode.
    expect(detectObjectIdentifier('9780306406157')).toEqual(
      expect.objectContaining({ namespace: 'isbn', valueNormalized: '9780306406157' }),
    );
  });

  it('treats a non-Bookland EAN-13 as a GTIN', () => {
    expect(detectObjectIdentifier('4006381333931')).toEqual(
      expect.objectContaining({ namespace: 'gtin', valueNormalized: '04006381333931' }),
    );
  });

  it('detects a VIN', () => {
    expect(detectObjectIdentifier('1HGBH41JXMN109186')).toEqual(
      expect.objectContaining({ namespace: 'vin' }),
    );
  });

  it('detects an IMEI', () => {
    expect(detectObjectIdentifier('490154203237518')).toEqual(expect.objectContaining({ namespace: 'imei' }));
  });

  it('returns null for unstructured input', () => {
    expect(detectObjectIdentifier('just some text')).toBeNull();
    expect(detectObjectIdentifier('')).toBeNull();
    expect(detectObjectIdentifier(null)).toBeNull();
  });
});

describe('computeQualifier', () => {
  it('is empty for globally unique namespaces regardless of scope', () => {
    for (const ns of ['gtin', 'isbn', 'asin', 'imei', 'vin'] as ObjectIdentifierNamespace[]) {
      expect(isGloballyUniqueNamespace(ns)).toBe(true);
      expect(computeQualifier(ns, { brand: 'Dell', sourceSystem: 'amazon' })).toBe('');
    }
  });

  it('scopes a serial by brand, so the same serial from two brands does not collide', () => {
    // This is the invariant that keeps a Dell service tag '0001' and an Anker
    // serial '0001' as two objects rather than one.
    const dell = computeQualifier('serial', { brand: 'Dell' });
    const anker = computeQualifier('serial', { brand: ' anker ' });

    expect(dell).toBe('dell');
    expect(anker).toBe('anker');
    expect(dell).not.toBe(anker);
  });

  it('falls back to sourceSystem when brand is unknown', () => {
    expect(computeQualifier('sku', { brand: null, sourceSystem: 'Amazon' })).toBe('amazon');
  });

  it('prefers brand over sourceSystem, so a qualifier stays stable as sources change', () => {
    // Stability matters more than precision here: a serial first claimed under
    // one qualifier and later under another does not collide, and the object
    // silently splits into two identities.
    expect(computeQualifier('serial', { brand: 'Dell', sourceSystem: 'amazon' })).toBe('dell');
  });

  it('returns empty when nothing is known', () => {
    expect(computeQualifier('serial', {})).toBe('');
  });
});
