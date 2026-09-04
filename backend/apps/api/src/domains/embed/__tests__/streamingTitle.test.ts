import {
  normalizeWorkTitle,
  parseNetflixTitle,
  parsePrimeVideoTitle,
  parseStreamingTitle,
} from '../streamingTitle';

describe('parseNetflixTitle', () => {
  it('splits Show: Season N: Episode (Episode M)', () => {
    expect(parseNetflixTitle('Dark: Season 1: Alpha and Omega (Episode 10)')).toEqual({
      kind: 'tv',
      title: 'Dark',
      season: 1,
      episode: 10,
      episodeTitle: 'Alpha and Omega',
    });
  });

  it('handles Volume / Limited Series and shows with their own colon', () => {
    expect(
      parseNetflixTitle(
        'Patriot Act with Hasan Minhaj: Volume 5: How America Is Causing Global Obesity (Episode 7)',
      ),
    ).toMatchObject({
      kind: 'tv',
      title: 'Patriot Act with Hasan Minhaj',
      season: 5,
      episode: 7,
    });
    expect(parseNetflixTitle('The Keepers: Limited Series: The Murder (Episode 1)')).toMatchObject({
      kind: 'tv',
      title: 'The Keepers',
      season: undefined,
      episode: 1,
      episodeTitle: 'The Murder',
    });
    expect(parseNetflixTitle('Star Trek: Discovery: Season 2: Brother (Episode 1)')).toMatchObject({
      kind: 'tv',
      title: 'Star Trek: Discovery',
      season: 2,
    });
  });

  it('treats films and specials as movies', () => {
    expect(parseNetflixTitle('The Ballad of Buster Scruggs')).toEqual({
      kind: 'movie',
      title: 'The Ballad of Buster Scruggs',
    });
    expect(parseNetflixTitle('Aziz Ansari: RIGHT NOW')).toEqual({
      kind: 'movie',
      title: 'Aziz Ansari: RIGHT NOW',
    });
    expect(parseNetflixTitle('  ')).toBeNull();
  });
});

describe('parsePrimeVideoTitle', () => {
  it('splits Episode-Show - Season N', () => {
    expect(parsePrimeVideoTitle('The Flame of Tar Valon-The Wheel of Time - Season 1')).toEqual({
      kind: 'tv',
      title: 'The Wheel of Time',
      season: 1,
      episodeTitle: 'The Flame of Tar Valon',
    });
    expect(parsePrimeVideoTitle('Ready, Aim, Marry Me!-Arrested Development Season 2')).toMatchObject({
      kind: 'tv',
      title: 'Arrested Development',
      season: 2,
    });
    expect(parsePrimeVideoTitle('To Sardines and Back-Transparent Season 3')).toMatchObject({
      title: 'Transparent',
      season: 3,
    });
  });

  it('does not split a hyphenated film title without a season marker', () => {
    expect(parsePrimeVideoTitle('Spider-Man: Into the Spider-Verse')).toEqual({
      kind: 'movie',
      title: 'Spider-Man: Into the Spider-Verse',
    });
    expect(parsePrimeVideoTitle('Sam Smith: Dreams Come True')).toEqual({
      kind: 'movie',
      title: 'Sam Smith: Dreams Come True',
    });
  });
});

describe('parseStreamingTitle', () => {
  it('reads Hulu titles with the Netflix parser', () => {
    expect(parseStreamingTitle('hulu', "Bob's Burgers: Season 16: The Keyboard Kid")).toEqual({
      kind: 'tv',
      title: "Bob's Burgers",
      season: 16,
      episode: undefined,
      episodeTitle: 'The Keyboard Kid',
    });
    expect(parseStreamingTitle('hulu', 'Alien: Earth: Season 1: The Real Monsters')).toMatchObject({
      kind: 'tv',
      title: 'Alien: Earth',
      season: 1,
    });
    expect(parseStreamingTitle('hulu', 'The Raid: Redemption')).toEqual({
      kind: 'movie',
      title: 'The Raid: Redemption',
    });
    expect(parseStreamingTitle('disney_plus', 'Anything')).toBeNull();
  });
});

describe('normalizeWorkTitle', () => {
  it('folds case, accents and punctuation', () => {
    expect(normalizeWorkTitle("Won't You Be My Neighbor?")).toBe('won t you be my neighbor');
    expect(normalizeWorkTitle('Amélie')).toBe('amelie');
    expect(normalizeWorkTitle('The  Crown ')).toBe('the crown');
  });
});
