import { resolveTargetFor } from '../resolveKey';

describe('resolveTargetFor', () => {
  it('keys oEmbed providers by provider handle so every play of a track shares one lookup', () => {
    const a = resolveTargetFor({
      externalId: 'spotify:track:3fzTpBMSQKjo9sW0T8Tw2O',
      externalIdKind: 'external_uri',
    });
    const b = resolveTargetFor({ url: 'https://open.spotify.com/track/3fzTpBMSQKjo9sW0T8Tw2O?si=xyz' });
    expect(a).toMatchObject({ resolver: 'oembed', key: 'oembed:spotify:track:3fzTpBMSQKjo9sW0T8Tw2O' });
    expect(b?.key).toBe(a?.key);
    expect(resolveTargetFor({ url: 'https://vimeo.com/76979871' })).toMatchObject({
      resolver: 'oembed',
      key: 'oembed:vimeo:video:76979871',
    });
  });

  it('gives YouTube rows nothing to resolve: player and poster are templated from the id', () => {
    // Not oEmbed, and NOT a fall-through to OpenGraph either — that would be a
    // watch-page fetch per video across a 70k-row history.
    expect(resolveTargetFor({ url: 'https://youtu.be/dQw4w9WgXcQ' })).toBeNull();
    expect(resolveTargetFor({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42' })).toBeNull();
    expect(
      resolveTargetFor({ externalId: 'youtube:video:dQw4w9WgXcQ', externalIdKind: 'external_uri' }),
    ).toBeNull();
  });

  it('keys Netflix and Prime rows by the parsed work', () => {
    const ep1 = resolveTargetFor({
      sourceSystem: 'netflix',
      sourceTitle: 'Dark: Season 1: Alpha and Omega (Episode 10)',
    });
    const ep2 = resolveTargetFor({
      sourceSystem: 'netflix',
      sourceTitle: 'Dark: Season 2: Beginnings and Endings (Episode 1)',
    });
    expect(ep1).toMatchObject({
      resolver: 'wikidata',
      key: 'wd:tv:dark',
      work: { title: 'Dark', season: 1 },
    });
    expect(ep2?.key).toBe('wd:tv:dark');
    expect(
      resolveTargetFor({ sourceSystem: 'prime_video', sourceTitle: 'Sam Smith: Dreams Come True' }),
    ).toMatchObject({
      key: 'wd:movie:sam smith dreams come true',
    });
  });

  it('keys Hulu rows by the parsed work, through the Netflix title shape', () => {
    expect(
      resolveTargetFor({
        sourceSystem: 'hulu',
        externalId: 'hulu:title:0123456789abcdef',
        externalIdKind: 'external_uri',
        sourceTitle: "Bob's Burgers: Season 16: The Keyboard Kid",
      }),
    ).toMatchObject({
      resolver: 'wikidata',
      key: 'wd:tv:bob s burgers',
      work: { kind: 'tv', title: "Bob's Burgers", season: 16, episodeTitle: 'The Keyboard Kid' },
    });
    expect(resolveTargetFor({ sourceSystem: 'hulu', sourceTitle: 'The Raid: Redemption' })).toMatchObject({
      key: 'wd:movie:the raid redemption',
    });
  });

  it('keys Disney+ rows the same way', () => {
    expect(
      resolveTargetFor({
        sourceSystem: 'disney_plus',
        externalId: 'disney_plus:title:0123456789abcdef',
        externalIdKind: 'external_uri',
        sourceTitle: 'The Mandalorian: Season 1: Chapter 2: The Child',
      }),
    ).toMatchObject({
      resolver: 'wikidata',
      key: 'wd:tv:the mandalorian',
      work: { kind: 'tv', title: 'The Mandalorian', season: 1, episodeTitle: 'Chapter 2: The Child' },
    });
  });

  it('falls back to OpenGraph for any other web URL, canonicalized', () => {
    expect(
      resolveTargetFor({ url: 'https://www.reddit.com/r/gifs/comments/459icd/x/?utm_source=share' }),
    ).toMatchObject({
      resolver: 'opengraph',
      key: expect.stringMatching(/^og:https:\/\/reddit\.com\/r\/gifs\/comments\/459icd/),
    });
    expect(resolveTargetFor({ url: 'https://www.audible.com/pd/B005QDO084' })).toMatchObject({
      resolver: 'opengraph',
    });
  });

  it('returns null for rows with nothing to resolve', () => {
    expect(
      resolveTargetFor({ externalId: '019ee82a-2f70-71fd-b4a7-2679a8e5140b', externalIdKind: 'file' }),
    ).toBeNull();
    expect(resolveTargetFor({ sourceSystem: 'audible', sourceTitle: 'Snuff' })).toBeNull();
    expect(resolveTargetFor({})).toBeNull();
  });
});
