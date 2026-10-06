import { buildApiUrl } from '@ci/common';

/**
 * Resolve a media path for the Memory UI.
 * Absolute http(s) URLs, and inline `data:` / `blob:` images (a vCard's embedded
 * contact photo), are used as-is; relative object-store keys are served under
 * `/static` (same contract as Gallery `getEntityMedia` / FileDetails).
 *
 * This is the ONE place that prefix is applied — every tile, drawer, avatar,
 * lightbox and download link goes through it — because the prefix alone is not
 * a loadable URL on the native shells. Capacitor serves the bundle from
 * `capacitor://localhost` (iOS) / `https://localhost` (Android), so a bare
 * `/static/...` resolves against the WebView itself: thumbnails and avatars
 * stayed broken-image placeholders, the drawer said "Media couldn't be loaded",
 * and Download navigated the whole WebView to the app's own 404 page.
 * `buildApiUrl` adds the Memory origin the phone is paired with; on web that
 * origin is `''`, so the URL stays a same-origin path and nothing changes.
 */
export function resolveMediaUrl(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  return /^(?:https?:\/\/|data:|blob:)/i.test(value) ? value : buildApiUrl(`/static${value}`);
}

/**
 * Is this URL served by the app itself (the `/static` object store)?
 *
 * The `download` attribute is silently ignored for cross-origin URLs — the
 * browser navigates to the file instead of saving it. So a real "Download" is
 * only offered for same-origin media; an external source gets "Open original".
 */
export function isSameOriginUrl(url: string): boolean {
  try {
    return new URL(url, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * HEIC/HEIF is what the iPhone camera writes. WKWebView and most desktop
 * browsers cannot decode those bytes in an `<img>`, so the JPEG preview is
 * the picture. Falling back to the original shows a broken tile.
 */
export function imageNeedsJpegPreview(contentType?: string | null): boolean {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();

  return (
    type === 'image/heic' ||
    type === 'image/heif' ||
    type.startsWith('image/heic-') ||
    type.startsWith('image/heif-')
  );
}

/**
 * Tile/row thumbnail for a FileType: prefer the derived preview, then the
 * original source for images — so a Capture screenshot renders before
 * preview generation finishes.
 *
 * A preview-less VIDEO gets no thumbnail, matching the gallery's
 * `pickThumbUrl`: every caller puts this URL in an `<img>`, and an `<img>`
 * pointed at an .mp4 never decodes — the tile downloaded the whole file and
 * then showed the browser's broken-image glyph (or a black box) anyway.
 * The placeholder icon is the honest state; the `enrich.file_preview` sweep
 * is what fills it in.
 */
export function resolveFileTileUrl(opts: {
  contentType?: string | null;
  previewUrl?: string | null;
  sourceUrl?: string | null;
}): string | undefined {
  const preview = resolveMediaUrl(opts.previewUrl);
  if (preview) {
    return preview;
  }

  if ((opts.contentType ?? '').startsWith('image/') && !imageNeedsJpegPreview(opts.contentType)) {
    return resolveMediaUrl(opts.sourceUrl);
  }

  return undefined;
}

/**
 * Thumbnail for a content row. `previewUrl`/`mediaUrl` are hydrated server-side
 * from the linked file (external_id -> ci.files) when there is one; rows that
 * point at an image by url/sourceUrl (bookmarked images, imported photos
 * without a local copy) fall back to that. A row with neither — a Spotify
 * track, a YouTube video, anything with `mimetype` outside `image/*` — falls
 * back to the resolved link preview: the `enrich.unfurl` stage's cached poster
 * (`unfurlThumbnailUrl`), then the tier-0 embed's templated poster
 * (`playerPosterUrl`, e.g. YouTube's `hqdefault.jpg`; Spotify has none).
 */
export function resolveContentTileUrl(data: {
  mimetype?: string | null;
  previewUrl?: string | null;
  mediaUrl?: string | null;
  contentUrl?: string | null;
  sourceUrl?: string | null;
  unfurlThumbnailUrl?: string | null;
  playerPosterUrl?: string | null;
}): string | undefined {
  const preview = resolveMediaUrl(data.previewUrl);

  if (preview) {
    return preview;
  }

  if (data.mimetype?.startsWith('image/')) {
    return resolveMediaUrl(data.mediaUrl ?? data.contentUrl ?? data.sourceUrl);
  }

  return resolveMediaUrl(data.unfurlThumbnailUrl) ?? resolveMediaUrl(data.playerPosterUrl) ?? undefined;
}
