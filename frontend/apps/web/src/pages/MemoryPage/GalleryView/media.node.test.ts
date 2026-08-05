import { describe, expect, it } from 'vitest';

import type { EntityItem } from '../useEntityService';

import { getEntityMedia } from './media';

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
      // No preview → thumb falls back to the full URL.
      expect(media?.thumbUrl).toBe('https://cdn.example.com/v.mp4');
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

  it('returns null for entity types without media', () => {
    expect(getEntityMedia(entity({ __typename: 'PersonType', id: 'p1' }))).toBeNull();
  });
});
