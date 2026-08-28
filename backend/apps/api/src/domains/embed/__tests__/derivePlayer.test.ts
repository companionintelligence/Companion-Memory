import { derivePlayer, derivePlayerFromRef } from '../derivePlayer';

describe('derivePlayer', () => {
  it('maps a YouTube watch URL to the nocookie player and hqdefault poster', () => {
    expect(derivePlayer('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30')).toEqual({
      provider: 'youtube',
      providerRef: 'youtube:video:dQw4w9WgXcQ',
      playerUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      posterUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      aspectRatio: 16 / 9,
      mediaKind: 'video',
    });
    expect(derivePlayer('https://youtu.be/dQw4w9WgXcQ')?.playerUrl).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
  });

  it('maps Spotify tracks to the compact player and collections to the card', () => {
    const track = derivePlayer('https://open.spotify.com/track/3fzTpBMSQKjo9sW0T8Tw2O?si=abc');
    expect(track).toMatchObject({
      provider: 'spotify',
      playerUrl: 'https://open.spotify.com/embed/track/3fzTpBMSQKjo9sW0T8Tw2O',
      aspectRatio: 352 / 152,
      mediaKind: 'audio',
    });
    expect(track?.posterUrl).toBeUndefined();

    // A native URI resolves the same as its web URL.
    expect(derivePlayer('spotify:episode:00pPGRIGtzPTKCoBZtcv6R')?.playerUrl).toBe(
      'https://open.spotify.com/embed/episode/00pPGRIGtzPTKCoBZtcv6R',
    );
    expect(derivePlayer('https://open.spotify.com/album/1ATL5GLyefJaxhQzSPVrLX')).toMatchObject({
      aspectRatio: 1,
      mediaKind: 'playlist',
    });
  });

  it('maps Vimeo and Dailymotion videos', () => {
    expect(derivePlayer('https://vimeo.com/76979871')?.playerUrl).toBe(
      'https://player.vimeo.com/video/76979871?dnt=1',
    );
    expect(derivePlayer('https://www.dailymotion.com/video/x7tgad0')?.playerUrl).toBe(
      'https://www.dailymotion.com/embed/video/x7tgad0',
    );
  });

  it('maps SoundCloud tracks and sets through the widget', () => {
    expect(derivePlayerFromRef('soundcloud:track:forss/flickermood')?.playerUrl).toBe(
      'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fforss%2Fflickermood&visual=true&show_teaser=false',
    );
    expect(derivePlayerFromRef('soundcloud:set:forss/soulhack')).toMatchObject({
      playerUrl: expect.stringContaining(encodeURIComponent('https://soundcloud.com/forss/sets/soulhack')),
      mediaKind: 'playlist',
    });
  });

  it('returns null for channels, tweets, unknown providers and non-provider URLs', () => {
    expect(derivePlayerFromRef('youtube:channel:UC6IxnFzHofFJ5X2PycSMsww')).toBeNull();
    expect(derivePlayerFromRef('x:tweet:953045498121908225')).toBeNull();
    expect(derivePlayerFromRef('spotify:user:someone')).toBeNull();
    expect(derivePlayerFromRef('garbage')).toBeNull();
    expect(derivePlayer('https://www.audible.com/pd/B005QDO084')).toBeNull();
    expect(derivePlayer(null)).toBeNull();
    expect(derivePlayer('')).toBeNull();
  });
});
