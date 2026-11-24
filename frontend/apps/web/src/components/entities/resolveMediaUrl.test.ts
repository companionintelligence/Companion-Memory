import { afterEach, describe, expect, it } from 'vitest';

import { enterNativeShell, NATIVE_MEMORY_ORIGIN } from '@/test/nativeShell';

import { resolveContentTileUrl, resolveFileTileUrl, resolveMediaUrl } from './resolveMediaUrl';

describe('resolveMediaUrl', () => {
  it('prefixes relative paths with /static', () => {
    expect(resolveMediaUrl('/u/shot.png')).toBe('/static/u/shot.png');
  });

  it('leaves absolute http(s) URLs alone', () => {
    expect(resolveMediaUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
  });

  it('leaves an inline data: or blob: image alone instead of gluing /static onto it', () => {
    // vcard.ts embeds a contact's photo as a data: URI; `/staticdata:image/...`
    // resolves to nothing, which is how every such contact lost its photo.
    expect(resolveMediaUrl('data:image/jpeg;base64,/9j/AAA')).toBe('data:image/jpeg;base64,/9j/AAA');
    expect(resolveMediaUrl('blob:http://localhost/1b2c')).toBe('blob:http://localhost/1b2c');
  });

  it('returns undefined for empty values', () => {
    expect(resolveMediaUrl(null)).toBeUndefined();
    expect(resolveMediaUrl('')).toBeUndefined();
  });
});

/**
 * The bundled iOS/Android app serves its own files from `capacitor://localhost`
 * / `https://localhost`, so a bare `/static/...` is a request to the WebView
 * itself: every thumbnail, avatar and drawer image on the phone was a broken
 * placeholder and "Download" navigated the WebView to the app's 404 page
 * (QA MEM-06 / MEM-07). Native media URLs have to carry the paired Memory origin.
 */
describe('resolveMediaUrl on the native shell', () => {
  let leaveNativeShell: () => void = () => undefined;

  afterEach(() => leaveNativeShell());

  it('puts the paired Memory origin in front of /static', () => {
    leaveNativeShell = enterNativeShell();

    expect(resolveMediaUrl('/u/shot.png?X-Amz-Signature=sig')).toBe(
      `${NATIVE_MEMORY_ORIGIN}/static/u/shot.png?X-Amz-Signature=sig`,
    );
  });

  it('does not double the slash when the origin was saved with a trailing one', () => {
    leaveNativeShell = enterNativeShell({ origin: `${NATIVE_MEMORY_ORIGIN}/` });

    expect(resolveMediaUrl('/u/shot.png')).toBe(`${NATIVE_MEMORY_ORIGIN}/static/u/shot.png`);
  });

  it('still leaves absolute and inline URLs alone', () => {
    leaveNativeShell = enterNativeShell();

    expect(resolveMediaUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(resolveMediaUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('carries the origin through the tile resolvers every grid, row and gallery uses', () => {
    leaveNativeShell = enterNativeShell();

    expect(resolveFileTileUrl({ contentType: 'image/jpeg', previewUrl: '/p/thumb.jpg' })).toBe(
      `${NATIVE_MEMORY_ORIGIN}/static/p/thumb.jpg`,
    );
    expect(resolveContentTileUrl({ mimetype: 'image/png', mediaUrl: '/u/shot.png' })).toBe(
      `${NATIVE_MEMORY_ORIGIN}/static/u/shot.png`,
    );
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

  it('does not point an <img> at a HEIC original when the JPEG preview is missing', () => {
    expect(
      resolveFileTileUrl({
        contentType: 'image/heic',
        previewUrl: null,
        sourceUrl: '/u/IMG_0001.heic',
      }),
    ).toBeUndefined();
    expect(
      resolveFileTileUrl({
        contentType: 'image/heif-sequence',
        previewUrl: null,
        sourceUrl: '/u/burst.heif',
      }),
    ).toBeUndefined();
  });

  it('uses the JPEG preview for a HEIC photo', () => {
    expect(
      resolveFileTileUrl({
        contentType: 'image/heic',
        previewUrl: '/u/IMG_0001-preview.jpg',
        sourceUrl: '/u/IMG_0001.heic',
      }),
    ).toBe('/static/u/IMG_0001-preview.jpg');
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
