import { normalizeEmail, normalizeIdentifier, normalizePhone } from './normalizeIdentifier';

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
