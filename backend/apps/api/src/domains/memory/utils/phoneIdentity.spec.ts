import {
  NANP_TIMEZONES,
  PHONE_EVIDENCE,
  PHONE_FACTS_CORPUS_SQL,
  PHONE_IDENTITY_SCORES,
  PHONE_LINE_MAX_IDENTITIES,
  PHONE_MAX_HOLDERS,
  PhoneHolders,
  applyPhoneVerdict,
  capUnadjudicatedPhones,
  classifyPhoneName,
  derivePhoneRegion,
  extractPhoneFacts,
  generationalSuffix,
  givenNameRelation,
  isPlaceholderPersonName,
  nanpNumberClass,
  parsePhone,
  phoneCorpusFacts,
  phoneEvidenceFor,
  phoneFactsSqlObject,
  sharedPhoneLines,
  type PhoneFacts,
  type PhoneRegion,
  type PhoneVerdict,
} from './phoneIdentity';
import { PROFILE_URL_MAX_HOLDERS } from './profileUrls';

/*
 * Every number and name here is invented. Numbers are the 555-01XX fiction
 * range under real area codes (202, 212), the toll-free/premium/service
 * ranges the rule refuses, and the UK drama range (+44 20 7946 0XXX).
 */

const ADA_E164 = '+12025550142';
const ADA_DIGITS = '2025550142';
const UK_E164 = '+442079460958';
const UK_DIGITS = '2079460958';

type Props = Record<string, unknown>;

function facts(
  name: string | null,
  props: Props = {},
  options: { self?: boolean; region?: PhoneRegion | null } = {},
) {
  return extractPhoneFacts(
    props,
    name,
    options.self ?? false,
    options.region === undefined ? 'NANP' : options.region,
  );
}

/** A Google Voice participant stub: named by its number, `phones` holds the ten-digit key. */
function stub(number = '+1 (202) 555-0142', digits = ADA_DIGITS): PhoneFacts {
  return facts(number, { phones: [digits], phone: digits });
}

/** A contacts vCard: `Phones` as typed, `phones` pre-normalized. */
function vcard(name: string, ...typed: string[]): PhoneFacts {
  return facts(name, { Phones: typed, phones: typed.map((value) => value.replace(/\D/g, '').slice(-10)) });
}

function holdersOf(...entries: Array<[string, PhoneFacts]>): PhoneHolders {
  return new PhoneHolders(entries);
}

function adjudicate(left: PhoneFacts, right: PhoneFacts, ...others: PhoneFacts[]): PhoneVerdict {
  const holders = holdersOf(
    ['left', left],
    ['right', right],
    ...others.map((other, index) => [`other-${index}`, other] as [string, PhoneFacts]),
  );

  return holders.adjudicate(left, right);
}

describe('parsePhone', () => {
  it.each([
    ['+1 (202) 555-0142', ADA_E164],
    ['+12025550142', ADA_E164],
    ['1-202-555-0142', ADA_E164],
    ['0012025550142', ADA_E164],
    ['+44 20 7946 0958', UK_E164],
    ['0044 20 7946 0958', UK_E164],
  ])('reads %s as a STATED number', (raw, e164) => {
    expect(parsePhone(raw, null)).toMatchObject({ status: 'ok', e164, stated: true });
    expect(parsePhone(raw, 'NANP')).toMatchObject({ status: 'ok', e164, stated: true });
  });

  it('reads 011 as the international prefix only under NANP', () => {
    expect(parsePhone('011 44 20 7946 0958', 'NANP')).toMatchObject({
      status: 'ok',
      e164: UK_E164,
      stated: true,
    });
    expect(parsePhone('011 44 20 7946 0958', null).status).toBe('no_region');
  });

  it.each(['(202) 555-0142', '202.555.0142', '202/555-0142', '2025550142'])(
    'infers %s as a North American number only when the owner is in NANP',
    (raw) => {
      expect(parsePhone(raw, 'NANP')).toMatchObject({ status: 'ok', e164: ADA_E164, stated: false });
      expect(parsePhone(raw, null)).toMatchObject({ status: 'no_region', e164: null });
    },
  );

  it('strips bidi marks and folds typographic dashes', () => {
    expect(parsePhone('‪+1 (202) 555‑0142‬', 'NANP')).toMatchObject({ status: 'ok', e164: ADA_E164 });
  });

  it('never reads a trunk-prefixed foreign national number as a US one', () => {
    // UK "020 7946 0958" is eleven digits led by 0; truncating it would make
    // it (207) 946-0958, a Maine number.
    expect(parsePhone('020 7946 0958', 'NANP')).toMatchObject({
      status: 'invalid',
      e164: null,
      l10: UK_DIGITS,
    });
  });

  it.each([
    ['toll-free', '(888) 555-0100', 'service'],
    ['toll-free, stated', '+1 800 555 0100', 'service'],
    ['reserved toll-free', '(822) 555-0100', 'service'],
    ['premium NPA', '900-555-0100', 'service'],
    ['premium exchange', '(202) 976-0100', 'service'],
    ['personal communications', '(500) 555-0100', 'service'],
    ['personal communications 52X', '(527) 555-0100', 'service'],
    ['an N11 exchange', '(202) 411-0100', 'service'],
    ['an N11 area code', '(411) 555-0100', 'invalid'],
    ['an N9X area code', '(290) 555-0100', 'invalid'],
    ['a 37X area code', '(372) 555-0100', 'invalid'],
    ['a 96X area code', '(962) 555-0100', 'invalid'],
    ['an area code starting 1', '(123) 555-0100', 'invalid'],
    ['the fictional 555 area code', '(555) 555-0142', 'invalid'],
    ['ten identical digits', '5555555555', 'invalid'],
    ['seven digits, no area code', '555-0142', 'invalid'],
    ['a stated NANP number of the wrong length', '+1 202 555 014', 'invalid'],
    ['an extension', '(202) 555-0142 x12', 'extension'],
    ['an extension word', '202.555.0142 ext. 7', 'extension'],
    ['a dial-string suffix', '(202) 555-0142;12', 'extension'],
    ['a short code', '52886', 'short'],
    ['letters', '202-FLOWERS', 'letters'],
  ])('refuses %s', (_label, raw, status) => {
    const parsed = parsePhone(raw, 'NANP');

    expect(parsed.status).toBe(status);
    expect(parsed.e164).toBeNull();
  });

  it('keeps 520 — Tucson — out of the personal-communications range', () => {
    expect(parsePhone('(520) 555-0142', 'NANP')).toMatchObject({ status: 'ok', e164: '+15205550142' });
  });

  it('keeps the last ten digits on every status, as the join key does', () => {
    expect(parsePhone('(888) 555-0100', 'NANP').l10).toBe('8885550100');
    expect(parsePhone('+44 20 7946 0958', null).l10).toBe(UK_DIGITS);
    expect(parsePhone('52886', 'NANP').l10).toBe('52886');
  });
});

describe('nanpNumberClass', () => {
  it.each([
    ['2025550142', 'geographic'],
    ['2125550199', 'geographic'],
    ['8885550100', 'toll_free'],
    ['8805550100', 'toll_free'],
    ['9005550100', 'premium'],
    ['2029760100', 'premium'],
    ['4565550100', 'non_geographic'],
    ['7105550100', 'non_geographic'],
    ['2029500100', 'service'],
    ['2029110100', 'service'],
    ['0125550100', 'invalid'],
    ['2020550100', 'invalid'],
  ])('%s is %s', (ten, expected) => {
    expect(nanpNumberClass(ten)).toBe(expected);
  });
});

describe('derivePhoneRegion', () => {
  const none: string[] = [];

  it("takes the owner's own stated numbers first", () => {
    expect(derivePhoneRegion({ selfStatedNumbers: [ADA_E164], timezone: 'UTC', statedNumbers: none })).toBe(
      'NANP',
    );
  });

  it('refuses to infer for an owner whose own numbers are all elsewhere, whatever the time zone', () => {
    expect(
      derivePhoneRegion({
        selfStatedNumbers: [UK_E164],
        timezone: 'America/Los_Angeles',
        statedNumbers: none,
      }),
    ).toBeNull();
  });

  it('falls back to an explicit list of North American time zones', () => {
    expect(
      derivePhoneRegion({ selfStatedNumbers: [], timezone: 'America/Los_Angeles', statedNumbers: none }),
    ).toBe('NANP');
    expect(
      derivePhoneRegion({ selfStatedNumbers: [], timezone: 'America/Toronto', statedNumbers: none }),
    ).toBe('NANP');
  });

  it.each(['America/Mexico_City', 'America/Sao_Paulo', 'Europe/London', 'UTC', null])(
    'derives no region from %s',
    (timezone) => {
      expect(derivePhoneRegion({ selfStatedNumbers: [], timezone, statedNumbers: none })).toBeNull();
      expect(NANP_TIMEZONES.has(String(timezone))).toBe(false);
    },
  );

  it('requires the corpus to corroborate the region once it states enough numbers', () => {
    const mostlyUk = [
      ...Array.from({ length: 11 }, () => UK_E164),
      ...Array.from({ length: 9 }, () => ADA_E164),
    ];

    expect(
      derivePhoneRegion({ selfStatedNumbers: [], timezone: 'America/Los_Angeles', statedNumbers: mostlyUk }),
    ).toBeNull();
    // Below the threshold the corpus is too small to argue with.
    expect(
      derivePhoneRegion({
        selfStatedNumbers: [],
        timezone: 'America/Los_Angeles',
        statedNumbers: mostlyUk.slice(0, 19),
      }),
    ).toBe('NANP');
  });
});

describe('placeholders', () => {
  it.each([
    ['+1 (202) 555-0142', { phones: [ADA_DIGITS] }],
    ['2025550142', { phones: [ADA_DIGITS] }],
    ['(202) 555-0142', { Phones: ['+1 202 555 0142'] }],
    ['+12025550142', {}],
  ])('treats %s — its own number — as a placeholder', (name, props) => {
    expect(classifyPhoneName(name, props)).toBe('own_number');
    expect(isPlaceholderPersonName(name)).toBe(true);
  });

  it('marks a name that is SOMEONE ELSE’S number', () => {
    expect(classifyPhoneName('+1 (212) 555-0199', { phones: [ADA_DIGITS] })).toBe('other_number');
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['ada.quill@example.com', 'email'],
    ['@ada.quill', 'handle'],
  ])('treats %p as a placeholder (%s)', (name, kind) => {
    expect(classifyPhoneName(name, {})).toBe(kind);
    expect(isPlaceholderPersonName(name)).toBe(true);
  });

  it('treats a real name as a name', () => {
    expect(classifyPhoneName('Ada Quill', {})).toBeNull();
    expect(isPlaceholderPersonName('Ada Quill')).toBe(false);
  });
});

describe('givenNameRelation', () => {
  it.each([
    ['Ada Quill', 'Ada', 'same'],
    ['Ada Quill', 'ada quill', 'same'],
    ['A. Quill', 'Ada Quill', 'initial'],
    ['Chris Quill', 'Christine Quill', 'prefix'],
    ['Ada Quill', 'Bo Quill', 'given_conflict'],
    ['Ada Quill', 'Ada Brightwater', 'family_conflict'],
    ['Ada Quill Jr.', 'Ada Quill Sr.', 'suffix_conflict'],
    ['Ada Quill Jr', 'Ada Quill', 'suffix_conflict'],
    ['Ada Quill III', 'Ada Quill III', 'same'],
    ["Ada's brother", 'Ada Quill', 'relational'],
    ['Quill', 'Ada Quill', 'unknown'],
    ['Mr Quill', 'Ada Quill', 'unknown'],
  ])('%s vs %s is %s', (left, right, expected) => {
    expect(givenNameRelation(left, right)).toBe(expected);
    expect(givenNameRelation(right, left)).toBe(expected);
  });

  it('reads the generational suffix from the raw name, past a professional one', () => {
    expect(generationalSuffix('Ada Quill, Jr., MD')).toBe('jr');
    expect(generationalSuffix('Ada Quill')).toBeNull();
  });
});

describe('PhoneHolders.adjudicate — the exact tier', () => {
  it('folds a number-named stub into the named contact that states the same number', () => {
    // No name overlap at all: the stub's name IS the number.
    expect(adjudicate(stub(), vcard('Ada Quill', '+1 (202) 555-0142'))).toEqual({
      kind: 'exact',
      numbers: [ADA_E164],
      basis: 'stated_both',
    });
  });

  it('reads national-format numbers into the owner’s region when both sides are national', () => {
    expect(adjudicate(stub('2025550142'), vcard('Ada Quill', '(202) 555-0142'))).toEqual({
      kind: 'exact',
      numbers: [ADA_E164],
      basis: 'inferred_both',
    });
  });

  it('folds two copies of one person on a same-given-name match', () => {
    expect(adjudicate(vcard('Ada Quill', '+1 202 555 0142'), vcard('Ada', '(202) 555-0142'))).toMatchObject({
      kind: 'exact',
      basis: 'stated_one',
    });
  });

  it('folds an unambiguous initial', () => {
    expect(
      adjudicate(vcard('A. Quill', '(202) 555-0142'), vcard('Ada Quill', '(202) 555-0142')),
    ).toMatchObject({
      kind: 'exact',
    });
  });

  it('allows a same-given pair on a household line with one other person', () => {
    expect(
      adjudicate(
        vcard('Ada Quill', '(202) 555-0142'),
        vcard('Ada Q.', '(202) 555-0142'),
        vcard('Bo Quill', '(202) 555-0142'),
      ).kind,
    ).toBe('exact');
    expect(PHONE_LINE_MAX_IDENTITIES).toBe(2);
  });
});

describe('PhoneHolders.adjudicate — shared lines and names', () => {
  it('never auto-merges a shared landline whose holders have different given names', () => {
    // The household case: a shared surname is what they have in common.
    expect(adjudicate(vcard('Ada Quill', '(202) 555-0142'), vcard('Bo Quill', '(202) 555-0142'))).toEqual({
      kind: 'review',
      numbers: [ADA_E164],
      reasons: ['given_name_conflict'],
    });
  });

  it.each([
    ['a family-name conflict', 'Ada Brightwater', 'family_name_conflict'],
    ['a given-name prefix', 'Adaline Quill', 'given_name_prefix'],
    ['a Jr/Sr pair', 'Ada Quill Sr.', 'suffix_conflict'],
    ['a relational name', "Ada's brother", 'relational_name'],
    ['a surname only', 'Quill', 'unknown_name'],
  ])('holds %s for review', (_label, other, reason) => {
    const left = vcard(other === 'Ada Quill Sr.' ? 'Ada Quill Jr.' : 'Ada Quill', '(202) 555-0142');

    expect(adjudicate(left, vcard(other, '(202) 555-0142'))).toEqual({
      kind: 'review',
      numbers: [ADA_E164],
      reasons: [reason],
    });
  });

  it('holds a stub for review when the line carries two real identities', () => {
    // Which of Ada and Bo was texting from the family line? The stub cannot say.
    expect(
      adjudicate(stub(), vcard('Ada Quill', '(202) 555-0142'), vcard('Bo Quill', '(202) 555-0142')),
    ).toEqual({ kind: 'review', numbers: [ADA_E164], reasons: ['shared_line'] });
  });

  it('holds an initial for review when it fits two given names on the line', () => {
    expect(
      adjudicate(
        vcard('A. Quill', '(202) 555-0142'),
        vcard('Ada Quill', '(202) 555-0142'),
        vcard('Abe Quill', '(202) 555-0142'),
      ),
    ).toMatchObject({ kind: 'review', reasons: ['shared_line'] });
  });

  // Folding is narrow: a suffix on one side only, or a different surname, only
  // holds a pair for review. It does not prove that an "A." on the line is not
  // that Ada, so the initial still fits two given names and still holds the line.
  it.each([
    ['A.', 'A. Quill', ['Abe Quill', 'Ada Quill Sr.']],
    ['A.', 'A.', ['Abe Quill', 'Ada Quill Jr.']],
    ['A.', 'A. Brightwater', ['Abe', 'Ada Quill Sr.']],
    ['Abe', 'Abe Quill', ['A. Quill', 'Ada Quill Jr.']],
  ])('holds %s and %s for review beside %j: the initial may be either given name', (left, right, others) => {
    const line = (name: string) => vcard(name, '(202) 555-0142');

    expect(adjudicate(line(left), line(right), ...others.map(line))).toEqual({
      kind: 'review',
      numbers: [ADA_E164],
      reasons: ['shared_line'],
    });
    expect(
      holdersOf(
        ...[left, right, ...others].map((name, index): [string, PhoneFacts] => [`h${index}`, line(name)]),
      ).lineCensus(ADA_DIGITS, ADA_E164).ambiguous,
    ).toBe(true);
  });

  it('holds a same-given pair for review on a line with a third identity', () => {
    expect(
      adjudicate(
        vcard('Ada Quill', '(202) 555-0142'),
        vcard('Ada Q.', '(202) 555-0142'),
        vcard('Bo Quill', '(202) 555-0142'),
        vcard('Cy Quill', '(202) 555-0142'),
      ),
    ).toMatchObject({ kind: 'review', reasons: ['shared_line'] });
  });

  describe('an office line: one given name, two surnames', () => {
    // Two coworkers named Ada on one main number. The adjudicator says they
    // are two people (family_name_conflict), so the census must count two.
    const quill = vcard('Ada Quill', '(202) 555-0142');
    const brightwater = vcard('Ada Brightwater', '(202) 555-0142');

    it('counts two identities, and nothing ambiguous', () => {
      const holders = holdersOf(['quill', quill], ['brightwater', brightwater], ['stub', stub()]);

      expect(holders.adjudicate(quill, brightwater)).toMatchObject({
        kind: 'review',
        reasons: ['family_name_conflict'],
      });
      expect(holders.lineCensus(ADA_DIGITS, ADA_E164)).toEqual({ identities: 2, ambiguous: false });
    });

    it('holds a stub for review against both Adas', () => {
      const line = stub();

      for (const [one, other] of [
        [quill, brightwater],
        [brightwater, quill],
      ]) {
        expect(adjudicate(line, one, other)).toEqual({
          kind: 'review',
          numbers: [ADA_E164],
          reasons: ['shared_line'],
        });
      }
    });

    it('holds a bare given name for review against both Adas: it could be either', () => {
      const ada = vcard('Ada', '(202) 555-0142');

      expect(adjudicate(ada, quill, brightwater)).toEqual({
        kind: 'review',
        numbers: [ADA_E164],
        reasons: ['shared_line'],
      });
      expect(adjudicate(ada, brightwater, quill)).toMatchObject({ kind: 'review', reasons: ['shared_line'] });
      expect(
        holdersOf(['ada', ada], ['quill', quill], ['brightwater', brightwater]).lineCensus(
          ADA_DIGITS,
          ADA_E164,
        ),
      ).toEqual({ identities: 2, ambiguous: true });
      // A surname initial is not read against the surnames: held, not guessed.
      expect(adjudicate(vcard('Ada Q.', '(202) 555-0142'), quill, brightwater)).toMatchObject({
        kind: 'review',
        reasons: ['shared_line'],
      });
    });

    it('still folds two copies of one of them', () => {
      expect(adjudicate(quill, vcard('Ada Quill', '+1 202 555 0142'), brightwater)).toEqual({
        kind: 'exact',
        numbers: [ADA_E164],
        basis: 'stated_one',
      });
    });

    it('splits initials with conflicting surnames the same way', () => {
      const aQuill = vcard('A. Quill', '(202) 555-0142');
      const aBrightwater = vcard('A. Brightwater', '(202) 555-0142');

      expect(adjudicate(stub(), aQuill, aBrightwater)).toMatchObject({
        kind: 'review',
        reasons: ['shared_line'],
      });
      expect(adjudicate(vcard('A.', '(202) 555-0142'), aQuill, aBrightwater)).toMatchObject({
        kind: 'review',
        reasons: ['shared_line'],
      });
    });

    it('splits a Jr/Sr pair on a family landline', () => {
      expect(
        adjudicate(
          stub(),
          vcard('Ada Quill Jr.', '(202) 555-0142'),
          vcard('Ada Quill Sr.', '(202) 555-0142'),
        ),
      ).toMatchObject({ kind: 'review', reasons: ['shared_line'] });
    });

    it('counts the pair being judged even when the caller never recorded it', () => {
      const ada = vcard('Ada', '(202) 555-0142');
      const holders = holdersOf(['quill', quill], ['brightwater', brightwater]);

      expect(holders.adjudicate(ada, quill)).toMatchObject({ kind: 'review', reasons: ['shared_line'] });
    });
  });

  it('holds a stub named by SOMEONE ELSE’S number for review', () => {
    const odd = facts('+1 (212) 555-0199', { Phones: ['+1 (202) 555-0142'] });

    expect(adjudicate(odd, vcard('Ada Quill', '(202) 555-0142'))).toMatchObject({
      kind: 'review',
      reasons: ['numeric_name_mismatch'],
    });
  });
});

describe('PhoneHolders.adjudicate — numbers that are not evidence', () => {
  it.each([
    ['a toll-free', '(888) 555-0100', 'service'],
    ['a premium', '(900) 555-0100', 'service'],
    ['an invalid', '(123) 555-0100', 'invalid'],
    ['an extension', '(202) 555-0142 x12', 'extension'],
  ])('writes nothing for %s number both people hold', (_label, number, reason) => {
    const verdict = adjudicate(vcard('Ada Quill', number), vcard('Ada Quill', number));

    expect(verdict).toEqual({ kind: 'unusable', reasons: [reason] });
    expect(phoneEvidenceFor(verdict)).toEqual([]);
  });

  it('writes nothing for a shared short code: it is not a line at all', () => {
    expect(adjudicate(vcard('Ada Quill', '52886'), vcard('Ada Quill', '52886'))).toEqual({ kind: 'absent' });
  });

  it("never uses the owner's own number as evidence between two contacts", () => {
    const self = facts('Owner Person', { Phones: ['+1 (202) 555-0142'] }, { self: true });
    const holders = holdersOf(['self', self], ['a', vcard('Ada Quill', '(202) 555-0142')], ['b', stub()]);

    expect(holders.adjudicate(holders.factsOf('a')!, holders.factsOf('b')!)).toEqual({
      kind: 'unusable',
      reasons: ['owner_number'],
    });
  });

  it('never grades a pair with a self endpoint exact', () => {
    const self = facts('Ada Quill', { Phones: ['+1 (202) 555-0142'] }, { self: true });

    expect(adjudicate(self, stub())).toEqual({
      kind: 'review',
      numbers: [ADA_E164],
      reasons: ['self_endpoint'],
    });
  });

  it('ignores a number more people hold than the cap', () => {
    const others = Array.from({ length: PHONE_MAX_HOLDERS - 1 }, (_, index) =>
      vcard(`Holder${index} Quill`, '(202) 555-0142'),
    );

    expect(adjudicate(stub(), vcard('Ada Quill', '(202) 555-0142'), ...others)).toEqual({
      kind: 'unusable',
      reasons: ['over_common'],
    });
    // Exactly at the cap it is still a number (and a switchboard of names, so review).
    expect(adjudicate(stub(), vcard('Ada Quill', '(202) 555-0142'), ...others.slice(1)).kind).toBe('review');
  });

  it('pins the cap to the profile-URL cap', () => {
    expect(PHONE_MAX_HOLDERS).toBe(PROFILE_URL_MAX_HOLDERS);
  });
});

describe('PhoneHolders.adjudicate — countries', () => {
  it('marks the same ten digits in two stated countries as a conflict', () => {
    const verdict = adjudicate(vcard('Ada Quill', '+44 20 7946 0958'), vcard('Ada Quill', '+1 207 946 0958'));

    expect(verdict).toEqual({
      kind: 'country_conflict',
      conflicts: [{ left: UK_E164, right: '+12079460958' }],
    });
    expect(phoneEvidenceFor(verdict)).toEqual([
      { kind: PHONE_EVIDENCE.conflict, value: `${UK_E164} ≠ +12079460958`, score: 0 },
    ]);
  });

  it('never matches an international number against a US reading of its last ten digits', () => {
    // The corpus states these digits as UK, so the national value is not
    // read as (207) 946-0958. It is the same digits, country unknown: at
    // most a review question, never a match.
    const verdict = adjudicate(vcard('Ada Quill', '+44 20 7946 0958'), stub(UK_DIGITS, UK_DIGITS));

    expect(verdict).toEqual({ kind: 'unconfirmed', digits: [UK_DIGITS] });
    expect(phoneEvidenceFor(verdict)).toEqual([
      { kind: PHONE_EVIDENCE.match, value: UK_DIGITS, score: PHONE_IDENTITY_SCORES.unconfirmed },
    ]);
  });

  it("never reads a foreign national number's truncated join key as a US number", () => {
    // The vCard kept "020 7946 0958"; the importer's `phones` key is its last
    // ten digits, "2079460958", which would otherwise read as (207) 946-0958.
    const uk = vcard('Ada Quill', '020 7946 0958');

    expect(adjudicate(uk, stub(UK_DIGITS, UK_DIGITS))).toEqual({ kind: 'unusable', reasons: ['invalid'] });
  });

  it('lets a stated form on one card beat the inferred reading of its own join key', () => {
    // A UK vCard's `phones` key "2079460958" must not become +1 on the card itself.
    const card = vcard('Ada Quill', '+44 20 7946 0958');
    const holders = holdersOf(['card', card]);

    expect(holders.resolve(card, UK_DIGITS)).toEqual({ kind: 'number', e164: UK_E164, stated: true });
  });

  it('lets a claim that states another country poison the inference for those digits only', () => {
    const left = stub(UK_DIGITS, UK_DIGITS);
    const right = vcard('Ada Quill', '(207) 946-0958');
    const poisoned = new PhoneHolders(
      [
        ['left', left],
        ['right', right],
      ],
      [[UK_DIGITS, UK_E164]],
    );

    expect(poisoned.adjudicate(left, right).kind).toBe('unconfirmed');
    expect(holdersOf(['left', left], ['right', right]).adjudicate(left, right).kind).toBe('exact');

    const ada = new PhoneHolders(
      [
        ['stub', stub()],
        ['ada', vcard('Ada Quill', '(202) 555-0142')],
      ],
      [[UK_DIGITS, UK_E164]],
    );
    expect(ada.adjudicate(stub(), vcard('Ada Quill', '(202) 555-0142')).kind).toBe('exact');
  });

  it('gives no exact tier to national numbers when the owner has no region', () => {
    const left = facts('2025550142', { phones: [ADA_DIGITS] }, { region: null });
    const right = facts('Ada Quill', { Phones: ['(202) 555-0142'] }, { region: null });

    expect(adjudicate(left, right).kind).toBe('unconfirmed');
  });
});

describe('verdict → evidence', () => {
  const claimExact = { kind: 'phone', value: ADA_DIGITS, score: 0.95 };
  const name = { kind: 'name_cluster', value: 'ada', score: 0.5 };

  it('replaces every phone item with the verdict’s, and rescores', () => {
    const graded = applyPhoneVerdict(
      { score: 0.95, evidence: [claimExact, name] },
      { kind: 'review', numbers: [ADA_E164], reasons: ['given_name_conflict'] },
    );

    expect(graded).toEqual({
      score: 0.85,
      evidence: [
        { kind: 'phone', value: ADA_E164, score: 0.85 },
        name,
        { kind: 'phone_check', value: 'given_name_conflict', score: 0 },
      ],
    });
  });

  it('removes the claim pass’s item when the number is not evidence at all', () => {
    expect(
      applyPhoneVerdict({ score: 0.75, evidence: [claimExact] }, { kind: 'unusable', reasons: ['service'] }),
    ).toEqual({
      score: 0,
      evidence: [],
    });
  });

  it('is idempotent', () => {
    const verdict: PhoneVerdict = { kind: 'exact', numbers: [ADA_E164], basis: 'stated_both' };
    const once = applyPhoneVerdict({ score: 0.5, evidence: [name] }, verdict);

    expect(applyPhoneVerdict(once, verdict)).toEqual(once);
  });

  it('caps an unadjudicated 0.95 phone item below the auto-merge tier, once', () => {
    const capped = capUnadjudicatedPhones({ score: 0.95, evidence: [claimExact, name] });

    expect(capped).toEqual({
      score: 0.85,
      evidence: [
        { kind: 'phone', value: ADA_DIGITS, score: 0.85 },
        name,
        { kind: 'phone_check', value: 'unadjudicated', score: 0 },
      ],
    });
    expect(capUnadjudicatedPhones(capped)).toEqual(capped);
    expect(applyPhoneVerdict({ score: 0.95, evidence: [claimExact] }, { kind: 'absent' }).score).toBe(0.85);
  });

  it('leaves a candidate with no strong phone item alone', () => {
    expect(capUnadjudicatedPhones({ score: 0.5, evidence: [name] })).toEqual({
      score: 0.5,
      evidence: [name],
    });
  });
});

describe('the corpus', () => {
  it('derives the region from the corpus and extracts only people with lines', () => {
    const { region, facts: byId } = phoneCorpusFacts(
      [
        {
          entity_id: 'stub',
          person_name: '+1 (202) 555-0142',
          phone_props: { phones: [ADA_DIGITS] },
          is_self: false,
        },
        {
          entity_id: 'ada',
          person_name: 'Ada Quill',
          phone_props: { Phones: ['(202) 555-0142'] },
          is_self: false,
        },
        { entity_id: 'nobody', person_name: 'Bo Quill', phone_props: {}, is_self: false },
      ],
      { timezone: 'America/Los_Angeles', selfEntityId: null },
    );

    expect(region).toBe('NANP');
    expect([...byId.keys()].sort()).toEqual(['ada', 'stub']);
    expect(sharedPhoneLines(byId)).toEqual([ADA_DIGITS]);
  });

  it('treats users.entity_id as the owner even when is_self is not set', () => {
    const { facts: byId } = phoneCorpusFacts(
      [
        {
          entity_id: 'me',
          person_name: 'Owner Person',
          phone_props: { Phones: ['+44 20 7946 0958'] },
          is_self: false,
        },
      ],
      { timezone: 'America/Los_Angeles', selfEntityId: 'me' },
    );

    expect(byId.get('me')?.isSelf).toBe(true);
  });

  it('loads only the keys it reads, and numeric names', () => {
    expect(phoneFactsSqlObject('e')).toBe(
      "jsonb_build_object('Phones', e.properties->'Phones', 'phones', e.properties->'phones', 'phone', e.properties->'phone')",
    );
    expect(PHONE_FACTS_CORPUS_SQL).toContain("e.properties ?| array['Phones', 'phones', 'phone']");
    expect(PHONE_FACTS_CORPUS_SQL).toContain('e.merged_into_entity_id IS NULL');
  });
});
