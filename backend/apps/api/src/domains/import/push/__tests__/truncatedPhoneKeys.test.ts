import { normalizeHandle } from '../../staging/identity';
import {
  identityKeyFromTypedHandles,
  legacyNormalizeHandle,
  rowNameAgrees,
  truncatedPhoneKeyFor,
  typedHandlesOf,
} from '../truncatedPhoneKeys';

/*
 * Every number here is invented: the 555-01XX fiction range under the 212 and
 * 202 area codes. `(212) 555-0147;229` is an office line with extension 229;
 * the old rule kept the last ten digits of `2125550147229`, i.e. `5550147229`.
 */
const OFFICE_EXT = '(212) 555-0147;229';
const TRUNCATION = '5550147229';

/** A staged card, as the push reads it back: the fixed parser's key, and its typed handles. */
function card(
  metadata: Record<string, unknown>,
  identityKey: string | null,
  name: string | null = 'Dana Quill',
): { type: string; name: string | null; identityKey: string | null; metadata: Record<string, unknown> } {
  return { type: 'contact', name, identityKey, metadata };
}

describe('legacyNormalizeHandle — the pre-fix rule, for recognition only', () => {
  it.each([
    [OFFICE_EXT, TRUNCATION],
    ['(212) 555-0147 x229', TRUNCATION],
    ['212.555.0147 ext. 229', TRUNCATION],
    ['+1 (212) 555-0147,229', TRUNCATION],
    ['(212) 555-0147', '2125550147'],
    ['+1 (212) 555-0199', '2125550199'],
    ['Dana.Quill@Example.com', 'dana.quill@example.com'],
    ['555-01', ''],
    ['   ', ''],
  ])('keys %s as %s', (value, expected) => {
    expect(legacyNormalizeHandle(value)).toBe(expected);
  });

  it('agrees with the current rule on every value that carries no extension', () => {
    for (const value of ['(212) 555-0147', '+1 (212) 555-0199', '2025550142', 'dana@example.com', '555-01']) {
      expect(legacyNormalizeHandle(value)).toBe(normalizeHandle(value));
    }
  });
});

describe('typedHandlesOf', () => {
  it('reads Phones then Emails, arrays or lone strings, strings only', () => {
    expect(
      typedHandlesOf({
        Phones: [OFFICE_EXT, '', 7, { value: '(202) 555-0142' }],
        Emails: 'dana@example.com',
        phones: ['2025550199'],
      }),
    ).toEqual([OFFICE_EXT, 'dana@example.com']);
  });

  it('is empty for a bag with neither key', () => {
    expect(typedHandlesOf(null)).toEqual([]);
    expect(typedHandlesOf({ Source: 'AppleContacts' })).toEqual([]);
  });
});

describe('identityKeyFromTypedHandles', () => {
  it('is the smallest handle the CURRENT rule keys, refusing the extension', () => {
    expect(identityKeyFromTypedHandles([OFFICE_EXT, 'dana@example.com'])).toBe('dana@example.com');
    expect(identityKeyFromTypedHandles([OFFICE_EXT, '(202) 555-0142'])).toBe('2025550142');
    expect(identityKeyFromTypedHandles([OFFICE_EXT])).toBeNull();
  });
});

describe('truncatedPhoneKeyFor', () => {
  it('rebuilds the truncated key of a card whose extension line was its smallest handle', () => {
    const proof = truncatedPhoneKeyFor(
      card({ Phones: [OFFICE_EXT], Emails: ['dana@example.com'] }, 'dana@example.com'),
    );

    expect(proof).toMatchObject({
      legacyKey: `contact:${TRUNCATION}`,
      currentKey: 'contact:dana@example.com',
      truncatedHandle: TRUNCATION,
      handle: 'dana@example.com',
      typed: [OFFICE_EXT],
    });
    expect(proof?.evidence).toHaveLength(3);
  });

  it('moves a card with no other handle onto its NAME key, as the fixed parser keys it', () => {
    expect(truncatedPhoneKeyFor(card({ Phones: [OFFICE_EXT] }, null, 'Dana Quill'))).toMatchObject({
      legacyKey: `contact:${TRUNCATION}`,
      currentKey: 'contact:dana quill',
      handle: null,
    });
  });

  it('is null for a nameless card with nothing left to key on — the fixed parser skips it', () => {
    expect(truncatedPhoneKeyFor(card({ Phones: [OFFICE_EXT] }, null, null))).toBeNull();
  });

  it('is null when a smaller handle was the key all along', () => {
    // 2025550142 < 5550147229, under both rules: the truncation never won.
    expect(truncatedPhoneKeyFor(card({ Phones: [OFFICE_EXT, '(202) 555-0142'] }, '2025550142'))).toBeNull();
  });

  it('is null when the card also lists those ten digits as a plain number', () => {
    // The migration's "second half" of the proof: the fixed rule keys the
    // same coordinate, so nothing moved.
    expect(truncatedPhoneKeyFor(card({ Phones: [OFFICE_EXT, '(555) 014-7229'] }, TRUNCATION))).toBeNull();
  });

  it('is null when the typed handles do not reproduce the staged key', () => {
    // A handle the metadata does not carry decided the key — so the old key
    // rebuilt from the metadata would be a guess.
    expect(truncatedPhoneKeyFor(card({ Phones: [OFFICE_EXT] }, '2025550199'))).toBeNull();
    expect(truncatedPhoneKeyFor(card({ Phones: [OFFICE_EXT] }, 'dana@example.com'))).toBeNull();
  });

  it('is null for a card with no extension, and for a staged row with no typed handles', () => {
    expect(truncatedPhoneKeyFor(card({ Phones: ['(212) 555-0147'] }, '2125550147'))).toBeNull();
    expect(truncatedPhoneKeyFor(card({}, TRUNCATION))).toBeNull();
  });

  it('never reads an email as an extension', () => {
    // `x229@…` matches the extension pattern's `x<digit>` at the start.
    expect(truncatedPhoneKeyFor(card({ Emails: ['x229@example.com'] }, 'x229@example.com'))).toBeNull();
  });

  it('names every typed value that truncates to the old key', () => {
    const proof = truncatedPhoneKeyFor(
      card({ Phones: [OFFICE_EXT, '212-555-0147 x229'], Emails: ['dana@example.com'] }, 'dana@example.com'),
    );

    expect(proof?.typed).toEqual([OFFICE_EXT, '212-555-0147 x229']);
  });

  it.each(['(212) 555-0147x229', '(212) 555-0147 x 229', '212-555-0147p229', '(212) 555-0147,,229'])(
    'reads %s as one line and its extension',
    (typed) => {
      expect(
        truncatedPhoneKeyFor(card({ Phones: [typed], Emails: ['dana@example.com'] }, 'dana@example.com')),
      ).toMatchObject({ truncatedHandle: TRUNCATION, typed: [typed] });
    },
  );

  it.each([
    // Google's CSV joins a label's numbers into one cell. The old rule's last ten
    // digits here are the card's OWN second number: moving the row would be
    // fine, but dropping that identifier and its links would unlink real calls.
    ['a joined cell, extension first', '(212) 555-0147;229 ::: +1 212-555-0199'],
    // The other order is a truncation, but not ONE line's: refused as well.
    ['a joined cell, extension last', '+1 212-555-0199 ::: (212) 555-0147;229'],
    ['a dial string whose tail is longer than an extension', '(212) 555-0147,,1234567'],
  ])('is null for %s', (_label, typed) => {
    expect(
      truncatedPhoneKeyFor(card({ Phones: [typed], Emails: ['dana@example.com'] }, 'dana@example.com')),
    ).toBeNull();
  });

  it('takes the smallest of two truncations, as the old parser did', () => {
    // 5550147229 < 5550148311.
    const proof = truncatedPhoneKeyFor(
      card({ Phones: ['(212) 555-0148;311', OFFICE_EXT], Emails: ['dana@example.com'] }, 'dana@example.com'),
    );

    expect(proof).toMatchObject({ truncatedHandle: TRUNCATION, typed: [OFFICE_EXT] });
  });
});

describe('rowNameAgrees', () => {
  it('matches the row name or any recorded name, ignoring case and spacing', () => {
    expect(rowNameAgrees({ name: 'Dana Quill' }, { name: 'dana  quill', names: [] }, TRUNCATION)).toBe(true);
    expect(
      rowNameAgrees({ name: 'Dana Quill' }, { name: 'D. Quill', names: ['DANA QUILL'] }, TRUNCATION),
    ).toBe(true);
  });

  it('refuses a row that reads as somebody else', () => {
    expect(
      rowNameAgrees({ name: 'Dana Quill' }, { name: 'Ezra Vale', names: ['Ezra Vale'] }, TRUNCATION),
    ).toBe(false);
  });

  it('matches a nameless card only to a row named after its handle, with no names recorded', () => {
    expect(rowNameAgrees({ name: null }, { name: TRUNCATION, names: undefined }, TRUNCATION)).toBe(true);
    expect(rowNameAgrees({ name: null }, { name: null, names: null }, TRUNCATION)).toBe(true);
    expect(rowNameAgrees({ name: null }, { name: 'Ezra Vale', names: undefined }, TRUNCATION)).toBe(false);
    expect(rowNameAgrees({ name: null }, { name: TRUNCATION, names: ['Ezra Vale'] }, TRUNCATION)).toBe(false);
  });
});
