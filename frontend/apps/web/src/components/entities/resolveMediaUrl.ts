/**
 * Resolve a media path for the Memory UI.
 * Absolute http(s) URLs are used as-is; relative object-store keys are served
 * under `/static` (same contract as Gallery `getEntityMedia` / FileDetails).
 */
export function resolveMediaUrl(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  return /^https?:\/\//.test(value) ? value : `/static${value}`;
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

  if ((opts.contentType ?? '').startsWith('image/')) {
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
