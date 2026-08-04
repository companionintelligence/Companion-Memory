import {
  channelProviderRef,
  parseIsoDurationSeconds,
  pickThumbnailUrl,
  playlistProviderRef,
  videoProviderRef,
  youtubeEmbedSourceData,
} from '../youtubeMedia';

describe('pickThumbnailUrl', () => {
  it('prefers the largest variant the API actually returned', () => {
    expect(
      pickThumbnailUrl({
        default: { url: 'd.jpg' },
        medium: { url: 'm.jpg' },
        high: { url: 'h.jpg' },
        standard: { url: 's.jpg' },
        maxres: { url: 'mr.jpg' },
      }),
    ).toBe('mr.jpg');
  });

  it('falls back down the ladder when larger variants are absent', () => {
    expect(pickThumbnailUrl({ default: { url: 'd.jpg' }, medium: { url: 'm.jpg' } })).toBe('m.jpg');
    expect(pickThumbnailUrl({ default: { url: 'd.jpg' } })).toBe('d.jpg');
  });

  it('returns undefined for missing or empty thumbnails', () => {
    expect(pickThumbnailUrl(undefined)).toBeUndefined();
    expect(pickThumbnailUrl({})).toBeUndefined();
  });

  // maxresdefault.jpg 404s for any upload below 720p, and nothing here can check
  // without a network request — so a maxres URL is only ever used when the API
  // itself reported one.
  it('never synthesises a maxres URL that the API did not report', () => {
    expect(pickThumbnailUrl({ high: { url: 'h.jpg' } })).toBe('h.jpg');
  });
});

describe('parseIsoDurationSeconds', () => {
  it.each([
    ['PT0S', 0],
    ['PT13S', 13],
    ['PT4M13S', 253],
    ['PT1H2M3S', 3723],
    ['PT1H', 3600],
    ['PT2M', 120],
    ['P1DT2H', 93600],
  ])('parses %s to %i seconds', (iso, expected) => {
    expect(parseIsoDurationSeconds(iso)).toBe(expected);
  });

  it('returns undefined rather than 0 for absent or unparseable input', () => {
    expect(parseIsoDurationSeconds(undefined)).toBeUndefined();
    expect(parseIsoDurationSeconds(null)).toBeUndefined();
    expect(parseIsoDurationSeconds('')).toBeUndefined();
    expect(parseIsoDurationSeconds('4:13')).toBeUndefined();
    expect(parseIsoDurationSeconds('garbage')).toBeUndefined();
    // "P"/"PT" carry no components — not a duration.
    expect(parseIsoDurationSeconds('P')).toBeUndefined();
    expect(parseIsoDurationSeconds('PT')).toBeUndefined();
  });

  it('keeps a genuinely zero duration distinguishable from a missing one', () => {
    expect(parseIsoDurationSeconds('PT0S')).toBe(0);
    expect(parseIsoDurationSeconds(undefined)).toBeUndefined();
  });

  it('rounds fractional seconds', () => {
    expect(parseIsoDurationSeconds('PT1.4S')).toBe(1);
    expect(parseIsoDurationSeconds('PT1.6S')).toBe(2);
  });
});

describe('provider refs', () => {
  it('builds stable, kind-scoped references', () => {
    expect(videoProviderRef('dQw4w9WgXcQ')).toBe('youtube:video:dQw4w9WgXcQ');
    expect(channelProviderRef('UC123')).toBe('youtube:channel:UC123');
    expect(playlistProviderRef('PL456')).toBe('youtube:playlist:PL456');
  });
});

describe('youtubeEmbedSourceData', () => {
  it('records provider, ref, thumbnail and duration', () => {
    const data = youtubeEmbedSourceData({
      providerRef: 'youtube:video:abc',
      thumbnails: { high: { url: 'h.jpg' } },
      durationIso: 'PT4M13S',
    });

    expect(data).toMatchObject({
      provider: 'youtube',
      providerRef: 'youtube:video:abc',
      thumbnailUrl: 'h.jpg',
      durationIso: 'PT4M13S',
      durationSeconds: 253,
    });
  });

  it('omits absent fields rather than writing undefined keys', () => {
    const data = youtubeEmbedSourceData({ providerRef: 'youtube:channel:UC1' });

    expect(data).toEqual({ provider: 'youtube', providerRef: 'youtube:channel:UC1' });
    expect(Object.keys(data)).not.toContain('thumbnailUrl');
    expect(Object.keys(data)).not.toContain('durationSeconds');
  });

  // playlists.list and activities.list carry no duration; only videos.list does.
  it('omits duration when the endpoint does not provide one', () => {
    const data = youtubeEmbedSourceData({
      providerRef: 'youtube:playlist:PL1',
      thumbnails: { medium: { url: 'm.jpg' } },
    });

    expect(data.thumbnailUrl).toBe('m.jpg');
    expect(data.durationIso).toBeUndefined();
    expect(data.durationSeconds).toBeUndefined();
  });
});
