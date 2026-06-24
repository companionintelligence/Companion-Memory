import { embedSkipReason, isEmbeddable, shouldEmbedType } from '../embeddable';

describe('embedSkipReason', () => {
  it('skips null/undefined/empty/whitespace as "empty"', () => {
    expect(embedSkipReason(null)).toBe('empty');
    expect(embedSkipReason(undefined)).toBe('empty');
    expect(embedSkipReason('')).toBe('empty');
    expect(embedSkipReason('   \n\t ')).toBe('empty');
  });

  it('skips text below the minimum length as "too-short"', () => {
    // default minTextLength is 3
    expect(embedSkipReason('a')).toBe('too-short');
    expect(embedSkipReason('ab')).toBe('too-short');
    // exactly the minimum is allowed (>= min)
    expect(embedSkipReason('abc')).toBeNull();
  });

  it('honours an explicit minLength override', () => {
    expect(embedSkipReason('hello', { minLength: 10 })).toBe('too-short');
    expect(embedSkipReason('hello world!', { minLength: 10 })).toBeNull();
    // override of 0 disables the length floor (non-empty always passes length)
    expect(embedSkipReason('a', { minLength: 0 })).toBeNull();
  });

  it('skips exact trivial / reaction phrases as "trivial"', () => {
    expect(embedSkipReason('Loved an image')).toBe('trivial');
    expect(embedSkipReason('loved an image.')).toBe('trivial');
    expect(embedSkipReason('LIKED A MESSAGE')).toBe('trivial');
    expect(embedSkipReason('  reacted to a message  ')).toBe('trivial');
    expect(embedSkipReason('thanks')).toBe('trivial');
  });

  it('does NOT skip real text that merely contains a trivial phrase', () => {
    // conservative: only an EXACT match is trivial
    expect(embedSkipReason('I loved an image of the Grand Canyon you sent')).toBeNull();
    expect(embedSkipReason('thanks for the detailed roadmap breakdown')).toBeNull();
  });

  it('keeps ordinary searchable content', () => {
    expect(embedSkipReason('Your billing account was suspended')).toBeNull();
    expect(embedSkipReason('Kingston NV3 1TB NVMe SSD')).toBeNull();
  });
});

describe('isEmbeddable', () => {
  it('is the boolean inverse of a skip reason', () => {
    expect(isEmbeddable('Loved an image')).toBe(false);
    expect(isEmbeddable('')).toBe(false);
    expect(isEmbeddable('a meaningful sentence worth indexing')).toBe(true);
  });
});

describe('shouldEmbedType', () => {
  it('embeds all types when the allowlist is empty (default)', () => {
    expect(shouldEmbedType('communication', [])).toBe(true);
    expect(shouldEmbedType('message', [])).toBe(true);
  });

  it('restricts embedding to the configured allowlist', () => {
    const allow = ['person', 'event'];
    expect(shouldEmbedType('person', allow)).toBe(true);
    expect(shouldEmbedType('event', allow)).toBe(true);
    expect(shouldEmbedType('message', allow)).toBe(false);
    expect(shouldEmbedType('communication', allow)).toBe(false);
  });
});
