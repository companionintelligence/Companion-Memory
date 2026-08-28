import type { ContentType } from '../../types/ContentType';
import { ContentResolver } from '../ContentResolver';

/**
 * `player` is a pure derivation from the row — no loader, no I/O — so the
 * tests only pin which column feeds it and that non-provider rows stay null.
 */
function makeResolver() {
  return new ContentResolver(
    {} as never,
    { load: jest.fn() } as never,
    { load: jest.fn() } as never,
    { load: jest.fn() } as never,
    { load: jest.fn() } as never,
  );
}

function node(source: Partial<ContentType['__source']>): ContentType {
  return { __source: { userId: 'user-1', ...source } } as unknown as ContentType;
}

describe('ContentResolver.player', () => {
  it('derives the player from a source-native external_uri even when url is null', () => {
    const player = makeResolver().player(
      node({ externalId: 'spotify:track:3fzTpBMSQKjo9sW0T8Tw2O', externalIdKind: 'external_uri', url: null }),
    );

    expect(player).toMatchObject({
      provider: 'spotify',
      providerRef: 'spotify:track:3fzTpBMSQKjo9sW0T8Tw2O',
      playerUrl: 'https://open.spotify.com/embed/track/3fzTpBMSQKjo9sW0T8Tw2O',
      posterUrl: null,
      mediaKind: 'audio',
    });
  });

  it('falls back to url, then sourceUrl', () => {
    const resolver = makeResolver();

    expect(resolver.player(node({ url: 'https://youtu.be/dQw4w9WgXcQ' }))).toMatchObject({
      provider: 'youtube',
      posterUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    });
    expect(
      resolver.player(node({ url: '/static/files/clip.mp4', sourceUrl: 'https://vimeo.com/76979871' })),
    ).toMatchObject({ provider: 'vimeo' });
  });

  it('never treats a file-kind external id as a provider handle', () => {
    expect(
      makeResolver().player(
        node({ externalId: '019ee82a-2f70-71fd-b4a7-2679a8e5140b', externalIdKind: 'file' }),
      ),
    ).toBeNull();
  });

  it('is null for rows with no supported provider', () => {
    const resolver = makeResolver();

    expect(resolver.player(node({ url: 'https://www.audible.com/pd/B005QDO084' }))).toBeNull();
    expect(
      resolver.player(
        node({ externalId: 'primevideo:title:43780c6b2df25ceb', externalIdKind: 'external_uri' }),
      ),
    ).toBeNull();
    expect(resolver.player(node({}))).toBeNull();
  });
});
