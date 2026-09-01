/* Extract in-memory email attachments to their own on-disk files.
 *
 * Attachment items used to carry `intermediateLocation: <the mbox path>` — the
 * only on-disk location the parser knew. But intermediateLocation is what the
 * media-retention pass copies (persistence.ts retainMediaFile) and what the
 * push uploads (mapping.ts mediaPath → graphql.ts syncEventMedia), so every
 * media attachment caused the ENTIRE multi-GB container to be copied/uploaded
 * once per attachment (observed live: 18 synchronous copies of a 5.3 GB mbox =
 * 95 GB in 18 minutes, event loop blocked, import frozen).
 *
 * The fix: the parsed attachment's bytes are already in memory (MIME decode),
 * so write them to their own file under a sibling `.attachments/` dir next to
 * the container. That keeps the bytes under the same inbox root as the mbox —
 * retention still copies them into the durable store, and inbox cleanup
 * reclaims the extracted copies — while staying invisible to the import
 * scanner (every walker skips dot-directories).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Sibling dir (next to the container file) that holds extracted attachments. */
export const ATTACHMENTS_DIRNAME = '.attachments';

/**
 * Strip path separators / control chars and clip length so an RFC-2047 monster
 * or a `../../evil` filename can't escape the extraction dir. Clips from the
 * front so the extension survives.
 *
 * `.` and `..` are rejected outright rather than passed through. `basename`
 * leaves them intact — `path.basename('../../x/..')` is `'..'` — and none of
 * the characters below touch them, so the sanitizer's one job silently failed
 * for exactly the two names that are not filenames at all: joined onto an
 * extraction directory they name that directory itself, or its PARENT. As a
 * filename the write then fails with EISDIR rather than escaping, but callers
 * that use this for a DIRECTORY component (the BlueBubbles attachment store)
 * get a real escape from it.
 */
export function sanitizeAttachmentFilename(name: string | undefined): string {
  const base = path
    .basename(name ?? '')
    // Stripping control characters out of an archive-supplied filename is the
    // entire point of this call.
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/\u0000-\u001F<>:"|?*]/g, '_')
    .trim();
  const clipped = base.length > 128 ? base.slice(-128) : base;

  return clipped === '.' || clipped === '..' ? 'attachment' : clipped || 'attachment';
}

/**
 * The MediaAttachments descriptor `type` for an attachment MIME: a real media
 * kind when it is one, else the honest 'file' (a PDF is not "media").
 */
export function attachmentMediaKind(mediaType: string | undefined): 'image' | 'video' | 'audio' | 'file' {
  if (mediaType?.startsWith('image/')) {
    return 'image';
  }

  if (mediaType?.startsWith('video/')) {
    return 'video';
  }

  if (mediaType?.startsWith('audio/')) {
    return 'audio';
  }

  return 'file';
}

export type ExtractLogger = (
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  meta?: Record<string, unknown>,
) => void;

/**
 * Write one parsed attachment's bytes to
 *   `<containerDir>/.attachments/<sha1(content)>/<sanitized filename>`
 * and return that path. Returns undefined when there is nothing to write
 * (absent or zero-byte data) or the write fails — the item then simply carries
 * no intermediateLocation, so retention and push skip it instead of falling
 * back to the container path.
 *
 * Content-addressed by sha1 of the bytes: a re-parse of the same mbox (or the
 * same attachment appearing in several messages) reuses the existing file
 * instead of re-writing it. The hash is the DIRECTORY key — the basename stays
 * the plain sanitized filename, which is what persistence.hashablePath requires
 * (basename === content.filename) to compute the row's sha256 content digest.
 */
export function extractAttachmentToFile(
  containerPath: string,
  att: { filename?: string; data?: Buffer },
  log?: ExtractLogger,
): string | undefined {
  const data = att.data;
  if (!data || data.length === 0) {
    return undefined;
  }

  const name = sanitizeAttachmentFilename(att.filename);
  const key = crypto.createHash('sha1').update(data).digest('hex');
  const dir = path.join(path.dirname(containerPath), ATTACHMENTS_DIRNAME, key);
  const dest = path.join(dir, name);
  try {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dest, data);
    }

    return dest;
  } catch (e) {
    log?.('warn', 'attachment extract failed', {
      container: path.basename(containerPath),
      filename: name,
      error: (e as Error).message,
    });

    return undefined;
  }
}
