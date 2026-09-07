import { watchLinkFor, watchLinksFor } from '../watchLinks';

describe('watchLinksFor', () => {
  it('builds each provider page from its Wikidata id', () => {
    expect(
      watchLinksFor({
        huluSeries: '2171423f-3326-4dfa-b193-b40494e60109',
        netflix: '80100172',
        primeVideo: 'B07ZTQ3TJG',
        disneyPlusSeries: '3jLIGMDYINqD',
      }),
    ).toEqual({
      hulu: 'https://www.hulu.com/series/2171423f-3326-4dfa-b193-b40494e60109',
      netflix: 'https://www.netflix.com/title/80100172',
      prime_video: 'https://www.amazon.com/gp/video/detail/B07ZTQ3TJG',
      disney_plus: 'https://www.disneyplus.com/series/wp/3jLIGMDYINqD',
    });
  });

  it('uses the movie page when the item is a film, and the series page when it claims both', () => {
    expect(watchLinksFor({ huluMovie: 'c984923d-a3a8-5ab3-911c-29d68d3db58e' })).toEqual({
      hulu: 'https://www.hulu.com/movie/c984923d-a3a8-5ab3-911c-29d68d3db58e',
    });
    expect(
      watchLinksFor({
        huluSeries: '2171423f-3326-4dfa-b193-b40494e60109',
        huluMovie: 'c984923d-a3a8-5ab3-911c-29d68d3db58e',
      }),
    ).toEqual({ hulu: 'https://www.hulu.com/series/2171423f-3326-4dfa-b193-b40494e60109' });
    expect(watchLinksFor({ disneyPlusMovie: '5cWPGDlkVDpF' })).toEqual({
      disney_plus: 'https://www.disneyplus.com/movies/wd/5cWPGDlkVDpF',
    });
    expect(watchLinksFor({ disneyPlusSeries: '3jLIGMDYINqD', disneyPlusMovie: '5cWPGDlkVDpF' })).toEqual({
      disney_plus: 'https://www.disneyplus.com/series/wp/3jLIGMDYINqD',
    });
  });

  it('refuses ids that do not match the property format, and reports none when nothing is left', () => {
    expect(
      watchLinksFor({
        huluSeries: 'not-a-uuid',
        netflix: '12',
        primeVideo: 'B07ZTQ3TJG/../x',
        disneyPlusSeries: '../3jLIGMDYINqD',
      }),
    ).toBeUndefined();
    expect(watchLinksFor({})).toBeUndefined();
  });
});

describe('watchLinkFor', () => {
  const payload = {
    watch_links: { hulu: 'https://www.hulu.com/series/2171423f-3326-4dfa-b193-b40494e60109' },
  };

  it("returns the row's own provider page and site name", () => {
    expect(watchLinkFor('hulu', payload)).toEqual({
      url: 'https://www.hulu.com/series/2171423f-3326-4dfa-b193-b40494e60109',
      siteName: 'Hulu',
    });
  });

  it('returns null for a source without a link, a non-streaming source, or a bad payload', () => {
    expect(watchLinkFor('netflix', payload)).toBeNull();
    expect(watchLinkFor('audible', payload)).toBeNull();
    expect(watchLinkFor('hulu', {})).toBeNull();
    expect(watchLinkFor('hulu', { watch_links: 'nope' })).toBeNull();
    expect(watchLinkFor('hulu', { watch_links: { hulu: 'javascript:alert(1)' } })).toBeNull();
    expect(watchLinkFor(null, payload)).toBeNull();
  });
});
