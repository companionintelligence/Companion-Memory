/* Minimal MIME parsing utility for email/gmail datasources (incremental).
   Supports single-level multipart with alternative & attachments.
   RFC 2047 encoded-word headers and RFC 2231 single-segment extended
   filenames are decoded; multi-segment RFC 2231 continuation is not. */
import { Buffer } from 'node:buffer';

import { htmlToText } from './htmlToText';

export interface ParsedAttachment {
  filename?: string;
  mediaType?: string;
  data: Buffer;
}
export interface ParsedMimeResult {
  textBody?: string;
  htmlBody?: string;
  attachments: ParsedAttachment[];
}

export function parseMime(rawHeaders: string, body: string): ParsedMimeResult {
  const headers = headerMap(rawHeaders);
  const contentTypeHeader = headers['content-type'] || '';
  const contentType = contentTypeHeader.toLowerCase();
  const transferEncoding = (headers['content-transfer-encoding'] || '').toLowerCase();

  // If multipart, split and recurse (one level deep)
  if (contentType.startsWith('multipart/')) {
    // Extract boundary from original (case-preserved) header so we retain exact boundary token case
    const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentTypeHeader);
    if (!boundaryMatch) {
      return { attachments: [] };
    }

    const boundary = boundaryMatch[1];
    const parts = splitMultipart(body, boundary);
    const result: ParsedMimeResult = { attachments: [] };
    for (const part of parts) {
      const { headersRaw, bodyRaw } = separateHeaders(part);
      const partHeaders = headerMap(headersRaw);
      const partContentTypeHeader = partHeaders['content-type'] || 'text/plain';
      const ct = partContentTypeHeader.toLowerCase();
      const disp = (partHeaders['content-disposition'] || '').toLowerCase();
      const data = decodeBody(bodyRaw, partHeaders['content-transfer-encoding']);
      if (ct.startsWith('multipart/')) {
        // one-level recursion
        const inner = parseMime(headersRaw, bodyRaw); // recursion maintains boundary case for nested multipart
        // merge inner results
        if (inner.textBody && !result.textBody) {
          result.textBody = inner.textBody;
        }

        if (inner.htmlBody && !result.htmlBody) {
          result.htmlBody = inner.htmlBody;
        }

        result.attachments.push(...inner.attachments);
        continue;
      }

      if (ct.startsWith('text/plain') && !result.textBody) {
        result.textBody = decodeWithCharset(data, extractCharset(partContentTypeHeader));
        continue;
      }

      if (ct.startsWith('text/html') && !result.htmlBody) {
        result.htmlBody = decodeWithCharset(data, extractCharset(partContentTypeHeader));
        continue;
      }

      const filename =
        extractFilename(partHeaders['content-disposition']) || extractFilename(partHeaders['content-type']);
      if (disp.startsWith('attachment') || filename) {
        result.attachments.push({ filename, mediaType: ct.split(';')[0], data });
      }
    }

    return result;
  }

  // Single part
  const decoded = decodeBody(body, transferEncoding);
  const charset = extractCharset(contentTypeHeader);
  if (contentType.startsWith('text/html')) {
    return { htmlBody: decodeWithCharset(decoded, charset), attachments: [] };
  }

  return { textBody: decodeWithCharset(decoded, charset), attachments: [] };
}

/** The `charset` parameter of a Content-Type header, if any. */
function extractCharset(contentTypeHeader: string): string | undefined {
  return /charset\s*=\s*"?([^";]+)"?/i.exec(contentTypeHeader)?.[1];
}

/**
 * Decode bytes using the MIME charset label, falling back to UTF-8 for an
 * absent or unrecognized one. `Buffer#toString` only understands a handful of
 * encodings (utf8/ascii/latin1/utf16le/base64/hex) — real mail declares
 * iso-8859-1, windows-1252, shift_jis and the like, and forcing those through
 * as UTF-8 silently corrupts every non-ASCII character. `TextDecoder` covers
 * the labels IANA actually assigns (Node ships full ICU by default), so this
 * costs nothing beyond the charset lookup itself.
 */
function decodeWithCharset(bytes: Buffer, charset: string | undefined): string {
  const label = (charset ?? '').trim().toLowerCase();
  if (!label || label === 'utf-8' || label === 'utf8' || label === 'us-ascii') {
    return bytes.toString('utf8');
  }

  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

// Flatten an HTML mail body to readable plain text — re-exported from the
// shared parser-based flattener in `./htmlToText` (see its own doc comment:
// a receipt is very often HTML-only, and a regex tag-stripper here used to
// leave tag soup for everything downstream to choke on). Kept under this
// name because `readableBody` below and doc comments across gmail.ts/
// email.ts/receipt_detect.ts already refer to "email_mime.htmlToText".
export { htmlToText };

/**
 * The readable body of a parsed message: the text/plain part when the sender
 * provided one, else the HTML part flattened by {@link htmlToText}.
 */
export function readableBody(mime: ParsedMimeResult): string {
  return mime.textBody || htmlToText(mime.htmlBody);
}

function headerMap(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of raw.split(/\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) {
      continue;
    }

    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    if (!map[k]) {
      map[k] = v;
    } else {
      map[k] += ', ' + v;
    }
  }

  return map;
}

function separateHeaders(raw: string): { headersRaw: string; bodyRaw: string } {
  const parts = raw.split(/\n\n/);
  if (parts.length < 2) {
    return { headersRaw: raw, bodyRaw: '' };
  }

  return { headersRaw: parts[0].replace(/\n[ \t]+/g, ' '), bodyRaw: parts.slice(1).join('\n\n') };
}

function splitMultipart(fullBody: string, boundary: string): string[] {
  const lines = (fullBody.endsWith('\n') ? fullBody : fullBody + '\n').split(/\n/);
  const parts: string[] = [];
  let current: string[] = [];
  const boundaryLine = '--' + boundary;
  for (const line of lines) {
    if (line.startsWith(boundaryLine)) {
      if (current.length) {
        parts.push(current.join('\n').trim());
        current = [];
      }

      if (line.startsWith(boundaryLine + '--')) {
        // closing boundary; stop collecting further
        break;
      }

      continue; // start next part
    }

    current.push(line);
  }

  return parts.filter((p) => p);
}

function decodeBody(body: string, cte?: string): Buffer {
  const enc = (cte || '').toLowerCase();
  if (enc === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/g, '').trim(), 'base64');
    } catch {
      return Buffer.from(body);
    }
  }

  if (enc === 'quoted-printable') {
    return decodeQuotedPrintableBody(body.replace(/=\r?\n/g, ''));
  }

  return Buffer.from(body, 'utf8');
}

/**
 * Quoted-printable body decode to RAW BYTES, not a UTF-8 round-trip.
 *
 * Each `=XX` escape is a byte in the part's OWN declared charset, which is not
 * necessarily UTF-8. Treating the escaped byte as if it were itself a Unicode
 * code point — `String.fromCharCode(n)` joined into one string and then
 * `Buffer.from(str, 'utf8')` — corrupts any multi-byte sequence: a UTF-8 'é'
 * written as `=C3=A9` decoded to 4 bytes (each of 0xC3 and 0xA9 individually
 * re-encoded as its own 2-byte UTF-8 sequence) instead of the original 2.
 *
 * A run of LITERAL (non-escaped) text is already real Unicode text — this
 * file is read from disk as UTF-8 — so only literal runs are (re-)encoded as
 * UTF-8; escaped bytes are pushed verbatim and decoded downstream by
 * {@link decodeWithCharset} using whatever charset the part actually declared.
 */
function decodeQuotedPrintableBody(text: string): Buffer {
  const chunks: Buffer[] = [];
  let literal = '';
  const flushLiteral = (): void => {
    if (literal) {
      chunks.push(Buffer.from(literal, 'utf8'));
      literal = '';
    }
  };

  for (let i = 0; i < text.length; i++) {
    const hex = text[i] === '=' ? text.slice(i + 1, i + 3) : '';
    const byte = hex.length === 2 ? parseInt(hex, 16) : NaN;

    if (Number.isNaN(byte)) {
      literal += text[i];
      continue;
    }

    flushLiteral();
    chunks.push(Buffer.from([byte]));
    i += 2;
  }

  flushLiteral();

  return Buffer.concat(chunks);
}

/**
 * A non-ASCII attachment filename ("café.pdf") in RFC 2231 §4 extended
 * notation: `filename*=UTF-8''caf%C3%A9.pdf` — a charset, an (unused)
 * language tag, then percent-encoded bytes in THAT charset. Real clients that
 * emit this also send a plain `filename=` fallback (usually a transliterated
 * or truncated ASCII name) in every case observed so far, so the rarer
 * multi-segment continuation form (`filename*0*=`, `filename*1*=`, …) is not
 * handled here — the plain fallback below still resolves.
 */
function extractExtendedFilename(headerValue: string): string | undefined {
  const m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(headerValue);

  if (!m) {
    return undefined;
  }

  const [, charset, encoded] = m;
  const name = decodeWithCharset(percentDecodeToBytes(encoded.trim()), charset);

  return name || undefined;
}

/** Percent-decoded bytes (RFC 3986 %XX), not a string — the caller decides the charset. */
function percentDecodeToBytes(s: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const hex = s[i] === '%' ? s.slice(i + 1, i + 3) : '';
    const code = hex.length === 2 ? parseInt(hex, 16) : NaN;
    if (Number.isNaN(code)) {
      bytes.push(s.charCodeAt(i));
    } else {
      bytes.push(code);
      i += 2;
    }
  }

  return Buffer.from(bytes);
}

function extractFilename(headerValue?: string): string | undefined {
  if (!headerValue) {
    return undefined;
  }

  const m = /filename="?([^";]+)"?/i.exec(headerValue);

  return extractExtendedFilename(headerValue) ?? m?.[1];
}

// RFC 2047 encoded-word decoding for header fields. Handles both Q (quoted-
// printable variant with underscore-as-space) and B (base64) encodings.
// Per RFC 2047 §6.2 any whitespace BETWEEN adjacent encoded-words is folded
// away ("=?…?= =?…?=" → concatenated), but whitespace between an encoded
// word and an ascii run is preserved.
const ENCODED_WORD_RE = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

function decodeQEncoded(payload: string): Buffer {
  // Q-encoding: underscore = space, =XX = byte. Decode to raw bytes so the
  // following charset conversion sees the correct byte sequence.
  const bytes: number[] = [];
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i];
    if (c === '_') {
      bytes.push(0x20);
    } else if (c === '=' && i + 2 < payload.length) {
      const hex = payload.slice(i + 1, i + 3);
      const n = parseInt(hex, 16);
      if (Number.isNaN(n)) {
        bytes.push(c.charCodeAt(0));
      } else {
        bytes.push(n);
        i += 2;
      }
    } else {
      bytes.push(c.charCodeAt(0));
    }
  }

  return Buffer.from(bytes);
}

export function decodeHeaderField(raw: string): string {
  if (!raw || !raw.includes('=?')) {
    return raw;
  }

  // First pass: replace each encoded-word with its decoded text. Remember
  // the surrounding character so we can later collapse whitespace between
  // adjacent encoded words.
  type Token = { kind: 'enc'; text: string } | { kind: 'lit'; text: string };
  const tokens: Token[] = [];
  let lastIdx = 0;
  for (const m of raw.matchAll(ENCODED_WORD_RE)) {
    if (m.index! > lastIdx) {
      tokens.push({ kind: 'lit', text: raw.slice(lastIdx, m.index!) });
    }

    const [, charset, scheme, payload] = m;
    let decoded: Buffer;
    try {
      if (scheme.toUpperCase() === 'B') {
        decoded = Buffer.from(payload, 'base64');
      } else {
        decoded = decodeQEncoded(payload);
      }

      tokens.push({ kind: 'enc', text: decodeWithCharset(decoded, charset) });
    } catch {
      tokens.push({ kind: 'lit', text: m[0] });
    }

    lastIdx = m.index! + m[0].length;
  }

  if (lastIdx < raw.length) {
    tokens.push({ kind: 'lit', text: raw.slice(lastIdx) });
  }

  // Collapse whitespace between two adjacent encoded-words.
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (
      t.kind === 'lit' &&
      /^\s+$/.test(t.text) &&
      i > 0 &&
      i < tokens.length - 1 &&
      tokens[i - 1].kind === 'enc' &&
      tokens[i + 1].kind === 'enc'
    ) {
      continue;
    }

    out += t.text;
  }

  return out;
}
