/**
 * The response headers a signed `/static/` link asks the object store to send.
 *
 * Stored files are served from the app's own origin, and the type on the row is
 * whatever the uploader, an email attachment or a synced Drive file declared. A
 * file served inline as `text/html` or `image/svg+xml` is a page on the
 * appliance origin, so only types a browser shows without running anything are
 * opened inline. Everything else is signed as an attachment, which the browser
 * downloads instead of rendering.
 *
 * `<img>`, `<video>` and `<audio>` ignore `Content-Disposition`, so an
 * attachment still previews wherever the app puts it in one of those tags. SVG
 * keeps its own type for that reason: an `<img>` will not draw SVG served as
 * `application/octet-stream`, while opening the link still only downloads it.
 * Anything else that is not inline-safe goes out as `application/octet-stream`.
 *
 * The gateway keys its `/static/` sandbox off the `response-content-type` this
 * returns (`infrastructure/gateway/nginx.conf`), so a PDF is signed with the bare
 * `application/pdf` and nothing after it.
 */

const INLINE_IMAGE_TYPES = new Set([
  'image/apng',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/tiff',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon',
  'image/x-ms-bmp',
]);

const INLINE_DOCUMENT_TYPES = new Set(['application/pdf', 'text/plain']);

const SVG_TYPE = 'image/svg+xml';

const DOWNLOAD_TYPE = 'application/octet-stream';

/** A charset name, and nothing that could carry another parameter or header. */
const CHARSET_TOKEN = /^[A-Za-z0-9._-]{1,40}$/;

export interface DownloadResponseOverrides {
  ResponseContentType: string;
  ResponseContentDisposition?: string;
}

/** `type/subtype` in lower case, without parameters. */
function essenceOf(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

function charsetOf(contentType: string): string | null {
  const match = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(contentType);
  const value = (match?.[1] ?? match?.[2] ?? '').trim();

  return CHARSET_TOKEN.test(value) ? value : null;
}

/** Types a browser displays inline without running script or rendering markup. */
export function isInlineSafeContentType(contentType: string | null | undefined): boolean {
  const essence = essenceOf(contentType ?? '');

  return (
    INLINE_IMAGE_TYPES.has(essence) ||
    INLINE_DOCUMENT_TYPES.has(essence) ||
    /^(audio|video)\/[a-z0-9][a-z0-9.+-]*$/.test(essence)
  );
}

/**
 * `attachment`, with the stored filename when there is one: without a name the
 * browser saves the object key, a bare UUID with no extension.
 *
 * The quoted `filename` is an ASCII fallback with quotes, backslashes and
 * control or non-ASCII characters replaced; `filename*` carries the real name
 * (RFC 6266, RFC 5987).
 */
export function attachmentDisposition(filename: string | null | undefined): string {
  const name = (filename ?? '').trim().slice(0, 200);

  if (!name) {
    return 'attachment';
  }

  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function downloadResponseOverrides(
  contentType: string | null | undefined,
  filename: string | null | undefined,
): DownloadResponseOverrides {
  const essence = essenceOf(contentType ?? '');

  if (isInlineSafeContentType(essence)) {
    const charset = essence === 'text/plain' ? charsetOf(contentType ?? '') : null;

    return { ResponseContentType: charset ? `${essence}; charset=${charset}` : essence };
  }

  return {
    ResponseContentType: essence === SVG_TYPE ? SVG_TYPE : DOWNLOAD_TYPE,
    ResponseContentDisposition: attachmentDisposition(filename),
  };
}
