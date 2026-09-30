import { readFileSync } from 'node:fs';
import path from 'node:path';

// The memory domain's public barrel — `no-cross-domain-internals` allows only
// that (and graph already depends on memory, so this adds no new edge).
import { parsePhone } from '@ci/domains/memory';

import {
  PHONE_EXTENSION_PATTERN,
  classifyParticipant,
  hasPhoneExtension,
  normalizeEmail,
  normalizeIdentifier,
  normalizeName,
  normalizePhone,
  splitPersonName,
} from './normalizeIdentifier';

describe('hasPhoneExtension', () => {
  it.each([
    '(310) 555-0175;229',
    '(212) 555-0147,229',
    '555-0147#229',
    '(212) 555-0147 x229',
    '2125550147x229',
    '(212) 555-0147 x229 (office)',
    '+1 212 555 0147 ext. 229',
    '212-555-0147 Ext: 229',
    '212-555-0147 extn 229',
    '212-555-0147 extension 229',
    '2125550147p229',
    '2125550147 w 229',
  ])('refuses %p', (raw) => {
    expect(hasPhoneExtension(raw)).toBe(true);
  });

  it.each(['(212) 555-0147', '+44 20 7946 0958', 'tel:+12125550147', 'Fax: 212-555-0147', 'Mobile', ''])(
    'lets %p through',
    (raw) => {
      expect(hasPhoneExtension(raw)).toBe(false);
    },
  );

  it('reads null as no extension', () => {
    expect(hasPhoneExtension(null)).toBe(false);
  });

  it('is the exact pattern the contact-card migration embeds, in both places it reads one', () => {
    // A SQL copy that drifted would judge a number an extension in one place
    // and a line in the other.
    const migration = readFileSync(
      path.join(
        __dirname,
        '../../../../db/postgres/migrations/20260930022046_index_contact_card_emails_and_phones.sql',
      ),
      'utf8',
    );

    expect(migration.split(`~* '${PHONE_EXTENSION_PATTERN}'`)).toHaveLength(3);
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  John.Doe@Example.COM ')).toBe('john.doe@example.com');
  });

  it('returns null for empty / whitespace / null', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });

  it('extracts the address from an RFC 5322 mailbox so display names do not fragment identity', () => {
    expect(normalizeEmail('Bill Hegemon <hegemon.bill@gmail.com>')).toBe('hegemon.bill@gmail.com');
    expect(normalizeEmail('<Hegemon.Bill@Gmail.com>')).toBe('hegemon.bill@gmail.com');
    // A bare address (no angle brackets) still normalizes as before.
    expect(normalizeEmail('hegemon.bill@gmail.com')).toBe('hegemon.bill@gmail.com');
  });
});

describe('normalizePhone', () => {
  it('keeps the last 10 digits, stripping country code and punctuation', () => {
    expect(normalizePhone('+1 (415) 555-0100')).toBe('4155550100');
    expect(normalizePhone('1-415-555-0100')).toBe('4155550100');
    expect(normalizePhone('4155550100')).toBe('4155550100');
  });

  it('collapses differently-formatted versions of the same number to one value', () => {
    expect(normalizePhone('+14155550100')).toBe(normalizePhone('(415) 555-0100'));
  });

  it('keeps all digits when fewer than 10 (e.g. short codes)', () => {
    expect(normalizePhone('611')).toBe('611');
    expect(normalizePhone('555-0100')).toBe('5550100');
  });

  it('returns null when there are no digits', () => {
    expect(normalizePhone('not-a-number')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  // The shape the defect was found in: an Apple Contacts export writes an office
  // line's extension as `TEL;type=pref:(212) 555-0147\;229`, and the last ten
  // digits of main line + extension are a DIFFERENT, well-formed number. These
  // fixtures are the same shape with invented 555-01XX numbers.
  it.each([
    ['(212) 555-0147;229', '5550147229'],
    ['+1 (212) 555-0147;229', '5550147229'],
    ['212-555-0147 x229', '5550147229'],
    ['212.555.0147 X 229', '5550147229'],
    ['2125550147x229', '5550147229'],
    ['212-555-0147 ext 229', '5550147229'],
    ['212-555-0147 ext. 229', '5550147229'],
    ['212-555-0147 Ext:229', '5550147229'],
    ['212-555-0147 extn 229', '5550147229'],
    ['212-555-0147 extension 229', '5550147229'],
    ['(212) 555-0147, x2290', '5501472290'],
    ['212-555-0147,229', '5550147229'],
    ['212-555-0147#229', '5550147229'],
    ['tel:+1-212-555-0147;ext=229', '5550147229'],
    ['+12125550147p229', '5550147229'],
    ['+1 212 555 0147 w 229', '5550147229'],
  ])('refuses %p rather than keying it as the fabricated %p', (raw, fabricated) => {
    expect(normalizePhone(raw)).toBeNull();
    expect(normalizeIdentifier('phone', raw)).toBeNull();
    // The number the old rule would have minted, spelled out so the failure a
    // regression causes reads as what it is.
    expect(raw.replace(/\D/g, '').slice(-10)).toBe(fabricated);
  });

  it('is still a fixed point, so a stored key re-normalizes to itself', () => {
    for (const raw of ['+1 (415) 555-0100', '5550100', '415.555.0100']) {
      const once = normalizePhone(raw);

      expect(normalizePhone(once)).toBe(once);
    }
  });
});

describe('hasPhoneExtension', () => {
  it.each([
    '(212) 555-0147;229',
    '212-555-0147 x229',
    '2125550147x229',
    '212-555-0147 EXT. 229',
    '212-555-0147 extension 229',
    '212-555-0147,229',
    '212-555-0147#229',
    '212-555-0147p229',
    '212-555-0147 w 229',
    'tel:+1-212-555-0147;ext=229',
  ])('flags %p', (raw) => {
    expect(hasPhoneExtension(raw)).toBe(true);
  });

  it.each([
    '+1 (212) 555-0147',
    '212.555.0147',
    '0044 20 7946 0958',
    'tel:+12125550147',
    // Letters that are not an extension marker: a label, and a vanity word.
    'Fax 212-555-0147',
    'Box 12',
    'Telex 5550147',
    '1-800-FLOWERS',
    '',
  ])('does not flag %p', (raw) => {
    expect(hasPhoneExtension(raw)).toBe(false);
  });

  it('treats null and undefined as no extension', () => {
    expect(hasPhoneExtension(null)).toBe(false);
    expect(hasPhoneExtension(undefined)).toBe(false);
  });

  it('refuses at least everything the duplicate detector refuses as an extension', () => {
    // `parsePhone` (memory/utils/phoneIdentity.ts) is the older parser and the
    // one this rule was brought into line with. The reverse inclusion does not
    // hold, by design: the detector ALSO refuses any letter, so it never needed
    // to name `…0147x229` as an extension, and the join key does.
    const forms = [
      '(212) 555-0147;229',
      '212-555-0147,229',
      '212-555-0147#229',
      '212-555-0147 x229',
      '212-555-0147 ext. 229',
      '212-555-0147 extension 229',
    ];

    for (const raw of forms) {
      expect(parsePhone(raw, 'NANP').status).toBe('extension');
      expect(hasPhoneExtension(raw)).toBe(true);
    }
  });

  it('is restated verbatim in the migration that repaired the truncated keys', () => {
    // The migration's `pg_temp.phone_has_extension` is this pattern under `~*`.
    // A pattern edited here without the migration would leave the two disagreeing
    // about which stored keys were truncations; a migration is immutable once
    // applied, so the fix for a drift is a NEW migration, and this test is what
    // says one is needed.
    const migration = readFileSync(
      path.join(
        __dirname,
        '../../../../db/postgres/migrations/20260930020117_refuse_phone_extension_join_keys.sql',
      ),
      'utf8',
    );

    expect(migration).toContain(`v ~* '${PHONE_EXTENSION_PATTERN}'`);
  });
});

describe('normalizeIdentifier', () => {
  it('dispatches on kind', () => {
    expect(normalizeIdentifier('email', '  A@B.com')).toBe('a@b.com');
    expect(normalizeIdentifier('phone', '+1 415 555 0100')).toBe('4155550100');
  });
});

describe('normalizeName', () => {
  it('lowercases, collapses whitespace, and strips diacritics', () => {
    expect(normalizeName('  Jos\u00e9   GARC\u00cdA ')).toBe('jose garcia');
    expect(normalizeName('Brian Paul')).toBe('brian paul');
    expect(normalizeName('Andrea Schr\u00f6er F')).toBe('andrea schroer f');
  });

  it('returns null for empty / whitespace / null', () => {
    expect(normalizeName('')).toBeNull();
    expect(normalizeName('   ')).toBeNull();
    expect(normalizeName(null)).toBeNull();
    expect(normalizeName(undefined)).toBeNull();
  });
});

describe('classifyParticipant', () => {
  it('classifies an @-bearing string as email', () => {
    expect(classifyParticipant(' John.Doe@Example.COM ')).toEqual({
      kind: 'email',
      valueNormalized: 'john.doe@example.com',
    });
  });

  it('classifies a phone-shaped string as phone', () => {
    expect(classifyParticipant('+1 (415) 555-0100')).toEqual({
      kind: 'phone',
      valueNormalized: '4155550100',
    });
    expect(classifyParticipant('415.555.0100')).toEqual({
      kind: 'phone',
      valueNormalized: '4155550100',
    });
    // 7 digits (shortest local subscriber number) still counts.
    expect(classifyParticipant('555-0100')).toEqual({
      kind: 'phone',
      valueNormalized: '5550100',
    });
  });

  it('classifies a digit-bearing handle as name, NOT phone (Discord usernames)', () => {
    // The old any-digit rule turned these into bogus short "phone numbers"
    // ('alexmz12' -> phone '12') and let unrelated handles sharing a digit run
    // collide into one Person.
    expect(classifyParticipant('alexmz12')).toEqual({ kind: 'name', valueNormalized: 'alexmz12' });
    expect(classifyParticipant('griffin5131')).toEqual({
      kind: 'name',
      valueNormalized: 'griffin5131',
    });
    expect(classifyParticipant('david3dev')).toEqual({ kind: 'name', valueNormalized: 'david3dev' });
  });

  it('classifies short all-digit strings (SMS short codes) as name, not phone', () => {
    expect(classifyParticipant('42')).toEqual({ kind: 'name', valueNormalized: '42' });
    expect(classifyParticipant('862265')).toEqual({ kind: 'name', valueNormalized: '862265' });
  });

  it('classifies a namespaced platform account id as name, not phone', () => {
    // The contract `datasources/twitter.ts` relies on. A DM partner the archive
    // cannot name used to ride out as the BARE account id, and this function
    // has no upper digit bound -- E.164 stops at 15, a Twitter snowflake is
    // 18-19 -- so it typed as a phone and `normalizePhone` kept the last ten
    // digits: a Person named after an account id, holding a phone number that
    // belongs to nobody and matchable to a real contact at 0.85 confidence.
    // 213 such identifiers existed on one full-corpus import.
    //
    // Both id shapes are pinned, because the 7-15 digit ones of early accounts
    // are the dangerous half: a fabricated number in that range is
    // indistinguishable from a real one.
    expect(classifyParticipant('twitter:id:1657380978392702976')).toEqual({
      kind: 'name',
      valueNormalized: 'twitter:id:1657380978392702976',
    });
    expect(classifyParticipant('twitter:id:6245902')).toEqual({
      kind: 'name',
      valueNormalized: 'twitter:id:6245902',
    });
    // And the bare form this replaced, so the reason the namespace exists stays
    // visible: it is the phone branch that swallowed it.
    expect(classifyParticipant('1657380978392702976')).toEqual({
      kind: 'phone',
      valueNormalized: '8392702976',
    });
  });

  it('classifies a display-name-only string as name (Messenger participants)', () => {
    expect(classifyParticipant('Brian Paul')).toEqual({
      kind: 'name',
      valueNormalized: 'brian paul',
    });
    expect(classifyParticipant('Jos\u00e9 Garc\u00eda')).toEqual({
      kind: 'name',
      valueNormalized: 'jose garcia',
    });
  });

  it('returns null for empty / whitespace / null', () => {
    expect(classifyParticipant('')).toBeNull();
    expect(classifyParticipant('   ')).toBeNull();
    expect(classifyParticipant(null)).toBeNull();
  });
});

describe('splitPersonName', () => {
  it('splits two tokens into first + last (no middle key at all)', () => {
    expect(splitPersonName('Brian Paul')).toEqual({ first_name: 'Brian', last_name: 'Paul' });
    expect(splitPersonName('Brian Paul')).not.toHaveProperty('middle_name');
  });

  it('returns no parts for a single token (display name stays name-only)', () => {
    expect(splitPersonName('Cher')).toBeNull();
  });

  it('routes everything between first and last into middle', () => {
    expect(splitPersonName('Nancy Jiang Sprute')).toEqual({
      first_name: 'Nancy',
      middle_name: 'Jiang',
      last_name: 'Sprute',
    });
    expect(splitPersonName('John Jacob Jingleheimer Schmidt')).toEqual({
      first_name: 'John',
      middle_name: 'Jacob Jingleheimer',
      last_name: 'Schmidt',
    });
  });

  it('collapses whitespace and returns null for empty input', () => {
    expect(splitPersonName('  Brian   Paul  ')).toEqual({ first_name: 'Brian', last_name: 'Paul' });
    expect(splitPersonName('   ')).toBeNull();
    expect(splitPersonName(null)).toBeNull();
  });
});

describe('classifyParticipant refuses what is structurally not a name', () => {
  // The `name` branch is the fallthrough, so every parser leak used to arrive
  // here as an ordinary name and leave as a Person. THE regression these guard:
  // 3,079 live Person rows named with a Google Voice call-log heading and 241
  // named with a Messenger export filename — the latter twice, because
  // migration 20260818220731 deleted the rows without stopping the minter.
  it('refuses a call-log heading, in every verb the parser emits', () => {
    for (const heading of [
      'Missed call from',
      'Placed call to',
      'Received call from',
      'Voicemail from',
      'Recorded call with',
    ]) {
      expect(classifyParticipant(heading)).toBeNull();
    }
  });

  it('refuses a heading that swallowed the contact name with it', () => {
    expect(classifyParticipant('Placed call to \nNancy Davis')).toBeNull();
    expect(classifyParticipant('Missed call from Steven Stone')).toBeNull();
  });

  it('refuses an export filename', () => {
    expect(classifyParticipant('Group Conversation - 2024-09-25T01_45_41Z.html')).toBeNull();
    expect(classifyParticipant('messages.json')).toBeNull();
  });

  it('refuses anything carrying a newline, including an email-shaped one', () => {
    expect(classifyParticipant('Alice\nSmith')).toBeNull();
    expect(classifyParticipant('Missed call from \nalice@example.com')).toBeNull();
  });

  it('still classifies the clean value the repaired metadata now carries', () => {
    expect(classifyParticipant('Nancy Davis')).toEqual({ kind: 'name', valueNormalized: 'nancy davis' });
    expect(classifyParticipant('voicemail@from.example.com')).toEqual({
      kind: 'email',
      valueNormalized: 'voicemail@from.example.com',
    });
  });
});
