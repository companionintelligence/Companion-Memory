import { shouldCachePoster } from '../services/UnfurlService';

/**
 * Spotify cover art is hotlinked, not copied: `i.scdn.co/image/<hash>` is
 * content-addressed and stable, and a listening history is tens of thousands of
 * plays. Everything that can rot — OpenGraph images on signed CDNs, Wikimedia
 * files that get renamed — still gets its copy.
 */
describe('shouldCachePoster', () => {
  it('skips Spotify oEmbed art', () => {
    expect(
      shouldCachePoster({
        resolver: 'oembed',
        key: 'oembed:spotify:track:x',
        providerRef: 'spotify:track:x',
      }),
    ).toBe(false);
    expect(
      shouldCachePoster({
        resolver: 'oembed',
        key: 'oembed:spotify:album:y',
        providerRef: 'spotify:album:y',
      }),
    ).toBe(false);
  });

  it('still copies posters for every other resolver', () => {
    expect(
      shouldCachePoster({ resolver: 'oembed', key: 'oembed:vimeo:video:1', providerRef: 'vimeo:video:1' }),
    ).toBe(true);
    expect(
      shouldCachePoster({
        resolver: 'opengraph',
        key: 'og:https://example.com/a',
        url: 'https://example.com/a',
      }),
    ).toBe(true);
    expect(shouldCachePoster({ resolver: 'wikidata', key: 'wd:tv:dark' })).toBe(true);
  });
});
