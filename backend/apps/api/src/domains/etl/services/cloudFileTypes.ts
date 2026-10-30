/**
 * Which cloud-drive files get their BYTES fetched, shared by every provider's
 * transform so "a document" means the same thing in Drive and in Dropbox.
 */

/** Uploaded zips are reported under several types, and sometimes only the name says so. */
export function isZipArchive(mimeType: string | null | undefined, fileName: string): boolean {
  return (
    (mimeType != null &&
      ['application/zip', 'application/x-zip-compressed', 'application/x-zip'].includes(mimeType)) ||
    /\.zip$/i.test(fileName)
  );
}

/**
 * Document formats whose real content the import pipeline can read once it has
 * the bytes. (Drive's native Docs/Sheets/Slides are not here: they have no
 * bytes to download, only an export, and Drive's transform handles them.)
 */
const DOWNLOADABLE_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/html',
  'text/markdown',
]);

export function isDownloadableDocumentType(mimeType: string | null | undefined): boolean {
  return mimeType != null && DOWNLOADABLE_DOCUMENT_TYPES.has(mimeType);
}

/**
 * A photo or a video: something the import pipeline stores, reads EXIF from,
 * thumbnails and describes. Audio is left out on purpose — the request this
 * exists for was photos and videos, and a drive's audio is as likely to be a
 * music collection as something the person recorded.
 */
export function isPhotoOrVideoType(mimeType: string | null | undefined): boolean {
  return mimeType != null && /^(image|video)\//.test(mimeType);
}
