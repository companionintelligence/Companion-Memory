/**
 * The file extensions that make an event title a photo or video file name, as
 * regex alternations (no anchors, no flags).
 *
 * Indexing (`eventDisplayTitle` / `eventWeightedTexts` in search-ingress) and the
 * photo-ask filter (`mediaEventSql` in search-next) must agree on which events
 * are photos: one decides which events carry capture-date words, the other
 * which events a photo ask may match on them. Both build their test from these.
 */
export const IMAGE_FILE_EXTENSIONS = 'jpe?g|png|gif|webp|heic|heif|tiff?|bmp|dng|raw|cr2|nef';

export const VIDEO_FILE_EXTENSIONS = 'mp4|mov|m4v|avi|mkv|webm|3gp|mpe?g|wmv';
