import { primaryIdentity, resolveIdentities } from './resolveIdentities';
import { MAX_VALUE_NORMALIZED_LENGTH } from './types';

describe('resolveIdentities', () => {
  it('accretes every applicable rung in precedence order', () => {
    const identities = resolveIdentities({
      source: { type: 'ETL', system: 'youtube', id: 'like:abc' },
      url: 'https://youtu.be/dQw4w9WgXcQ',
      contentSha256: 'a'.repeat(64),
      owningRowId: '0198f000-0000-7000-8000-000000000001',
      text: 'a liked video',
      naturalKey: 'nat:v1:' + 'b'.repeat(64),
    });

    expect(identities.map((identity) => identity.kind)).toEqual(['src', 'url', 'sha256', 'txt', 'nat']);
  });

  it('requires all three triple legs before minting an src rung', () => {
    const partial = resolveIdentities({ source: { type: 'ETL', system: 'youtube' } });

    expect(partial.map((identity) => identity.kind)).not.toContain('src');
  });

  it('gives two spellings of one url the same url rung', () => {
    const a = resolveIdentities({ url: 'https://youtu.be/dQw4w9WgXcQ?t=30' });
    const b = resolveIdentities({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=x' });

    expect(a[0]?.valueNormalized).toBe(b[0]?.valueNormalized);
  });

  it('gives different urls different rungs', () => {
    const a = resolveIdentities({ url: 'https://youtu.be/dQw4w9WgXcQ' });
    const b = resolveIdentities({ url: 'https://youtu.be/oHg5SJYRHA0' });

    expect(a[0]?.valueNormalized).not.toBe(b[0]?.valueNormalized);
  });

  // The over-merge guard: bytes-identity must not fuse two objects on its own.
  it('scopes a bytes identity to its owning row so identical bytes do not auto-collapse', () => {
    const shared = { contentSha256: 'c'.repeat(64) };
    const a = resolveIdentities({ ...shared, owningRowId: 'row-a' });
    const b = resolveIdentities({ ...shared, owningRowId: 'row-b' });

    expect(a[0]?.valueNormalized).not.toBe(b[0]?.valueNormalized);
    expect(a[0]?.kind).toBe('sha256');
  });

  it('drops a bytes identity that has no owning row to scope it', () => {
    expect(resolveIdentities({ contentSha256: 'c'.repeat(64) })).toEqual([]);
  });

  it('ranks url above sha256 so a stock image cannot outrank a real address', () => {
    const identities = resolveIdentities({
      url: 'https://example.com/a',
      contentSha256: 'd'.repeat(64),
      owningRowId: 'row-a',
    });

    expect(identities[0]?.kind).toBe('url');
  });

  it('collapses whitespace so reformatting does not fork a text identity', () => {
    const a = resolveIdentities({ text: 'hello   world' });
    const b = resolveIdentities({ text: '  hello world  ' });

    expect(a[0]?.valueNormalized).toBe(b[0]?.valueNormalized);
  });

  it.each([
    ['a very long url', { url: `https://example.com/${'x'.repeat(5000)}` }],
    ['a long source id', { source: { type: 'ETL', system: 's', id: 'y'.repeat(5000) } }],
    ['long text', { text: 'z'.repeat(50_000) }],
    [
      'a bytes identity',
      { contentSha256: 'e'.repeat(64), owningRowId: '0198f000-0000-7000-8000-000000000001' },
    ],
  ])('keeps %s inside the indexable length bound', (_label, input) => {
    for (const identity of resolveIdentities(input)) {
      expect(identity.valueNormalized.length).toBeLessThanOrEqual(MAX_VALUE_NORMALIZED_LENGTH);
    }
  });

  it('yields no rungs for an input carrying nothing identifying', () => {
    expect(resolveIdentities({ url: 'https://bit.ly/3abc' })).toEqual([]);
  });

  it('stamps the spec version on every rung', () => {
    const identities = resolveIdentities({ url: 'https://example.com/a', specVersion: 7 });

    expect(identities.every((identity) => identity.specVersion === 7)).toBe(true);
  });
});

describe('primaryIdentity', () => {
  it('returns the highest-precedence rung', () => {
    const identity = primaryIdentity({
      source: { type: 'ETL', system: 'youtube', id: 'like:abc' },
      url: 'https://youtu.be/dQw4w9WgXcQ',
    });

    expect(identity.kind).toBe('src');
  });

  it('falls back down the ladder as rungs disappear', () => {
    expect(primaryIdentity({ url: 'https://example.com/a' }).kind).toBe('url');
    expect(primaryIdentity({ text: 'just a note' }).kind).toBe('txt');
    expect(primaryIdentity({ naturalKey: 'nat:v1:abc' }).kind).toBe('nat');
  });

  // Failing loudly is the point: a silent null here is how rows fall out of the
  // object model entirely.
  it('throws rather than inventing an identity when nothing resolves', () => {
    expect(() => primaryIdentity({})).toThrow(/no identity could be resolved/);
  });
});
