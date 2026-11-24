import {
  UNTRUSTED_LINE_PREFIX,
  fenceUntrusted,
  fenceUntrustedLines,
  untrustedBlock,
} from '@ci/common/prompt/untrustedBlock';

import {
  MAX_INLINE_DOCUMENTS_PER_MESSAGE,
  MAX_INLINE_TEXT_BYTES_PER_FILE,
  MAX_INLINE_TEXT_FETCH_BYTES,
} from './contextBudget';

/**
 * What a chat turn can do with a file the user attached.
 *
 * A model backend takes exactly one kind of attachment, an image. Before this, `resolveMessage` handed
 * EVERY attached file to it as image bytes whatever the file was, and a text file or a PDF made the
 * backend reject the request: the stream ended with nothing in it, the turn fell back to its generic
 * "I wasn't able to put together an answer" reply, and the file's contents were never used. The
 * composer accepts images, PDFs, plain text, markdown, CSV and JSON, so most of what it accepts was
 * broken that way.
 *
 *  - `image`: goes to the model as image bytes, as it always did.
 *  - `text`: a text-like file, put in the prompt as text, inside the untrusted-content fence.
 *  - `other`: everything else (PDF, Office documents, audio, an unknown type). The model cannot read
 *    the bytes, so it is given the text the parse pipeline already extracted, if there is any, and
 *    otherwise told, in the turn, why there is none.
 */
export type AttachmentKind = 'image' | 'text' | 'other';

/** The few fields of a `ci.files` row this module reads, so tests need not build a whole row. */
export interface AttachmentFile {
  key?: string | null;
  filename?: string | null;
  contentType?: string | null;
  /** A `bigint` column, which the driver may hand back as a string. */
  size?: number | string | null;
  /** `ParseStatus` in the parsing domain: `processing`, `completed`, `failed` or `skipped`. */
  parseStatus?: string | null;
}

/** Content types that say nothing about the file, so its name has to. */
const GENERIC_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/x-download',
  'application/unknown',
]);

/** `application/*` types that are text. `text/*` and the `+json` / `+xml` suffixes are handled by rule. */
const TEXT_APPLICATION_TYPES = new Set([
  'application/json',
  'application/x-ndjson',
  'application/ndjson',
  'application/jsonl',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/csv',
  'application/x-csv',
  'application/javascript',
  'application/sql',
]);

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'jfif',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif',
  'avif',
]);

const TEXT_EXTENSIONS = new Set([
  'txt',
  'text',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'ndjson',
  'log',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'ini',
  'toml',
  'srt',
  'vtt',
  'sql',
  'svg',
  'ics',
]);

function extensionOf(filename: string | null | undefined): string {
  const name = (filename ?? '').trim().toLowerCase();
  const dot = name.lastIndexOf('.');

  return dot >= 0 ? name.slice(dot + 1) : '';
}

/**
 * Sort an attachment by what the model can be given of it: its declared content type first, and its
 * name only when the type says nothing (a browser sends `application/octet-stream` for a `.md` or a
 * `.json` it does not know, which is why the composer's accept list names those extensions).
 *
 * SVG is an image type but is XML text, and no backend decodes it as an image, so it is text.
 */
export function classifyAttachment(file: AttachmentFile): AttachmentKind {
  const type = (file.contentType ?? '').split(';')[0].trim().toLowerCase();

  if (type === 'image/svg+xml') {
    return 'text';
  }

  if (type.startsWith('image/')) {
    return 'image';
  }

  if (
    type.startsWith('text/') ||
    TEXT_APPLICATION_TYPES.has(type) ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  ) {
    return 'text';
  }

  if (GENERIC_TYPES.has(type)) {
    const extension = extensionOf(file.filename);

    if (IMAGE_EXTENSIONS.has(extension)) {
      return 'image';
    }

    if (TEXT_EXTENSIONS.has(extension)) {
      return 'text';
    }
  }

  return 'other';
}

/** The file's size in bytes, or null when the row does not know it. */
export function attachmentSizeBytes(file: AttachmentFile): number | null {
  if (file.size === null || file.size === undefined) {
    return null;
  }

  const size = Number(file.size);

  return Number.isFinite(size) && size >= 0 ? size : null;
}

/**
 * The attachments of one message that are given to the model as text: everything that is not an
 * image and has bytes behind it, newest last, at most {@link MAX_INLINE_DOCUMENTS_PER_MESSAGE}.
 */
export function keptDocuments<T extends AttachmentFile>(files: readonly T[] | undefined): T[] {
  return (files ?? [])
    .filter((file) => file.key != null && classifyAttachment(file) !== 'image')
    .slice(-MAX_INLINE_DOCUMENTS_PER_MESSAGE);
}

/**
 * What the model is told about a file it cannot be given text of. Each is the whole sentence, so a
 * turn that goes wrong says why in words a person can be told, rather than ending empty.
 */
export const ATTACHMENT_NOTES = {
  processing: 'No text is available yet: the file is still being processed. Ask again in a moment.',
  failed: 'No text is available: the file could not be read.',
  unsupported: 'No text is available: this type of file cannot be read.',
  tooLarge: 'No text is available: the file is too large to include.',
  empty: 'The file is empty.',
  binary: 'No text is available: the file does not look like text.',
  noText: 'No text is available: nothing readable was found in the file.',
  unavailable: 'No text is available: the file could not be read just now.',
  noRoom: 'Not included: there is no room left for it in this turn.',
  truncated: 'Only the beginning of the file is shown: the rest did not fit.',
} as const;

/** Where the text of a file comes from, or why there is none. */
export type DocumentSource = { from: 'object' } | { from: 'parsed' } | { from: 'none'; note: string };

/**
 * Decide, without touching storage, how to get text out of a file.
 *
 * A text file is read as it is, when it is small enough to read whole; a bigger one, and every other
 * kind, goes through the text the parse pipeline extracted into `ci.file_chunks`. That pipeline is
 * asynchronous and starts after the upload, so a file attached a moment ago may still be
 * `processing`: that is reported as such, not as a failure.
 */
export function planDocument(file: AttachmentFile, kind: 'text' | 'other'): DocumentSource {
  const parsed = file.parseStatus === 'completed';

  if (kind === 'text') {
    const size = attachmentSizeBytes(file);

    if (size !== null && size <= MAX_INLINE_TEXT_FETCH_BYTES) {
      return { from: 'object' };
    }

    return parsed ? { from: 'parsed' } : { from: 'none', note: ATTACHMENT_NOTES.tooLarge };
  }

  if (parsed) {
    return { from: 'parsed' };
  }

  switch (file.parseStatus) {
    case 'failed':
      return { from: 'none', note: ATTACHMENT_NOTES.failed };
    case 'skipped':
      return { from: 'none', note: ATTACHMENT_NOTES.unsupported };
    default:
      return { from: 'none', note: ATTACHMENT_NOTES.processing };
  }
}

/**
 * Text read out of an object. A UTF-16 file (a byte-order mark says so) is decoded as UTF-16, the
 * rest as UTF-8, where a byte that is not valid becomes a replacement character instead of failing.
 *
 * Returns null when this is not text: a NUL byte near the start, or mostly replacement characters,
 * is a binary file that was labelled as text, and its bytes in a prompt are noise at best.
 */
export function decodeAttachmentText(bytes: Uint8Array): string | null {
  try {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }

    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }

    if (bytes.subarray(0, 8192).includes(0)) {
      return null;
    }

    const text = new TextDecoder('utf-8').decode(bytes);
    const head = text.slice(0, 8192);
    let replaced = 0;

    for (const character of head) {
      if (character === String.fromCharCode(0xfffd)) {
        replaced += 1;
      }
    }

    return replaced > head.length / 10 ? null : text;
  } catch {
    return null;
  }
}

function cutToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  // The largest prefix that fits: characters are at least one byte, so the answer is at most
  // `maxBytes` characters long, and the search is over that.
  let low = 0;
  let high = Math.min(text.length, maxBytes);

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  const cut = text.slice(0, low);
  const last = cut.charCodeAt(cut.length - 1);

  // Never end on half of a surrogate pair.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export interface QuotedText {
  /** The fenced lines, each already prefixed, ready to join with a line break. */
  lines: string[];
  /** What they weigh once joined, line breaks included. */
  bytes: number;
  /** True when some of the text is not in `lines`. */
  truncated: boolean;
}

/**
 * Fence a document's text and fit it to a byte budget, a whole line at a time.
 *
 * Runs of blank lines collapse to one and the blank lines at either end go, because a prompt pays
 * for every byte. If even the first line is longer than the budget it is cut, rather than the file
 * being reported as empty.
 */
export function quoteDocumentText(text: string, maxBytes: number): QuotedText {
  // Quoting only adds bytes, and a character is at least one, so nothing past `maxBytes` characters
  // can fit: fence that much and no more of a megabyte of text.
  const head = text.length > maxBytes ? text.slice(0, maxBytes) : text;
  const blank = UNTRUSTED_LINE_PREFIX.trimEnd();
  const fenced = fenceUntrustedLines(head);
  const compact: string[] = [];

  for (const line of fenced) {
    if (line === blank && (compact.length === 0 || compact[compact.length - 1] === blank)) {
      continue;
    }

    compact.push(line);
  }

  while (compact.length > 0 && compact[compact.length - 1] === blank) {
    compact.pop();
  }

  const lines: string[] = [];
  let bytes = 0;
  let truncated = head.length < text.length;

  for (const line of compact) {
    const cost = Buffer.byteLength(line, 'utf8') + 1;

    if (bytes + cost > maxBytes) {
      truncated = true;

      break;
    }

    lines.push(line);
    bytes += cost;
  }

  if (lines.length === 0 && compact.length > 0 && maxBytes > 1) {
    const first = cutToBytes(compact[0], maxBytes - 1);

    lines.push(first);
    bytes = Buffer.byteLength(first, 'utf8') + 1;
    truncated = true;
  }

  return { lines, bytes, truncated };
}

/** One attached file as it is shown to the model: a header, then its text and/or a note. */
export interface AttachmentEntry {
  file: AttachmentFile;
  /** The file's text, already fenced by {@link quoteDocumentText}. */
  lines?: string[];
  /** A sentence about the file, shown after any text. */
  note?: string;
}

/** Heading above the fenced block. Ours, so outside the fence; it names no file. */
export const ATTACHMENT_HEADING = 'Files attached to this message:';

function clip(value: string | null | undefined, max: number): string {
  const text = (value ?? '').trim();

  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }

  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `File: name (type, size)`. The name and the type are whatever the uploader sent, so they go
 * through the one-line fence like any other interpolated value; this line is INSIDE the region.
 */
function entryHeader(file: AttachmentFile): string {
  const name = fenceUntrusted(clip(file.filename, 80)) || 'unnamed file';
  const type = fenceUntrusted(clip(file.contentType, 60)) || 'unknown type';
  const size = attachmentSizeBytes(file);

  return `File: ${name} (${type}${size === null ? '' : `, ${formatSize(size)}`})`;
}

function renderEntry(entry: AttachmentEntry): string {
  return [entryHeader(entry.file), ...(entry.lines ?? []), ...(entry.note ? [entry.note] : [])].join('\n');
}

/**
 * The attachments of one message as a block to append to the message's text.
 *
 * It is the existing untrusted-content fence (`untrustedBlock`): the guard sentence, the region
 * markers, and between them only fenced text. Every line of a file's text starts with the quote
 * prefix, and every line this module writes itself does not, so the two cannot be mistaken for one
 * another however the file is written; the file's own text cannot close the region either, because
 * its delimiters are defanged. The model-facing markers are the ones the output scrubber removes
 * if a small model echoes them.
 */
export function renderAttachmentBlock(entries: readonly AttachmentEntry[]): string {
  return untrustedBlock(entries.map(renderEntry).join('\n\n'), ATTACHMENT_HEADING);
}

/** The block's fixed cost: heading, guard sentence, markers. */
export const ATTACHMENT_BLOCK_FRAMING_BYTES = Buffer.byteLength(
  untrustedBlock('x', ATTACHMENT_HEADING),
  'utf8',
);

/** The longest sentence a file can be given as a note. */
const LONGEST_NOTE_BYTES = Math.max(
  ...Object.values(ATTACHMENT_NOTES).map((note) => Buffer.byteLength(note, 'utf8')),
);

/**
 * What one file costs besides its text: its header line, the blank line that separates it from the
 * file before it, and the longest note it could be given.
 */
export function attachmentEntryFramingBytes(file: AttachmentFile): number {
  return Buffer.byteLength(entryHeader(file), 'utf8') + 3 + LONGEST_NOTE_BYTES;
}

/** The most text of a file the prompt could take: what {@link planDocument} would let it read. */
export function documentTextDemand(file: AttachmentFile): number {
  const kind = classifyAttachment(file);
  const source = planDocument(file, kind === 'text' ? 'text' : 'other');

  if (source.from === 'none') {
    return 0;
  }

  if (source.from === 'parsed') {
    return MAX_INLINE_TEXT_BYTES_PER_FILE;
  }

  // Quoting adds the prefix and a line break to every line, so allow a quarter over the file's own
  // size; a file that is mostly very short lines is cut a little short, and says so.
  return Math.min(MAX_INLINE_TEXT_BYTES_PER_FILE, Math.ceil((attachmentSizeBytes(file) ?? 0) * 1.25) + 64);
}

/**
 * The most a message's attachment block could weigh, from the file rows alone: no storage is read.
 * Zero when the message has no attachment that goes in as text. Feeds
 * {@link planAttachmentTextAllowance}, which turns demands into what each message may take.
 */
export function attachmentTextDemand(files: readonly AttachmentFile[] | undefined): number {
  const documents = keptDocuments(files);

  if (documents.length === 0) {
    return 0;
  }

  return documents.reduce(
    (total, file) => total + attachmentEntryFramingBytes(file) + documentTextDemand(file),
    ATTACHMENT_BLOCK_FRAMING_BYTES,
  );
}

/**
 * What is left for the files' own text once the fence and a header for each of `documents` are paid
 * for, out of a message's `allowanceBytes`. Zero or less means there is no room for any of it.
 */
export function attachmentContentBudget(
  documents: readonly AttachmentFile[],
  allowanceBytes: number,
): number {
  return (
    allowanceBytes -
    ATTACHMENT_BLOCK_FRAMING_BYTES -
    documents.reduce((total, file) => total + attachmentEntryFramingBytes(file), 0)
  );
}

/** What the model is told when a message's attachments were left out for want of room. */
export function attachmentNoRoomStub(count: number): string {
  if (count <= 0) {
    return '';
  }

  return count === 1
    ? '[1 attached file could not be included: this conversation has no room left for it.]'
    : `[${count} attached files could not be included: this conversation has no room left for them.]`;
}
