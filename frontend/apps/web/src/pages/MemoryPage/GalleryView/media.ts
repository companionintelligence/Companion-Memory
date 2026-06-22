import type { EntityItem } from '../useEntityService';

export type EntityMediaKind = 'image' | 'video';

/**
 * A resolved, renderable piece of media derived from an entity. Generalises
 * FileModal's `previewUrl`/`contentType` approach so the gallery can show real
 * thumbnails and a lightbox for any media-bearing type, not just files.
 */
export interface EntityMedia {
  entityId: string;
  kind: EntityMediaKind;
  contentType: string;
  /** Thumbnail URL for the grid tile (may equal `fullUrl`). */
  thumbUrl: string;
  /** Full-resolution URL for the lightbox. */
  fullUrl: string;
  /** Human label for caption / alt text. */
  title: string;
}

// External URLs are used directly; relative paths are served from the object
// store under /static (mirrors ContentGridItem and FileModal).
function resolveMediaUrl(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  return /^https?:\/\//.test(value) ? value : `/static${value}`;
}

function mediaKind(contentType?: string | null): EntityMediaKind | null {
  if (!contentType) {
    return null;
  }

  if (contentType.startsWith('image/')) {
    return 'image';
  }

  if (contentType.startsWith('video/')) {
    return 'video';
  }

  return null;
}

/**
 * Extracts displayable media from an entity, or `null` when it has none — in
 * which case the gallery keeps it as a plain text tile. Add a case here to make
 * a new entity type media-aware.
 */
export function getEntityMedia(entity: EntityItem): EntityMedia | null {
  switch (entity.__typename) {
    case 'FileType': {
      const kind = mediaKind(entity.galleryContentType);
      if (!kind) {
        return null;
      }

      const full = resolveMediaUrl(entity.gallerySourceUrl) ?? resolveMediaUrl(entity.galleryPreviewUrl);
      if (!full) {
        return null;
      }

      return {
        entityId: entity.id,
        kind,
        contentType: entity.galleryContentType,
        thumbUrl: resolveMediaUrl(entity.galleryPreviewUrl) ?? full,
        fullUrl: full,
        title: entity.galleryFilename ?? 'Untitled',
      };
    }

    case 'ContentType': {
      const contentType = entity.galleryMimetype;
      const kind = mediaKind(contentType);
      if (!kind || !contentType) {
        return null;
      }

      const url =
        resolveMediaUrl(entity.galleryContentUrl) ?? resolveMediaUrl(entity.galleryContentSourceUrl);
      if (!url) {
        return null;
      }

      return {
        entityId: entity.id,
        kind,
        contentType,
        // ContentType exposes no resized/preview variant (unlike FileType's
        // previewUrl), so the grid thumbnail reuses the full-resolution source.
        // MediaTile lazy-loads, decodes async, and constrains it to the tile box
        // to limit the cost; swap in a derived preview here if one is ever added.
        thumbUrl: url,
        fullUrl: url,
        title: entity.galleryTitle ?? 'Untitled',
      };
    }

    default:
      return null;
  }
}
