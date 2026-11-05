/* SMS Backup & Restore — Android XML export (<smses><sms .../><mms .../></smses>). */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { extension } from 'mime-types';

import { decodeEntities } from './htmlToText';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { textContent, timeframeContains } from './timeline';

// Byte constants for the streaming tokenizer (all ASCII — safe against UTF-8,
// whose multi-byte sequences never use bytes < 0x80).
const LT = 0x3c; // '<'
const GT = 0x3e; // '>'
const DQUOTE = 0x22; // '"'
const BANG = 0x21; // '!'
const QUES = 0x3f; // '?'
const SLASH = 0x2f; // '/'
const DASH = 0x2d; // '-'
const EMPTY_BUFFER = Buffer.alloc(0);

// Marker for the `data` attribute of a <part>. The LEADING SPACE is load-bearing:
// it anchors on the attribute boundary so we never mistake `coupon_data="..."`
// (preceded by '_', not a space) for the real media payload. XML escapes any
// literal '"' inside a value as &quot;, so the only real quotes are delimiters —
// this marker therefore appears exactly once, on the true media attribute.
const DATA_ATTR = Buffer.from(' data="');
const COMMENT_END = Buffer.from('-->');

// Bytes that terminate a tag NAME (whitespace, self-close slash, or tag end).
const NAME_DELIMS = new Set([0x20, 0x09, 0x0a, 0x0d, SLASH, GT]);

// Read the XML in 256 KB chunks. The tokenizer keeps only a small "leftover"
// (at most one partial *structural* tag — never base64) between chunks, so peak
// memory stays ~one chunk regardless of how large an MMS attachment is.
const READ_CHUNK_BYTES = 256 * 1024;

// Content-types where mime-db's first-listed extension doesn't serve us. The
// mapping itself comes from mime-db (via mime-types) — these are the exceptions.
const CT_EXT_OVERRIDES: Record<string, string> = {
  // mime-db lists .3gpp first, and .3gpp reads back as video/3gpp — an audio
  // attachment would import as a video and route to capture.video. '.3ga' has no
  // reverse mapping at all, so the part simply arrives untyped: no type beats a
  // wrong one, and this is what the importer already did.
  'audio/3gpp': '.3ga',
  // mime-db lists .mpga first. Both re-derive audio/mpeg, but the temp file's
  // name is what shows up in the timeline, and nobody calls an MP3 a .mpga.
  'audio/mpeg': '.mp3',
  // Which of .jpg / .jpeg mime-db lists first has flipped between releases, so
  // the name an MMS photo lands under would drift with a dependency bump. Both
  // re-derive image/jpeg, so nothing misroutes — but the extension is what shows
  // up in the timeline, so pin the one people write.
  'image/jpeg': '.jpg',
};

// Extension for an MMS media temp file, so downstream (mimeForFile) can re-derive
// the MIME from the path. Prefers the part's own filename extension, then the
// content type, then a sanitized subtype (which covers the non-standard types
// Android senders emit — image/jpg, video/avi — that no registry lists), then
// '.bin'.
function mediaExt(ct: string | undefined, name: string | undefined): string {
  if (name && name !== 'null') {
    const e = path.extname(name);
    if (e) {
      return e.toLowerCase();
    }
  }

  if (ct) {
    const key = ct.toLowerCase();
    const known = CT_EXT_OVERRIDES[key] ?? (extension(key) || undefined);
    if (known) {
      return known.startsWith('.') ? known : `.${known}`;
    }

    const slash = ct.indexOf('/');
    if (slash >= 0) {
      const sub = ct
        .slice(slash + 1)
        .replace(/[^a-z0-9]/gi, '')
        .toLowerCase();
      if (sub) {
        return `.${sub}`;
      }
    }
  }

  return '.bin';
}

/**
 * Incremental base64 decoder. base64 encodes 4 input chars → 3 output bytes, so
 * a streamed value can split mid-group across chunk boundaries. This buffers the
 * 0–3 leftover chars, decodes only whole 4-char groups per push(), and flush()es
 * the tail at end-of-value. Non-alphabet bytes (newlines from wrapped base64,
 * stray whitespace) are stripped, so it tolerates line-wrapped payloads.
 */
class Base64StreamDecoder {
  private rem = '';

  push(chunk: string): Buffer {
    const cleaned = chunk.replace(/[^A-Za-z0-9+/=]/g, '');
    if (!cleaned) {
      return EMPTY_BUFFER;
    }

    const s = this.rem + cleaned;
    const usable = s.length - (s.length % 4);
    this.rem = s.slice(usable);

    return usable > 0 ? Buffer.from(s.slice(0, usable), 'base64') : EMPTY_BUFFER;
  }

  flush(): Buffer {
    if (!this.rem) {
      return EMPTY_BUFFER;
    }

    const out = Buffer.from(this.rem, 'base64');
    this.rem = '';

    return out;
  }

  reset(): void {
    this.rem = '';
  }
}

// Decode the XML entities that SMS Backup & Restore emits in attribute values.
function unescapeXml(s: string): string {
  return decodeEntities(s, { xml: true });
}

// Pull the key="value" attributes out of a single tag's text.
function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1]] = unescapeXml(m[2] ?? m[3]);
  }

  return attrs;
}

// First byte at/after `from` that terminates a tag name, or -1 if none in buf.
function findNameEnd(buf: Buffer, from: number): number {
  for (let i = from; i < buf.length; i++) {
    if (NAME_DELIMS.has(buf[i])) {
      return i;
    }
  }

  return -1;
}

function looksLikeSmses(text: string): boolean {
  return text.includes('<smses');
}

function looksLikeCalls(text: string): boolean {
  return text.includes('<calls');
}

/** A binary <part> attachment streamed to a temp file on disk. */
interface MediaPart {
  filePath: string;
  bytes: number;
  ct: string | null;
}

export class SmsBackupRestoreFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return { confidence: 0 };
    }

    let st: fs.Stats;
    try {
      st = await stat(root);
    } catch {
      return { confidence: 0 };
    }

    if (st.isFile()) {
      if (path.extname(root).toLowerCase() !== '.xml') {
        return { confidence: 0 };
      }

      return (await this.peekIsSms(root)) || (await this.peekIsCalls(root))
        ? { confidence: 0.9 }
        : { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        const names = await readdir(root);
        for (const name of names) {
          if (path.extname(name).toLowerCase() !== '.xml') {
            continue;
          }

          const fpath = path.join(root, name);
          if ((await this.peekIsSms(fpath)) || (await this.peekIsCalls(fpath))) {
            return { confidence: 0.9 };
          }
        }
      } catch {
        /* ignore */
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  // Read only the first ~2KB to sniff for the <smses root without loading huge files.
  private async peekIsSms(fpath: string): Promise<boolean> {
    return this.peekContains(fpath, looksLikeSmses);
  }

  // Read only the first ~2KB to sniff for the <calls root without loading huge files.
  private async peekIsCalls(fpath: string): Promise<boolean> {
    return this.peekContains(fpath, looksLikeCalls);
  }

  private async peekContains(fpath: string, pred: (text: string) => boolean): Promise<boolean> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(fpath, 'r');
      const buf = Buffer.alloc(2048);
      const { bytesRead } = await handle.read(buf, 0, 2048, 0);

      return pred(buf.toString('utf8', 0, bytesRead));
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => {
        /* ignore */
      });
    }
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      return;
    }

    if (stat.isFile()) {
      await this.processFile(root, params);
    } else if (stat.isDirectory()) {
      let names: string[];
      try {
        names = fs.readdirSync(root);
      } catch {
        return;
      }

      for (const name of names) {
        if (path.extname(name).toLowerCase() !== '.xml') {
          continue;
        }

        const fpath = path.join(root, name);
        if ((await this.peekIsSms(fpath)) || (await this.peekIsCalls(fpath))) {
          await this.processFile(fpath, params);
        }
      }
    }
  }

  /**
   * Stream the XML through a byte-level tokenizer. <sms>/<call> are emitted as
   * they close; an <mms> accumulates its <part>s until </mms>. Crucially, a
   * <part>'s inline base64 `data` attribute is NEVER buffered as a whole: on
   * reaching ` data="` we open a temp file and pipe the value straight through a
   * streaming base64 decoder to disk, chunk by chunk. There is no size cap — a
   * 100 MB video costs ~one read-chunk of memory, not 100 MB.
   */
  /**
   * Directory to stream MMS attachments into. Prefer the durable media store
   * (params.mediaStoreDir) so the push can upload them AND purge the local copy
   * once they're in Memory (media.ts isPurgeCandidate keys off that dir). Fall
   * back to the OS temp dir when there is no store (tests, ad-hoc CLI) or the
   * store can't be created.
   */
  private mediaOutputDir(params: ImportParams): string {
    const dir = params.mediaStoreDir;
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });

        return dir;
      } catch {
        /* fall through to the temp dir */
      }
    }

    return os.tmpdir();
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    const mediaDir = this.mediaOutputDir(params);

    // ---- MMS assembly state ----
    let inMms = false;
    let mmsKeep = false; // false → discard (filtered) MMS, skip its media
    let mmsAttrs: Record<string, string> = {};
    let textParts: string[] = [];
    let mediaParts: MediaPart[] = [];
    let mediaSeq = 0;

    // An MMS survives only if it's in-timeframe and a real inbox/sent message.
    // Deciding this at <mms> open (not close) lets us skip writing attachment
    // bytes to disk for MMS we'd throw away anyway.
    const shouldKeepMms = (a: Record<string, string>): boolean => {
      const ts = a.date ? new Date(Number(a.date)) : undefined;
      if (ts && isNaN(ts.getTime())) {
        return false;
      }

      if (!timeframeContains(params.timeframe, ts)) {
        return false;
      }

      return a.msg_box === '1' || a.msg_box === '2';
    };

    const resetMms = () => {
      inMms = false;
      mmsKeep = false;
      mmsAttrs = {};
      textParts = [];
      mediaParts = [];
      mediaSeq = 0;
    };

    const flushMms = () => {
      if (inMms && mmsKeep) {
        try {
          this.pushMms(mmsAttrs, textParts, mediaParts, params);
        } catch (e) {
          params.log?.('error', `Failed to build mms in ${base}`, { error: (e as Error).message });
        }
      }

      resetMms();
    };

    // ---- streaming media-write state (active while inside a <part> data value) ----
    const b64 = new Base64StreamDecoder();
    let mediaWrite: fs.WriteStream | null = null; // null while skipping a filtered MMS's media
    let mediaPath = '';
    let mediaBytes = 0;
    let mediaCt: string | null = null;

    const writeMedia = (bytes: Buffer): Promise<void> => {
      if (!bytes.length || !mediaWrite) {
        return Promise.resolve();
      }

      mediaBytes += bytes.length;
      const w = mediaWrite;

      return new Promise((resolve, reject) => w.write(bytes, (err) => (err ? reject(err) : resolve())));
    };

    const closeMedia = (): Promise<void> => {
      const w = mediaWrite;
      if (!w) {
        return Promise.resolve();
      }

      return new Promise((resolve, reject) => w.end((err?: Error | null) => (err ? reject(err) : resolve())));
    };

    // Called at ` data="`. The header attrs (everything before data) are already
    // parsed, giving us ct/name to pick an extension. For a filtered MMS we open
    // no file — the value is consumed and discarded.
    const beginMedia = (headerAttrs: Record<string, string>) => {
      b64.reset();
      mediaBytes = 0;
      if (!inMms || !mmsKeep) {
        mediaWrite = null;
        mediaPath = '';
        mediaCt = null;

        return;
      }

      mediaCt = headerAttrs.ct && headerAttrs.ct !== 'null' ? headerAttrs.ct : null;
      const ext = mediaExt(mediaCt ?? undefined, headerAttrs.name);
      const uniq = `${mmsAttrs.date ?? 'na'}-${mediaSeq++}-${randomBytes(6).toString('hex')}`;
      mediaPath = path.join(mediaDir, `mms-media-${uniq}${ext}`);
      try {
        mediaWrite = fs.createWriteStream(mediaPath);
      } catch (e) {
        params.log?.('warn', `Failed to open MMS media temp file in ${base}`, {
          error: (e as Error).message,
        });
        mediaWrite = null;
        mediaPath = '';
      }
    };

    // Called at the value's closing quote: flush the decoder, close the file, and
    // record the part. Empty payloads (e.g. data="") leave no file behind.
    const finishMedia = async () => {
      try {
        await writeMedia(b64.flush());
        await closeMedia();
      } catch (e) {
        params.log?.('warn', `Failed to write MMS media in ${base}`, { error: (e as Error).message });
        if (mediaPath) {
          try {
            fs.unlinkSync(mediaPath);
          } catch {
            /* ignore */
          }
        }

        mediaWrite = null;
        mediaPath = '';
        mediaBytes = 0;
        mediaCt = null;

        return;
      }

      if (mediaWrite && mediaBytes > 0) {
        mediaParts.push({ filePath: mediaPath, bytes: mediaBytes, ct: mediaCt });
      } else if (mediaPath) {
        try {
          fs.unlinkSync(mediaPath);
        } catch {
          /* ignore */
        }
      }

      mediaWrite = null;
      mediaPath = '';
      mediaBytes = 0;
      mediaCt = null;
    };

    // Discard a media file whose value was truncated by end-of-stream.
    const abortMedia = async () => {
      try {
        await closeMedia();
      } catch {
        /* ignore */
      }

      if (mediaPath) {
        try {
          fs.unlinkSync(mediaPath);
        } catch {
          /* ignore */
        }
      }

      mediaWrite = null;
      mediaPath = '';
      mediaBytes = 0;
      mediaCt = null;
    };

    // ---- tokenizer ----
    const stream = fs.createReadStream(fpath, { highWaterMark: READ_CHUNK_BYTES });
    let leftover = EMPTY_BUFFER; // partial structural tag carried to next chunk
    let state: 'scan' | 'data' | 'skiptag' = 'scan';

    for await (const chunk of stream) {
      const buf: Buffer = leftover.length ? Buffer.concat([leftover, chunk as Buffer]) : (chunk as Buffer);
      leftover = EMPTY_BUFFER;
      let p = 0;

      while (p < buf.length) {
        if (state === 'data') {
          // Stream the base64 value straight to disk until its closing quote.
          const q = buf.indexOf(DQUOTE, p);
          const end = q === -1 ? buf.length : q;
          if (mediaWrite && end > p) {
            await writeMedia(b64.push(buf.toString('latin1', p, end)));
          }

          if (q === -1) {
            p = buf.length;
            break;
          } // value continues in the next chunk

          await finishMedia();
          state = 'skiptag'; // consume the rest of the <part ... /> tag
          p = q + 1;
          continue;
        }

        if (state === 'skiptag') {
          const g = buf.indexOf(GT, p);
          if (g === -1) {
            p = buf.length;
            break;
          }

          p = g + 1;
          state = 'scan';
          continue;
        }

        // state === 'scan': find the next tag.
        const lt = buf.indexOf(LT, p);
        if (lt === -1) {
          break;
        } // only inter-tag text remains

        if (lt + 1 >= buf.length) {
          leftover = buf.slice(lt);
          break;
        }

        const c1 = buf[lt + 1];

        if (c1 === BANG) {
          // Comment / doctype / CDATA. Skip a comment via its '-->'; anything
          // else via its '>'. Values here never contain base64.
          if (lt + 4 > buf.length) {
            leftover = buf.slice(lt);
            break;
          }

          if (buf[lt + 2] === DASH && buf[lt + 3] === DASH) {
            const e = buf.indexOf(COMMENT_END, lt + 4);
            if (e === -1) {
              leftover = buf.slice(lt);
              break;
            }

            p = e + COMMENT_END.length;
          } else {
            const g = buf.indexOf(GT, lt);
            if (g === -1) {
              leftover = buf.slice(lt);
              break;
            }

            p = g + 1;
          }

          continue;
        }

        if (c1 === QUES) {
          // Processing instruction, e.g. <?xml ... ?>.
          const g = buf.indexOf(GT, lt);
          if (g === -1) {
            leftover = buf.slice(lt);
            break;
          }

          p = g + 1;
          continue;
        }

        if (c1 === SLASH) {
          // Closing tag, e.g. </mms>.
          const g = buf.indexOf(GT, lt);
          if (g === -1) {
            leftover = buf.slice(lt);
            break;
          }

          const name = buf
            .toString('utf8', lt + 2, g)
            .trim()
            .toLowerCase();
          if (name === 'mms') {
            flushMms();
          }

          p = g + 1;
          continue;
        }

        // Opening tag: read its name.
        const nameEnd = findNameEnd(buf, lt + 1);
        if (nameEnd === -1) {
          leftover = buf.slice(lt);
          break;
        }

        const name = buf.toString('utf8', lt + 1, nameEnd).toLowerCase();

        if (name === 'part') {
          // Find whichever comes first: the data payload or the tag's end. A media
          // part's base64 (no '>' in the alphabet) may not be fully buffered yet,
          // so a missing '>' with a present ` data="` still means "media".
          const g = buf.indexOf(GT, nameEnd);
          const d = buf.indexOf(DATA_ATTR, nameEnd);
          if (d !== -1 && (g === -1 || d < g)) {
            const headerAttrs = parseAttrs(buf.toString('utf8', lt, d));
            beginMedia(headerAttrs);
            state = 'data';
            p = d + DATA_ATTR.length;
            continue;
          }

          if (g !== -1) {
            this.onTextPart(parseAttrs(buf.toString('utf8', lt, g + 1)), inMms, mmsKeep, textParts);
            p = g + 1;
            continue;
          }

          leftover = buf.slice(lt); // header not fully buffered yet
          break;
        }

        // Any other opening tag (sms, call, mms, parts, addrs, addr, smses, …).
        const g = buf.indexOf(GT, nameEnd);
        if (g === -1) {
          leftover = buf.slice(lt);
          break;
        }

        const tagText = buf.toString('utf8', lt, g + 1);
        if (name === 'sms') {
          this.trySms(tagText, base, params);
        } else if (name === 'call') {
          this.tryCall(tagText, base, params);
        } else if (name === 'mms') {
          mmsAttrs = parseAttrs(tagText);
          inMms = true;
          mmsKeep = shouldKeepMms(mmsAttrs);
          textParts = [];
          mediaParts = [];
          mediaSeq = 0;
          if (tagText.endsWith('/>')) {
            flushMms();
          } // empty self-closed MMS
        }

        p = g + 1;
      }
    }

    // End of stream: discard any half-written attachment, then flush a dangling MMS.
    if (state === 'data' && mediaWrite) {
      await abortMedia();
    }

    flushMms();
  }

  private onTextPart(
    attrs: Record<string, string>,
    inMms: boolean,
    mmsKeep: boolean,
    textParts: string[],
  ): void {
    if (!inMms || !mmsKeep) {
      return;
    }

    const ct = attrs.ct;
    if (ct && ct.startsWith('text/')) {
      textParts.push(attrs.text ?? '');
    }
  }

  private trySms(tagText: string, base: string, params: ImportParams): void {
    try {
      this.pushSms(parseAttrs(tagText), params);
    } catch (e) {
      params.log?.('error', `Failed to parse sms in ${base}`, { error: (e as Error).message });
    }
  }

  private tryCall(tagText: string, base: string, params: ImportParams): void {
    try {
      this.pushCall(parseAttrs(tagText), params);
    } catch (e) {
      params.log?.('error', `Failed to parse call in ${base}`, { error: (e as Error).message });
    }
  }

  private pushSms(a: Record<string, string>, params: ImportParams): void {
    const date = a.date;
    const ts = date ? new Date(Number(date)) : undefined;
    if (ts && isNaN(ts.getTime())) {
      return;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const type = a.type;
    const contactName = a.contact_name;
    const address = a.address;
    const sender = type === '2' ? 'Me' : contactName && contactName !== '(Unknown)' ? contactName : address;
    const body = a.body ?? '';

    params.pipeline.push({
      item: {
        classification: 'message',
        timestamp: ts,
        content: textContent('sms.txt', body),
        metadata: {
          Sender: sender || undefined,
          Address: address || undefined,
          Direction: type === '2' ? 'sent' : 'received',
          To:
            type === '2'
              ? (contactName && contactName !== '(Unknown)' ? contactName : address) || undefined
              : undefined,
          Source: 'SMS Backup & Restore',
          Text: body || undefined,
        },
      },
    });
  }

  private pushCall(a: Record<string, string>, params: ImportParams): void {
    const date = a.date;
    const ts = date ? new Date(Number(date)) : undefined;
    if (ts && isNaN(ts.getTime())) {
      return;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    // type: 1=incoming, 2=outgoing, 3=missed, 4=voicemail, 5=rejected, 6=refused
    const type = a.type;
    const contactName = a.contact_name;
    const number = a.number;
    const duration = a.duration;
    const typeLabelMap: Record<string, string> = {
      '1': 'Incoming',
      '2': 'Outgoing',
      '3': 'Missed',
      '4': 'Voicemail',
      '5': 'Rejected',
      '6': 'Refused',
    };
    const directionMap: Record<string, string> = {
      '1': 'received',
      '2': 'sent',
      '3': 'missed',
      '4': 'voicemail',
      '5': 'rejected',
      '6': 'refused',
    };
    const typeLabel = typeLabelMap[type] || 'Unknown';
    const direction = directionMap[type] || 'unknown';
    const contact = (contactName && contactName !== '(Unknown)' ? contactName : number) || undefined;
    const preposition = type === '2' ? 'to' : 'from';
    const contentStr = `${typeLabel} call ${preposition} ${contact || 'unknown'}`;

    params.pipeline.push({
      item: {
        classification: 'call',
        timestamp: ts,
        content: textContent('call.txt', contentStr),
        metadata: {
          Contact: contact,
          Number: number || undefined,
          Duration: duration ? Number(duration) : undefined,
          DurationUnit: 'seconds',
          Direction: direction,
          Source: 'SMS Backup & Restore',
          Description: contentStr,
        },
      },
    });
  }

  /**
   * Push a parsed MMS entry into the pipeline. By the time this runs, every
   * binary attachment has already been streamed to a temp file on disk (see
   * processFile); `mediaParts` carries those paths. The item's textual content
   * comes from the text/* parts, with a synthesized fallback when there is none.
   *
   * Timeframe / msg_box filtering already happened at <mms> open (shouldKeepMms),
   * so this is only reached for messages we intend to keep.
   */
  private pushMms(
    a: Record<string, string>,
    textParts: string[],
    mediaParts: MediaPart[],
    params: ImportParams,
  ): void {
    const date = a.date;
    const ts = date ? new Date(Number(date)) : undefined;
    const msgBox = a.msg_box;
    const direction = msgBox === '1' ? 'inbound' : 'outbound';
    const contactName = a.contact_name;
    const rootAddress = a.address;

    let sender: string | undefined;
    const recipients: string[] = [];
    if (msgBox === '1') {
      // Received MMS — the address attribute is the sender.
      sender = rootAddress || contactName;
    } else {
      // Sent MMS — sender is "Me".
      sender = 'Me';
      if (rootAddress) {
        recipients.push(rootAddress);
      }
    }

    let content = '';
    for (const tp of textParts) {
      content += tp;
    }

    if (!content.trim()) {
      const peer = sender === 'Me' ? recipients[0] || 'unknown' : sender || 'unknown';
      content = msgBox === '1' ? `Received MMS from ${peer}` : `Sent MMS to ${peer}`;
    }

    const mediaFilePaths = mediaParts.map((m) => m.filePath);

    params.pipeline.push({
      item: {
        classification: 'message',
        timestamp: ts,
        content: textContent('mms.txt', content),
        metadata: {
          Sender: sender || undefined,
          Address: rootAddress || undefined,
          Direction: direction,
          To: recipients.length > 0 ? recipients : undefined,
          Source: 'SMS Backup & Restore',
          Text: content || undefined,
          // Stable MMS identifier from the XML (_id field).
          _id: a._id || undefined,
          ThreadId: a.thread_id || undefined,
          // Temp file paths for the MMS attachments, streamed to disk during
          // ingest. The push step uploads them to CI-Server and carries the
          // returned file ids in the communication's attachments column.
          MediaFilePaths: mediaFilePaths.length > 0 ? mediaFilePaths : undefined,
        },
      },
    });
  }
}

registerDataSource({
  name: 'sms_backup_restore',
  title: 'SMS Backup & Restore',
  icon: '',
  description:
    'SMS/MMS messages from the Android "SMS Backup & Restore" XML export. ' +
    'Pro .zip exports must be unzipped first — only the .xml file is read.',
  newFileImporter: () => new SmsBackupRestoreFileImporter(),
});
