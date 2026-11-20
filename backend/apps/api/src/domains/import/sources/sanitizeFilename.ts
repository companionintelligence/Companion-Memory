/**
 * Reduce an uploaded filename to something safe to use as a real filesystem
 * name under the uploads staging directory: no path separators (a `../` in
 * the name would otherwise escape the upload's own directory), no control
 * characters, and bounded length. The name is attacker-controlled text — a
 * browser sends whatever it likes as `originalname` — landing on a disk the
 * importer later moves and deletes from, so this is containment, not
 * cosmetics.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f]/g, '').replace(/[^A-Za-z0-9._-]/g, '_');
  const trimmed = cleaned.replace(/^\.+/, '').slice(0, 180);

  return trimmed.length > 0 ? trimmed : 'upload.zip';
}

// What Windows refuses in a name, beside the separators. The uploads tree can
// sit on a host folder, so these go even though Linux would take them.
const WINDOWS_RESERVED = /[<>:"|?*]/g;
// Device names Windows refuses as a file name, with or without an extension
// (`CON`, `nul.txt`). An underscore after the device name makes it ordinary.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?=\.|$)/i;
// A name has to fit NAME_MAX (255 bytes) with room for what the importer adds
// beside it (`.extracted`, `.unpacked`).
const MAX_UPLOAD_NAME_BYTES = 200;
// An extension longer than this is not one worth keeping over the name.
const MAX_KEPT_EXTENSION_BYTES = 16;

/** `text` cut to at most `max` UTF-8 bytes, never inside a character. */
function truncateBytes(text: string, max: number): string {
  let out = '';
  let bytes = 0;

  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > max) {
      break;
    }

    out += ch;
    bytes += size;
  }

  return out;
}

/**
 * An uploaded file's name as the person named it, made safe to put on disk.
 *
 * {@link sanitizeFilename} replaces everything outside `A-Za-z0-9._-`, which
 * turns `My Clippings.txt` into `My_Clippings.txt` and stops importers that
 * recognize an export by its exact name (Kindle, WhatsApp, Google Maps saved
 * places). Containment needs much less: no path separators, no control
 * characters, nothing a supported filesystem refuses, no dotfile, a bounded
 * length. Spaces, brackets, accents and the rest stay.
 *
 * Only for names arriving through the import wizard. `sanitizeFilename` keeps
 * its own output, which the old email-named inbox folders depend on.
 */
export function sanitizeUploadName(filename: string, fallback = 'upload'): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    // Bidirectional controls can make a name show a different extension than it has.
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(WINDOWS_RESERVED, '_')
    // Leading dots would hide the file or name `.`/`..`; trailing dots and
    // spaces are dropped by Windows, so two names could land as one.
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '')
    .replace(WINDOWS_DEVICE_NAME, '$1_');

  if (cleaned.length === 0) {
    return fallback;
  }

  if (Buffer.byteLength(cleaned) <= MAX_UPLOAD_NAME_BYTES) {
    return cleaned;
  }

  // Too long: shorten the stem and keep the extension, which is what decides
  // whether the upload is unpacked (`.zip`, `.tar.gz`) and which importer reads it.
  const ext = /(\.tar)?\.[^.\s]+$/i.exec(cleaned)?.[0] ?? '';
  const keptExt = Buffer.byteLength(ext) <= MAX_KEPT_EXTENSION_BYTES ? ext : '';
  const stem = cleaned.slice(0, cleaned.length - keptExt.length);

  return (
    truncateBytes(stem, MAX_UPLOAD_NAME_BYTES - Buffer.byteLength(keptExt)).replace(/[\s.]+$/, '') + keptExt
  );
}

/**
 * A folder-upload relative path, kept as a tree under the drop directory.
 *
 * Each segment is run through {@link sanitizeUploadName} so a `../` or a slash
 * inside one component cannot escape the drop. The result always has at least
 * two segments (a folder and a file) — a bare filename is wrapped in `export/`
 * so the staged source can be a real directory the unpack stage can move.
 */
export function sanitizeRelativePath(relativePath: string): string {
  const parts = relativePath.split(/[\\/]+/).filter((part) => part.length > 0 && part !== '.');

  if (parts.some((part) => part === '..')) {
    throw new Error('path escapes the upload directory');
  }

  const cleaned = parts.map((part) => sanitizeUploadName(part, '_'));

  if (cleaned.length === 0) {
    throw new Error('a relative path is required');
  }

  if (cleaned.length === 1) {
    cleaned.unshift('export');
  }

  return cleaned.join('/');
}
