import { describe, expect, it } from 'vitest';

import { isGivenNameOnly, sharedNameTokens, tokenizeDisplayName } from './peopleNameTokens';

describe('tokenizeDisplayName', () => {
  it('strips an honorific so mr broza is a family name', () => {
    expect(tokenizeDisplayName('Mr Broza')).toEqual(
      expect.objectContaining({ values: ['broza'], family: 'broza', given: null }),
    );
  });

  it('treats a bare chat name as given-only', () => {
    expect(isGivenNameOnly('william')).toBe(true);
    expect(isGivenNameOnly('William Broza')).toBe(false);
  });

  it('highlights the shared last name across variants', () => {
    expect([...sharedNameTokens('mr broza', 'William D Broza')]).toEqual(['broza']);
  });
});
