import { resolveMediaUrl } from '@/components/entities/resolveMediaUrl';

import { eventDisplayTitle } from '../Components/utils';
import type { EntityItem } from '../useEntityService';

export type EntityMediaKind = 'image' | 'video' | 'embed';

/**
 * A provider-hosted player (YouTube, Spotify, …) derived server-side from the
 * content row's URL. The gallery never mounts it on its own: the tile shows
 * `posterUrl` (or a provider badge) and the iframe loads only inside the
 * lightbox, after an explicit click.
 */
export interface EmbedPlayer {
  provider: string;
  playerUrl: string;
  posterUrl: string | null;
  aspectRatio: number;
  mediaKind: string;
}

/**
 * A resolved, renderable piece of media derived from an entity. Generalises
 * FileModal's `previewUrl`/`contentType` approach so the gallery can show real
 * thumbnails and a lightbox for any media-bearing type, not just files.
 */
export interface EntityMedia {
  entityId: string;
  kind: EntityMediaKind;
  contentType: string;
  /**
   * URL to render in the grid tile, or `null` when nothing cheap enough to be a
   * thumbnail exists — see {@link pickThumbUrl}. A null here means "draw the
   * placeholder tile", not "this entity has no media": `fullUrl` still opens.
   */
  thumbUrl: string | null;
  /** Full-resolution URL for the lightbox — and, for a file, its download. */
  fullUrl: string;
  /**
   * For `kind === 'video'` only: the server's browser-playable H.264 rendition
   * (the PLAYBACK variant) when the original's codec needs one. The lightbox
   * plays this and keeps `fullUrl` as the original to download.
   */
  playbackUrl?: string | null;
  /** Human label for caption / alt text. */
  title: string;
  /** Present only for `kind === 'embed'`; `fullUrl` is then the provider page. */
  player?: EmbedPlayer;
  /**
   * The page the media stands for, when `fullUrl` is only a poster of it (a
   * TMDB poster for a Netflix episode): the lightbox's "open original" target.
   */
  pageUrl?: string | null;
}

/**
 * Above this, a full-resolution original is never used as a grid thumbnail.
 *
 * ── The threshold is measured, not guessed ─────────────────────────────────
 * 7,309 of the 10,472 image originals on the QA appliance (70%) still have no
 * PREVIEW variant, so the grid downloads the original and lets the browser
 * downscale it into a ~240px tile. Their size distribution:
 *
 *   p25 171 kB   p50 575 kB   p75 1.7 MB   p90 2.7 MB   p99 4.9 MB   max 8.8 MB
 *   mean 1,077 kB   total 7,687 MB
 *
 * An earlier revision of this file capped at 8 MB, which reads generous but is
 * measurably a no-op: it excludes SEVEN of those 7,309 files (0.1%) and 0.4% of
 * their bytes. 2 MB is the point where the cap starts paying: it excludes 18.0%
 * of the files and 52.5% of the bytes, taking the mean tile from 1,077 kB to
 * 624 kB. A page of 30 preview-less tiles drops from ~31 MB to ~15 MB while 82%
 * of them still show the actual photograph.
 *
 * Going lower buys less than it costs — the next stop, 1 MB, adds only another
 * 28% of bytes but blanks 37% of the grid — so this is where it stops.
 *
 * ── This is a bound, not a fix ─────────────────────────────────────────────
 * The real fix is generating the 7,309 missing PREVIEW variants (a 300px JPEG
 * each, via FilePreviewGenerationListener, which only ever runs on upload and
 * has no backfill path). Until that exists the grid is still serving
 * full-resolution originals as thumbnails for 82% of preview-less images; this
 * constant only stops the heavy tail. Files above it draw the placeholder and
 * fetch their bytes when the lightbox opens.
 */
export const MAX_UNPREVIEWED_THUMB_BYTES = 2 * 1024 * 1024;

/**
 * Choose what the grid tile should load: the PREVIEW variant whenever one
 * exists, otherwise the original — but only for an image small enough to be
 * worth it.
 *
 * A preview-less *video* never falls back to its source: handing an `<img>` a
 * video URL always fails to decode, which cost a wasted full-file download
 * before the tile fell through to its error placeholder anyway.
 */
export function pickThumbUrl(input: {
  kind: EntityMediaKind;
  previewUrl: string | null | undefined;
  fullUrl: string;
  sizeBytes: number | null | undefined;
}): string | null {
  if (input.previewUrl) {
    return input.previewUrl;
  }

  if (input.kind === 'video') {
    return null;
  }

  if (input.sizeBytes != null && input.sizeBytes > MAX_UNPREVIEWED_THUMB_BYTES) {
    return null;
  }

  return input.fullUrl;
}

/**
 * Mimetypes whose subtype names a *provider*, not a container or codec. The ETL
 * writes these alongside a watch-page URL rather than a media file, so treating
 * them as playable renders an `<img>`/`<video>` pointed at an HTML page — always
 * broken. They resolve to no media here; rows whose URL the server can turn
 * into a provider player arrive with `galleryPlayer` set and take the `embed`
 * branch in {@link getEntityMedia} instead (tier 0 of
 * `docs/prd/unified-content-identity-lifecycle-embeds.md` §6). Anything else
 * stays a plain tile.
 */
const PROVIDER_PSEUDO_MIMETYPES = new Set([
  'video/youtube',
  'video/vimeo',
  'audio/spotify',
  'audio/soundcloud',
]);

function mediaKind(contentType?: string | null): EntityMediaKind | null {
  if (!contentType) {
    return null;
  }

  if (PROVIDER_PSEUDO_MIMETYPES.has(contentType.toLowerCase())) {
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

      const preview = resolveMediaUrl(entity.galleryPreviewUrl);
      const full = resolveMediaUrl(entity.gallerySourceUrl) ?? preview;
      if (!full) {
        return null;
      }

      return {
        entityId: entity.id,
        kind,
        contentType: entity.galleryContentType,
        thumbUrl: pickThumbUrl({
          kind,
          previewUrl: preview,
          fullUrl: full,
          sizeBytes: entity.galleryMediaSize ?? null,
        }),
        fullUrl: full,
        ...(kind === 'video' ? { playbackUrl: resolveMediaUrl(entity.galleryPlaybackUrl) } : {}),
        title: entity.galleryFilename ?? 'Untitled',
      };
    }

    case 'EventType': {
      // Photo/video events link to a file whose PREVIEW variant is the
      // thumbnail and ORIGINAL is the full-res source (resolved server-side via
      // the gallery* aliases). Non-media events resolve no content type here and
      // keep their plain text tile.
      const contentType = entity.galleryMediaContentType;
      const kind = mediaKind(contentType);
      if (!kind || !contentType) {
        return null;
      }

      const preview = resolveMediaUrl(entity.galleryPreviewUrl);
      const full = resolveMediaUrl(entity.gallerySourceUrl) ?? preview;
      if (!full) {
        return null;
      }

      return {
        entityId: entity.id,
        kind,
        contentType,
        thumbUrl: pickThumbUrl({
          kind,
          previewUrl: preview,
          fullUrl: full,
          sizeBytes: entity.galleryMediaSize ?? null,
        }),
        fullUrl: full,
        ...(kind === 'video' ? { playbackUrl: resolveMediaUrl(entity.galleryPlaybackUrl) } : {}),
        title: eventDisplayTitle({
          title: entity.galleryTitle,
          startTime: (entity.bucketStartTime as string | Date | null) ?? undefined,
          locationName: entity.galleryLocationName,
          mediaContentType: contentType,
        }),
      };
    }

    case 'ContentType': {
      const contentType = entity.galleryMimetype;

      // A resolved link preview, when the unfurl stage has visited the row.
      // Only an `ok` one carries anything renderable.
      const unfurl = entity.galleryUnfurl?.status === 'ok' ? entity.galleryUnfurl : null;
      const unfurlPoster = resolveMediaUrl(unfurl?.thumbnailUrl);

      // A provider player wins over whatever the mimetype says: the row for a
      // Spotify track is `audio/spotify` (a provider, not a codec), and the
      // only thing that can render it is the provider's own player.
      const player = entity.galleryPlayer;
      if (player) {
        const page = entity.galleryContentUrl ?? entity.galleryContentSourceUrl ?? player.playerUrl;

        return {
          entityId: entity.id,
          kind: 'embed',
          contentType: contentType ?? `${player.mediaKind}/${player.provider}`,
          // Tier-0 poster (YouTube) first; the unfurl's (Spotify album art) fills the gap.
          thumbUrl: player.posterUrl ?? unfurlPoster ?? null,
          fullUrl: page,
          title: entity.galleryTitle ?? unfurl?.title ?? 'Untitled',
          player: {
            provider: player.provider,
            playerUrl: player.playerUrl,
            posterUrl: player.posterUrl ?? null,
            aspectRatio: player.aspectRatio,
            mediaKind: player.mediaKind,
          },
        };
      }

      // A media content row is a link, not a document: `url`/`sourceUrl` are
      // NULL on every one of them and the binary hangs off
      // `external_id -> ci.files`, which the server resolves into
      // galleryFileUrl (ORIGINAL) + galleryPreviewUrl (PREVIEW variant). Reading
      // only the first two is what left these tiles blank. Web content (a
      // bookmarked image, an oEmbed thumbnail) still arrives via url/sourceUrl,
      // so both sources are kept.
      const kind = mediaKind(contentType);
      const preview = resolveMediaUrl(entity.galleryPreviewUrl);
      const url =
        resolveMediaUrl(entity.galleryFileUrl) ??
        resolveMediaUrl(entity.galleryContentUrl) ??
        resolveMediaUrl(entity.galleryContentSourceUrl) ??
        preview;

      if (kind && contentType && url) {
        return {
          entityId: entity.id,
          kind,
          contentType,
          thumbUrl: pickThumbUrl({
            kind,
            previewUrl: preview,
            fullUrl: url,
            sizeBytes: entity.galleryMediaSize ?? null,
          }),
          fullUrl: url,
          ...(kind === 'video' ? { playbackUrl: resolveMediaUrl(entity.galleryPlaybackUrl) } : {}),
          title: entity.galleryTitle ?? 'Untitled',
        };
      }

      // Nothing playable, but a poster was resolved — a Netflix episode
      // (text/plain, no URL) or a Prime Video watch (video/mp4 with no file
      // behind it) via Wikidata, a bookmarked article's og:image: an image
      // tile that opens the poster, with "open original" pointing at the page.
      if (unfurlPoster) {
        return {
          entityId: entity.id,
          kind: 'image',
          contentType: 'image/*',
          thumbUrl: unfurlPoster,
          fullUrl: unfurlPoster,
          title: entity.galleryTitle ?? unfurl?.title ?? 'Untitled',
          pageUrl: entity.galleryContentUrl ?? unfurl?.canonicalUrl ?? null,
        };
      }

      return null;
    }

    default:
      return null;
  }
}
