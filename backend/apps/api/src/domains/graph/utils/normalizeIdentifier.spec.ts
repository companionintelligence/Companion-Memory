import {
  classifyParticipant,
  normalizeEmail,
  normalizeIdentifier,
  normalizeName,
  normalizePhone,
  splitPersonName,
} from './normalizeIdentifier';

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
