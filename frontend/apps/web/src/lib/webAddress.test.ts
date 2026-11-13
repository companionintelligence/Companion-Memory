import { describe, expect, it } from 'vitest';

import { webAddress } from './webAddress';

describe('webAddress', () => {
  it('parses http and https addresses', () => {
    expect(webAddress('https://vitest.dev/guide/')?.hostname).toBe('vitest.dev');
    expect(webAddress('http://example.com/a')?.pathname).toBe('/a');
  });

  it('is null for text that an import stored in place of an address', () => {
    expect(webAddress('Explored on Google Maps')).toBeNull();
    expect(webAddress('Dismissed shelf Expiration date: Dec 8, 2026')).toBeNull();
    expect(webAddress('')).toBeNull();
    expect(webAddress(null)).toBeNull();
  });

  it('is null for schemes a page link should never carry', () => {
    expect(webAddress('javascript:alert(1)')).toBeNull();
    expect(webAddress('file:///etc/passwd')).toBeNull();
  });
});
