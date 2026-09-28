import { describe, expect, it } from 'vitest';

import type { EntityItem } from '../useEntityService';

import { MAX_UNPREVIEWED_THUMB_BYTES, getEntityMedia, pickThumbUrl } from './media';

// The real EntityItem is a large masked GraphQL union; tests only need the
// fields getEntityMedia reads, so build minimal shapes and cast.
const entity = (shape: Record<string, unknown>) => shape as unknown as EntityItem;

describe('getEntityMedia', () => {
  describe('FileType', () => {
    it('resolves an image file with separate preview and source URLs', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'FileType',
          id: 'f1',
          galleryContentType: 'image/jpeg',
          gallerySourceUrl: '/files/a.jpg',
          galleryPreviewUrl: '/files/a-thumb.jpg',
          galleryFilename: 'a.jpg',
        }),
      );

      expect(media).toEqual({
        entityId: 'f1',
        kind: 'image',
        contentType: 'image/jpeg',
        thumbUrl: '/static/files/a-thumb.jpg',
        fullUrl: '/static/files/a.jpg',
        title: 'a.jpg',
      });
    });

    it('passes through absolute URLs without the /static prefix', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'FileType',
          id: 'f2',
          galleryContentType: 'video/mp4',
          gallerySourceUrl: 'https://cdn.example.com/v.mp4',
          galleryFilename: 'v.mp4',
        }),
      );

      expect(media?.kind).toBe('video');
      expect(media?.fullUrl).toBe('https://cdn.example.com/v.mp4');
      // A preview-less video never becomes the tile's <img> source — the tile
      // draws the placeholder instead of downloading a file it cannot decode.
      expect(media?.thumbUrl).toBeNull();
    });

    it('defaults the title to "Untitled" when no filename is present', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'FileType',
          id: 'f3',
          galleryContentType: 'image/png',
          gallerySourceUrl: '/files/x.png',
        }),
      );

      expect(media?.title).toBe('Untitled');
    });

    it('returns null for a non-media content type', () => {
      expect(
        getEntityMedia(
          entity({
            __typename: 'FileType',
            id: 'f4',
            galleryContentType: 'application/pdf',
            gallerySourceUrl: '/x.pdf',
          }),
        ),
      ).toBeNull();
    });

    it('returns null when a media file has no URL', () => {
      expect(
        getEntityMedia(entity({ __typename: 'FileType', id: 'f5', galleryContentType: 'image/png' })),
      ).toBeNull();
    });
  });

  describe('ContentType', () => {
    // The importer's media pass writes these: type='media', no url/sourceUrl at
    // all, the binary reachable only through external_id -> ci.files, which the
    // server resolves into galleryFileUrl + galleryPreviewUrl. Reading only
    // url/sourceUrl left 10,987 image rows as blank tiles.
    it('resolves a media row from the linked file, preferring the PREVIEW variant', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'ContentType',
          id: 'c-media',
          galleryMimetype: 'image/jpeg',
          galleryContentUrl: null,
          galleryContentSourceUrl: null,
          galleryFileUrl: '/files/IMGP0463.JPG',
          galleryPreviewUrl: '/files/IMGP0463-thumb.jpg',
          galleryTitle: 'IMGP0463.JPG',
        }),
      );

      expect(media).toEqual({
        entityId: 'c-media',
        kind: 'image',
        contentType: 'image/jpeg',
        thumbUrl: '/static/files/IMGP0463-thumb.jpg',
        fullUrl: '/static/files/IMGP0463.JPG',
        title: 'IMGP0463.JPG',
      });
    });

    it('falls back to the linked original when the file has no PREVIEW variant', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'ContentType',
          id: 'c-no-preview',
          galleryMimetype: 'image/jpeg',
          galleryFileUrl: '/files/no-preview.jpg',
          galleryPreviewUrl: null,
          galleryMediaSize: 512 * 1024,
        }),
      );

      expect(media?.thumbUrl).toBe('/static/files/no-preview.jpg');
      expect(media?.fullUrl).toBe('/static/files/no-preview.jpg');
    });

    // A web-content row (bookmark thumbnail, oEmbed image) still carries its
    // own url — the file hop must not shadow it.
    it('still resolves a content row that carries its own url', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'ContentType',
          id: 'c-web',
          galleryMimetype: 'image/png',
          galleryContentUrl: 'https://example.com/thumb.png',
          galleryFileUrl: null,
        }),
      );

      expect(media?.fullUrl).toBe('https://example.com/thumb.png');
    });

    it('resolves an image with thumb equal to full (no preview variant)', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'ContentType',
          id: 'c1',
          galleryMimetype: 'image/png',
          galleryContentUrl: '/content/x.png',
          galleryTitle: 'A picture',
        }),
      );

      expect(media).toEqual({
        entityId: 'c1',
        kind: 'image',
        contentType: 'image/png',
        thumbUrl: '/static/content/x.png',
        fullUrl: '/static/content/x.png',
        title: 'A picture',
      });
    });

    it('falls back to the content source URL when no content URL is set', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'ContentType',
          id: 'c2',
          galleryMimetype: 'video/webm',
          galleryContentSourceUrl: '/content/clip.webm',
        }),
      );

      expect(media?.fullUrl).toBe('/static/content/clip.webm');
      expect(media?.title).toBe('Untitled');
    });

    it('returns null when there is no media mimetype', () => {
      expect(getEntityMedia(entity({ __typename: 'ContentType', id: 'c3' }))).toBeNull();
    });

    // The YouTube ETL writes mimetype 'video/youtube' with a watch-page URL, so
    // classifying it as playable video rendered a permanently broken <video>.
    it.each(['video/youtube', 'video/vimeo', 'audio/spotify', 'audio/soundcloud'])(
      'returns null for the provider pseudo-mimetype %s',
      (mimetype) => {
        expect(
          getEntityMedia(
            entity({
              __typename: 'ContentType',
              id: 'c-provider',
              galleryMimetype: mimetype,
              galleryContentUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
              galleryTitle: 'A liked video',
            }),
          ),
        ).toBeNull();
      },
    );

    // With a server-derived player the same row becomes an embed tile: poster
    // (when the provider has one) in the grid, provider iframe in the lightbox.
    it('resolves a provider player to embed media, poster as the thumbnail', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'ContentType',
          id: 'c-yt',
          galleryMimetype: 'video/youtube',
          galleryContentUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          galleryTitle: 'A liked video',
          galleryPlayer: {
            provider: 'youtube',
            playerUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
            posterUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
            aspectRatio: 16 / 9,
            mediaKind: 'video',
          },
        }),
      );
      expect(media).toMatchObject({
        kind: 'embed',
        thumbUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        fullUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'A liked video',
        player: { provider: 'youtube', playerUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' },
      });
    });

    it('keeps a poster-less player (Spotify) as an embed with a null thumbnail', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'ContentType',
          id: 'c-sp',
          galleryMimetype: 'audio/mpeg',
          galleryContentUrl: 'https://open.spotify.com/track/3fzTpBMSQKjo9sW0T8Tw2O',
          galleryPlayer: {
            provider: 'spotify',
            playerUrl: 'https://open.spotify.com/embed/track/3fzTpBMSQKjo9sW0T8Tw2O',
            posterUrl: null,
            aspectRatio: 352 / 152,
            mediaKind: 'audio',
          },
        }),
      );
      expect(media?.kind).toBe('embed');
      expect(media?.thumbUrl).toBeNull();
      expect(media?.player?.provider).toBe('spotify');
    });

    it('uses the unfurl poster for a player that has none of its own (Spotify)', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'ContentType',
          id: 'c-sp-art',
          galleryMimetype: 'audio/spotify',
          galleryContentUrl: 'https://open.spotify.com/track/3fzTpBMSQKjo9sW0T8Tw2O',
          galleryPlayer: {
            provider: 'spotify',
            playerUrl: 'https://open.spotify.com/embed/track/3fzTpBMSQKjo9sW0T8Tw2O',
            posterUrl: null,
            aspectRatio: 352 / 152,
            mediaKind: 'audio',
          },
          galleryUnfurl: {
            status: 'ok',
            title: 'Stillness Speaks',
            thumbnailUrl: '/ci-files/poster?sig=1',
            canonicalUrl: null,
          },
        }),
      );
      expect(media?.kind).toBe('embed');
      expect(media?.thumbUrl).toBe('/static/ci-files/poster?sig=1');
      expect(media?.title).toBe('Stillness Speaks');
    });

    it('renders a title-only row with a resolved poster (Netflix via TMDB) as an image tile opening the provider page', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'ContentType',
          id: 'c-nf',
          galleryMimetype: 'text/plain',
          galleryTitle: 'Dark: Season 1: Alpha and Omega (Episode 10)',
          galleryUnfurl: {
            status: 'ok',
            title: 'Dark',
            thumbnailUrl: 'https://image.tmdb.org/t/p/w500/p.jpg',
            canonicalUrl: 'https://www.themoviedb.org/tv/70523',
          },
        }),
      );
      expect(media).toMatchObject({
        kind: 'image',
        thumbUrl: 'https://image.tmdb.org/t/p/w500/p.jpg',
        fullUrl: 'https://image.tmdb.org/t/p/w500/p.jpg',
        title: 'Dark: Season 1: Alpha and Omega (Episode 10)',
        pageUrl: 'https://www.themoviedb.org/tv/70523',
      });
    });

    it('renders a Prime Video row (video/mp4, no file, no URL) with a resolved poster as an image tile', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'ContentType',
          id: 'c-prime',
          galleryMimetype: 'video/mp4',
          galleryTitle: 'The Flame of Tar Valon-The Wheel of Time - Season 1',
          galleryUnfurl: {
            status: 'ok',
            title: 'The Wheel of Time',
            thumbnailUrl: '/ci-files/wot?sig=1',
            canonicalUrl: 'https://en.wikipedia.org/wiki/The_Wheel_of_Time_(TV_series)',
          },
        }),
      );
      expect(media).toMatchObject({
        kind: 'image',
        thumbUrl: '/static/ci-files/wot?sig=1',
        pageUrl: expect.stringContaining('wikipedia.org'),
      });
    });

    it('ignores a non-ok unfurl', () => {
      expect(
        getEntityMedia(
          entity({
            __typename: 'ContentType',
            id: 'c-nf-404',
            galleryMimetype: 'text/plain',
            galleryUnfurl: { status: 'not_found', title: null, thumbnailUrl: null, canonicalUrl: null },
          }),
        ),
      ).toBeNull();
    });

    it('is case-insensitive about provider pseudo-mimetypes', () => {
      expect(
        getEntityMedia(
          entity({
            __typename: 'ContentType',
            id: 'c-provider-upper',
            galleryMimetype: 'Video/YouTube',
            galleryContentUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          }),
        ),
      ).toBeNull();
    });

    // Guards the deny-list against over-reach: stripping playability from the
    // provider pseudo-types must not also strip it from a real container.
    it('still resolves genuine video containers', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'ContentType',
          id: 'c-real-video',
          galleryMimetype: 'video/mp4',
          galleryContentUrl: '/content/real.mp4',
        }),
      );

      expect(media?.kind).toBe('video');
    });
  });

  describe('EventType', () => {
    it('resolves a photo event from the gallery* media aliases, deriving a title from place + date', () => {
      const startTime = '2026-05-01T18:00:00Z';
      const media = getEntityMedia(
        entity({
          __typename: 'EventType',
          id: 'e1',
          galleryMediaContentType: 'image/jpeg',
          gallerySourceUrl: '/events/photo.jpg',
          galleryPreviewUrl: '/events/photo-thumb.jpg',
          galleryTitle: null,
          galleryLocationName: 'Golden Gate Park',
          bucketStartTime: startTime,
        }),
      );

      const expectedDate = new Date(startTime).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });

      expect(media).toEqual({
        entityId: 'e1',
        kind: 'image',
        contentType: 'image/jpeg',
        thumbUrl: '/static/events/photo-thumb.jpg',
        fullUrl: '/static/events/photo.jpg',
        title: `Photo · Golden Gate Park · ${expectedDate}`,
      });
    });

    it('resolves a video event and keeps an authored title as-is', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'EventType',
          id: 'e2',
          galleryMediaContentType: 'video/mp4',
          gallerySourceUrl: '/events/clip.mp4',
          galleryTitle: 'Birthday party clip',
        }),
      );

      expect(media?.kind).toBe('video');
      expect(media?.title).toBe('Birthday party clip');
    });

    // An HEVC original carries the server's H.264 rendition beside it: the
    // lightbox plays that, and the original stays the download (fullUrl).
    it('keeps the original as fullUrl and carries the playback rendition for a video', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'EventType',
          id: 'e-hevc',
          galleryMediaContentType: 'video/quicktime',
          gallerySourceUrl: '/events/clip.mov',
          galleryPlaybackUrl: '/events/clip-h264.mp4',
          galleryTitle: 'HEVC clip',
        }),
      );

      expect(media?.fullUrl).toBe('/static/events/clip.mov');
      expect(media?.playbackUrl).toBe('/static/events/clip-h264.mp4');
    });

    it('does not put a playback key on a photo', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'EventType',
          id: 'e-photo',
          galleryMediaContentType: 'image/jpeg',
          gallerySourceUrl: '/events/photo.jpg',
          galleryPlaybackUrl: null,
        }),
      );

      expect(media).not.toHaveProperty('playbackUrl');
    });

    // No previewUrl (no derived thumbnail variant yet) — the tile must still
    // render something rather than an empty thumbUrl.
    it('falls back the thumbnail to the full-resolution source when there is no preview', () => {
      const media = getEntityMedia(
        entity({
          __typename: 'EventType',
          id: 'e3',
          galleryMediaContentType: 'image/png',
          gallerySourceUrl: '/events/no-preview.png',
          galleryPreviewUrl: null,
        }),
      );

      expect(media?.thumbUrl).toBe('/static/events/no-preview.png');
      expect(media?.thumbUrl).toBe(media?.fullUrl);
    });

    // The exact shape a photo/video event has when it has no linked content
    // row: mediaContentType resolves to null server-side, so the tile must stay
    // a plain text tile instead of an <img>/<video> pointed at nothing.
    it('returns null for a non-media event with no linked content row', () => {
      expect(
        getEntityMedia(
          entity({
            __typename: 'EventType',
            id: 'e4',
            galleryMediaContentType: null,
            galleryTitle: 'Visited the office',
          }),
        ),
      ).toBeNull();
    });

    it('returns null when a media content type is present but neither URL resolves', () => {
      expect(
        getEntityMedia(
          entity({
            __typename: 'EventType',
            id: 'e5',
            galleryMediaContentType: 'image/png',
            gallerySourceUrl: null,
            galleryPreviewUrl: null,
          }),
        ),
      ).toBeNull();
    });

    it('returns null for the provider pseudo-mimetype case, same as the other branches', () => {
      expect(
        getEntityMedia(
          entity({
            __typename: 'EventType',
            id: 'e6',
            galleryMediaContentType: 'video/youtube',
            gallerySourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          }),
        ),
      ).toBeNull();
    });
  });

  it('returns null for entity types without media', () => {
    expect(getEntityMedia(entity({ __typename: 'PersonType', id: 'p1' }))).toBeNull();
  });
});

describe('pickThumbUrl', () => {
  const full = 'https://cdn.example.com/original.jpg';

  it('always prefers the PREVIEW variant', () => {
    expect(pickThumbUrl({ kind: 'image', previewUrl: '/preview.jpg', fullUrl: full, sizeBytes: 1e9 })).toBe(
      '/preview.jpg',
    );
  });

  it('uses the original for a preview-less image of workable size', () => {
    expect(pickThumbUrl({ kind: 'image', previewUrl: null, fullUrl: full, sizeBytes: 1024 })).toBe(full);
  });

  it('uses the original when the size is unknown', () => {
    expect(pickThumbUrl({ kind: 'image', previewUrl: null, fullUrl: full, sizeBytes: null })).toBe(full);
  });

  /**
   * The threshold is a measurement, not a taste — pin the value so a future
   * edit cannot quietly make it a no-op again. On the QA appliance the 7,309
   * preview-less image originals run p50 575 kB / p90 2.7 MB / max 8.8 MB, so
   * an 8 MB cap excluded SEVEN of them (0.1% of files, 0.4% of bytes). At 2 MB
   * it excludes 18% of the files and 52.5% of the bytes.
   */
  it('caps at the measured 2 MB, not a value that excludes nothing', () => {
    expect(MAX_UNPREVIEWED_THUMB_BYTES).toBe(2 * 1024 * 1024);
    // p90 of the preview-less distribution — above the cap, so it is declined.
    expect(
      pickThumbUrl({ kind: 'image', previewUrl: null, fullUrl: full, sizeBytes: 2_703 * 1024 }),
    ).toBeNull();
    // p50 — still rendered, which is why the cap does not stop here.
    expect(pickThumbUrl({ kind: 'image', previewUrl: null, fullUrl: full, sizeBytes: 575 * 1024 })).toBe(
      full,
    );
  });

  // The largest original in a real corpus here is ~2 GB (a video); the browser
  // would download all of it to paint a 240px tile.
  it('declines an oversized original as a thumbnail', () => {
    expect(
      pickThumbUrl({
        kind: 'image',
        previewUrl: null,
        fullUrl: full,
        sizeBytes: MAX_UNPREVIEWED_THUMB_BYTES + 1,
      }),
    ).toBeNull();
    expect(
      pickThumbUrl({
        kind: 'image',
        previewUrl: null,
        fullUrl: full,
        sizeBytes: MAX_UNPREVIEWED_THUMB_BYTES,
      }),
    ).toBe(full);
  });

  it('never hands a video source to the tile image', () => {
    expect(
      pickThumbUrl({ kind: 'video', previewUrl: null, fullUrl: '/clip.mp4', sizeBytes: 1024 }),
    ).toBeNull();
    expect(
      pickThumbUrl({ kind: 'video', previewUrl: '/clip-thumb.jpg', fullUrl: '/clip.mp4', sizeBytes: null }),
    ).toBe('/clip-thumb.jpg');
  });
});
