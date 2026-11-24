import { legacyEntityIdentityKey, entityIdentityKey } from '../../staging/identity';
import { truncatedPhoneKeyFor, typedHandlesOf } from '../truncatedPhoneKeys';

/*
 * Every number here is invented: the 555-01XX fiction range under the 212 and
 * 202 area codes. `(212) 555-0147;229` is an office line with extension 229;
 * the old rule kept the last ten digits of `2125550147229`, i.e. `5550147229`.
 */
const OFFICE_EXT = '(212) 555-0147;229';
const TRUNCATION = '5550147229';

/**
 * A staged card as the push reads it back: its typed handles, the key the
 * current rule gives it, and the legacy key staging recorded — both computed
 * here the way `StagedWriter` computes them, from the card's attributes.
 */
function staged(phones: string[], emails: string[] = []) {
  const entity = {
    name: 'Dana Quill',
    attributes: [
      ...phones.map((value) => ({ name: 'phone', value, identity: true })),
      ...emails.map((value) => ({ name: 'email', value, identity: true })),
    ],
  };
  const identityKey = entityIdentityKey(entity);
  const legacy = legacyEntityIdentityKey(entity);

  return {
    identityKey,
    legacyIdentityKey: legacy !== identityKey ? legacy : null,
    metadata: { ...(phones.length ? { Phones: phones } : {}), ...(emails.length ? { Emails: emails } : {}) },
  };
}

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

describe('truncatedPhoneKeyFor', () => {
  it('proves a card that was minted under the truncation of its own extension line', () => {
    const proof = truncatedPhoneKeyFor(staged([OFFICE_EXT], ['dana@example.com']));

    expect(proof).toMatchObject({
      truncatedHandle: TRUNCATION,
      handle: 'dana@example.com',
      typed: [OFFICE_EXT],
    });
    expect(proof?.evidence).toHaveLength(3);
  });

  it('proves a card that keys on its name now, having no other handle', () => {
    expect(truncatedPhoneKeyFor(staged([OFFICE_EXT]))).toMatchObject({
      truncatedHandle: TRUNCATION,
      handle: null,
    });
  });

  it.each(['(212) 555-0147x229', '(212) 555-0147 x 229', '212-555-0147p229', '(212) 555-0147,,229'])(
    'reads %s as one line and its extension',
    (typed) => {
      expect(truncatedPhoneKeyFor(staged([typed], ['dana@example.com']))).toMatchObject({
        truncatedHandle: TRUNCATION,
        typed: [typed],
      });
    },
  );

  it('names every typed value that truncates to the old key', () => {
    const proof = truncatedPhoneKeyFor(staged([OFFICE_EXT, '212-555-0147 x229'], ['dana@example.com']));

    expect(proof?.typed).toEqual([OFFICE_EXT, '212-555-0147 x229']);
  });

  it('is null when a smaller handle was the key all along — nothing was fabricated', () => {
    // 2025550142 < 5550147229 under both rules: the truncation was never the key.
    expect(truncatedPhoneKeyFor(staged([OFFICE_EXT, '(202) 555-0142']))).toBeNull();
  });

  it('is null when the card also lists those ten digits as a plain number', () => {
    // The migration's "second half": the digits are really the card's. Staged
    // by hand, because the current rule keys it the same and staging would
    // record no legacy key at all.
    expect(
      truncatedPhoneKeyFor({
        identityKey: 'dana@example.com',
        legacyIdentityKey: TRUNCATION,
        metadata: { Phones: [OFFICE_EXT, '(555) 014-7229'], Emails: ['dana@example.com'] },
      }),
    ).toBeNull();
  });

  it('is null for a legacy key that is some other handle — a shared line, not a truncation', () => {
    expect(
      truncatedPhoneKeyFor({
        identityKey: 'dana@example.com',
        legacyIdentityKey: '2125550100',
        metadata: { Phones: [OFFICE_EXT, '(212) 555-0100'], Emails: ['dana@example.com'] },
      }),
    ).toBeNull();
  });

  it('is null for a row staged before the legacy key existed, and for one whose key did not move', () => {
    expect(
      truncatedPhoneKeyFor({ identityKey: 'dana@example.com', legacyIdentityKey: null, metadata: {} }),
    ).toBeNull();
    expect(
      truncatedPhoneKeyFor({
        identityKey: TRUNCATION,
        legacyIdentityKey: TRUNCATION,
        metadata: { Phones: [OFFICE_EXT] },
      }),
    ).toBeNull();
  });

  it('is null when the metadata does not carry the typed line — a parser that kept only attributes', () => {
    expect(
      truncatedPhoneKeyFor({ identityKey: 'dana@example.com', legacyIdentityKey: TRUNCATION, metadata: {} }),
    ).toBeNull();
  });

  it.each([
    // Google's CSV joins a label's numbers into one cell. The old rule's last ten
    // digits here are the card's OWN second number: dropping that identifier and
    // its links would unlink real calls.
    ['a joined cell, extension first', '(212) 555-0147;229 ::: +1 212-555-0199', '2125550199'],
    // The other order is a truncation, but not ONE line's: refused as well.
    ['a joined cell, extension last', '+1 212-555-0199 ::: (212) 555-0147;229', TRUNCATION],
    ['a dial string whose tail is longer than an extension', '(212) 555-0147,,1234567', '1471234567'],
  ])('is null for %s', (_label, typed, legacy) => {
    expect(
      truncatedPhoneKeyFor({
        identityKey: 'dana@example.com',
        legacyIdentityKey: legacy,
        metadata: { Phones: [typed], Emails: ['dana@example.com'] },
      }),
    ).toBeNull();
  });

  it('never reads an email as an extension', () => {
    // `x229@…` matches the extension pattern's `x<digit>` at the start.
    expect(
      truncatedPhoneKeyFor({
        identityKey: 'dana@example.com',
        legacyIdentityKey: 'x229@example.com',
        metadata: { Emails: ['x229@example.com', 'dana@example.com'] },
      }),
    ).toBeNull();
  });
});
