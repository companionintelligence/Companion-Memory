import { describe, expect, it } from 'vitest';

import { resolveContentTileUrl, resolveFileTileUrl, resolveMediaUrl } from './resolveMediaUrl';

describe('resolveMediaUrl', () => {
  it('prefixes relative paths with /static', () => {
    expect(resolveMediaUrl('/u/shot.png')).toBe('/static/u/shot.png');
  });

  it('leaves absolute http(s) URLs alone', () => {
    expect(resolveMediaUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
  });

  it('returns undefined for empty values', () => {
    expect(resolveMediaUrl(null)).toBeUndefined();
    expect(resolveMediaUrl('')).toBeUndefined();
  });
});

describe('resolveFileTileUrl', () => {
  it('prefers previewUrl when present', () => {
    expect(
      resolveFileTileUrl({
        contentType: 'image/png',
        previewUrl: '/p/thumb.png',
        sourceUrl: '/u/shot.png',
      }),
    ).toBe('/static/p/thumb.png');
  });

  it('falls back to sourceUrl for image/png when preview is missing', () => {
    expect(
      resolveFileTileUrl({
        contentType: 'image/png',
        previewUrl: null,
        sourceUrl: '/u/shot.png',
      }),
    ).toBe('/static/u/shot.png');
  });

  it('gives a preview-less video NO thumbnail rather than pointing an <img> at the .mp4', () => {
    // The old fallback handed the tile the video file itself, which an <img>
    // cannot decode: a full download followed by a broken-image glyph.
    expect(
      resolveFileTileUrl({
        contentType: 'video/mp4',
        previewUrl: null,
        sourceUrl: '/u/clip.mp4',
      }),
    ).toBeUndefined();
  });

  it('still uses the preview for a video when one exists', () => {
    expect(
      resolveFileTileUrl({
        contentType: 'video/mp4',
        previewUrl: '/u/clip-preview.jpg',
        sourceUrl: '/u/clip.mp4',
      }),
    ).toBe('/static/u/clip-preview.jpg');
  });

  it('does not use sourceUrl for non-media content types', () => {
    expect(
      resolveFileTileUrl({
        contentType: 'application/pdf',
        previewUrl: null,
        sourceUrl: '/u/doc.pdf',
      }),
    ).toBeUndefined();
  });
});

describe('resolveContentTileUrl', () => {
  it('prefers the hydrated preview over everything else', () => {
    expect(
      resolveContentTileUrl({
        mimetype: 'audio/ogg',
        previewUrl: '/p/thumb.png',
        unfurlThumbnailUrl: 'https://i.scdn.co/image/abc',
      }),
    ).toBe('/static/p/thumb.png');
  });

  it('falls back to the content/source url for an image row with no preview', () => {
    expect(
      resolveContentTileUrl({
        mimetype: 'image/jpeg',
        contentUrl: '/u/shot.jpg',
      }),
    ).toBe('/static/u/shot.jpg');
  });

  it("falls back to the unfurl stage's cached poster for a Spotify track (audio/ogg, no linked image)", () => {
    expect(
      resolveContentTileUrl({
        mimetype: 'audio/ogg',
        unfurlThumbnailUrl: 'https://i.scdn.co/image/ab67616d00001e02abc',
      }),
    ).toBe('https://i.scdn.co/image/ab67616d00001e02abc');
  });

  it("falls back to the player's templated poster when there is no unfurl thumbnail", () => {
    expect(
      resolveContentTileUrl({
        mimetype: 'video/mp4',
        playerPosterUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
      }),
    ).toBe('https://i.ytimg.com/vi/abc/hqdefault.jpg');
  });

  it('returns undefined for a non-image row with neither an unfurl nor a player poster (Spotify before enrich.unfurl has run)', () => {
    expect(resolveContentTileUrl({ mimetype: 'audio/ogg' })).toBeUndefined();
  });
});
