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

/** A high surrogate with no low one after it, or a low one with no high one before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

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

const MAX_NAME_LENGTH = 200;

/** The longest extension kept whole when a name is shortened, dot included. */
const MAX_EXTENSION_LENGTH = 16;

function shortenName(name: string): string {
  const chars = Array.from(name);

  if (chars.length <= MAX_NAME_LENGTH) {
    return name;
  }

  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? Array.from(name.slice(dot)) : [];

  if (extension.length < 2 || extension.length > MAX_EXTENSION_LENGTH) {
    return chars.slice(0, MAX_NAME_LENGTH).join('');
  }

  return chars.slice(0, MAX_NAME_LENGTH - extension.length).join('') + extension.join('');
}

/**
 * `attachment`, with the stored filename when there is one: without a name the
 * browser saves the object key, a bare UUID with no extension.
 *
 * The quoted `filename` is an ASCII fallback with quotes, backslashes and
 * control or non-ASCII characters replaced; `filename*` carries the real name
 * (RFC 6266, RFC 5987).
 *
 * A name longer than 200 code points loses the end of its stem, not its
 * extension, so the saved file still opens. The cut counts code points, not
 * UTF-16 units, and any unpaired surrogate becomes U+FFFD first:
 * `encodeURIComponent` throws on a lone surrogate, and one throw here fails
 * every file on the page being signed.
 */
export function attachmentDisposition(filename: string | null | undefined): string {
  const name = shortenName((filename ?? '').trim().replace(LONE_SURROGATE, '\uFFFD'));

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
