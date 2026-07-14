import { createBrowserActivitySchemaRoot } from '../types';

const row = (url: string) => ({ time: '2026-01-01T00:00:00.000Z', url });

describe('browser-activity url validation (#1673)', () => {
  it('accepts http(s) URLs (unchanged)', () => {
    expect(createBrowserActivitySchemaRoot.parse(row('https://x.example/p')).url).toBe('https://x.example/p');
  });

  it('accepts non-http identities: search synthetics and bare queries', () => {
    // Importers deliver search rows as `search:<query>` synthetics or bare
    // query text; the column is a plain-text identity nothing dereferences.
    expect(createBrowserActivitySchemaRoot.parse(row('search:rust%20lang')).url).toBe('search:rust%20lang');
    expect(createBrowserActivitySchemaRoot.parse(row('coffee near me')).url).toBe('coffee near me');
  });

  it('still rejects an empty identity', () => {
    expect(() => createBrowserActivitySchemaRoot.parse(row(''))).toThrow();
  });
});
