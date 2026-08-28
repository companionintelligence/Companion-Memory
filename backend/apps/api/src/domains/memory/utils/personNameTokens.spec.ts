import {
  NAME_OVERLAP_SCORES,
  compareTokenizedNames,
  isRelationalDescriptor,
  pickFullerName,
  tokenizePersonName,
} from './personNameTokens';

describe('tokenizePersonName', () => {
  it('strips honorifics and tags the remaining lone token as family', () => {
    const tokens = tokenizePersonName('Mr Broza');

    expect(tokens?.values).toEqual(['broza']);
    expect(tokens?.family).toBe('broza');
    expect(tokens?.given).toBeNull();
    expect(tokens?.hadHonorific).toBe(true);
  });

  it('tags a bare chat name as given', () => {
    const tokens = tokenizePersonName('william');

    expect(tokens?.values).toEqual(['william']);
    expect(tokens?.given).toBe('william');
    expect(tokens?.family).toBeNull();
    expect(tokens?.hadHonorific).toBe(false);
  });

  it('splits a full name and treats a single letter as an initial', () => {
    const tokens = tokenizePersonName('William D. Broza');

    expect(tokens?.values).toEqual(['william', 'd', 'broza']);
    expect(tokens?.given).toBe('william');
    expect(tokens?.family).toBe('broza');
    expect(tokens?.tokens.map((token) => token.role)).toEqual(['given', 'initial', 'family']);
  });

  it('drops a trailing suffix', () => {
    expect(tokenizePersonName('William Broza Jr')?.values).toEqual(['william', 'broza']);
  });

  it('folds diacritics the same way normalizeName does', () => {
    expect(tokenizePersonName('José García')?.values).toEqual(['jose', 'garcia']);
  });

  it('returns null for empty input and for honorific-only strings', () => {
    expect(tokenizePersonName('   ')).toBeNull();
    expect(tokenizePersonName('Mr.')).toBeNull();
    expect(tokenizePersonName(null)).toBeNull();
  });
});

describe('compareTokenizedNames', () => {
  function compare(a: string, b: string) {
    return compareTokenizedNames(tokenizePersonName(a)!, tokenizePersonName(b)!);
  }

  it('matches a short family form to the full name', () => {
    const overlap = compare('mr broza', 'william d broza');

    expect(overlap?.kind).toBe('family');
    expect(overlap?.score).toBe(NAME_OVERLAP_SCORES.family);
    expect(overlap?.shared).toEqual(['broza']);
  });

  it('matches a name that drops the middle initial as a family subset', () => {
    const overlap = compare('william broza', 'william d broza');

    expect(overlap?.kind).toBe('family');
    expect(overlap?.shared).toEqual(['william', 'broza']);
  });

  it('matches a two-token name whose last word is a middle name in the longer form', () => {
    expect(compare('william david', 'william david broza')?.kind).toBe('subset');
  });

  it('matches honorific-only variants as the same tokens', () => {
    const overlap = compare('Mr. William Broza', 'william broza');

    expect(overlap?.kind).toBe('variant');
    expect(overlap?.score).toBe(NAME_OVERLAP_SCORES.variant);
  });

  it('matches a bare given name to a fuller form', () => {
    const overlap = compare('william', 'william broza');

    expect(overlap?.kind).toBe('given');
    expect(overlap?.score).toBe(NAME_OVERLAP_SCORES.given);
  });

  it('treats a bare surname without honorific as a family match when it equals the other last name', () => {
    expect(compare('broza', 'william d broza')?.kind).toBe('family');
  });

  it('refuses two people who share a first name and disagree on the last', () => {
    expect(compare('john smith', 'john jones')).toBeNull();
  });

  it('refuses a relational descriptor', () => {
    expect(isRelationalDescriptor("Priya's brother")).toBe(true);
    expect(compare("Priya's brother", 'Priya Sharma')).toBeNull();
  });
});

describe('pickFullerName', () => {
  it('keeps the token-superset rather than the merge target', () => {
    expect(pickFullerName(['mr broza', 'William D Broza'])).toBe('William D Broza');
  });

  it('returns the first non-empty name when nothing is fuller', () => {
    expect(pickFullerName([null, '', 'Dana'])).toBe('Dana');
  });
});
