/* Telegram — Telegram Desktop "Export Telegram data" in JSON mode (result.json). */
import fs from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { insideRoot } from './_ai_media';
import { JUNK_NAMES, walkFiles } from './fsWalk';
import { stageLooseFile } from './generic';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { AttachmentDescriptor, ImportParams } from './timeline';
import { mimeForFile, textContent, timeframeContains } from './timeline';

interface TGContact {
  first_name?: string;
  last_name?: string;
  phone_number?: string;
  date?: string;
  date_unixtime?: string | number;
}

interface TGTextEntity {
  type?: string;
  text?: string;
}

interface TGMessage {
  id?: number;
  type?: string; // 'message' | 'service'
  date?: string;
  date_unixtime?: string | number;
  from?: string;
  from_id?: string;
  text?: string | Array<string | TGTextEntity>;
  text_entities?: TGTextEntity[];
  /** A sent photo: its path relative to the export folder, or a left-out note (see {@link LEFT_OUT_RE}). */
  photo?: string;
  /** Any other file (document, video, voice message, sticker), the same way. */
  file?: string;
  file_name?: string;
  mime_type?: string;
  /** What `file` is when it is not a plain document: `sticker`, `voice_message`, `video_file`, … */
  media_type?: string;
  /** The preview Telegram writes beside a video or sticker. Not attached, but not a file of its own either. */
  thumbnail?: string;
}

interface TGChat {
  name?: string;
  type?: string;
  id?: number;
  messages?: TGMessage[];
}

interface TGPersonalInfo {
  user_id?: number;
  first_name?: string;
  last_name?: string;
}

interface TGExport {
  about?: string;
  personal_information?: TGPersonalInfo;
  contacts?: { list?: TGContact[] };
  chats?: { list?: TGChat[] };
}

function isTelegramExport(obj: unknown): obj is TGExport {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const o = obj as Record<string, unknown>;
  const hasAbout = typeof o.about === 'string';
  const hasPersonal = o.personal_information != null && typeof o.personal_information === 'object';
  const hasChats = o.chats != null && typeof o.chats === 'object';

  return hasAbout && (hasPersonal || hasChats);
}

/**
 * What Telegram Desktop writes in place of a path when the export left the
 * bytes out: "(File not included. Change data exporting settings to
 * download.)", or "(File exceeds maximum size. …)".
 */
const LEFT_OUT_RE = /^\(File /;

/** A file the export left out: what it was, with Telegram's `media_type` as `kind` (`sticker`). */
type LeftOutMedia = Omit<AttachmentDescriptor, 'path'> & { kind?: string };

/**
 * The photo and the file a message carried. `photo` and `file` are relative to
 * the export folder (`chats/chat_001/photos/photo_1@….jpg`).
 *
 * `attached` are uploaded with the message. One that should be in the folder
 * and is not (missing, or pointing outside the folder) stays there without a
 * path, so the upload counts it as a gap in the import. `leftOut` are the ones
 * the export's own settings left out ({@link LEFT_OUT_RE}): nothing is
 * missing, so they only say what was sent and the import does not count them
 * as a gap. An export leaves out every kind of media its settings did not ask
 * for, so most exports have some.
 */
function telegramAttachments(
  msg: TGMessage,
  exportDir: string,
): { attached: AttachmentDescriptor[]; leftOut: LeftOutMedia[] } {
  const refs = [
    ...(typeof msg.photo === 'string'
      ? [{ ref: msg.photo, filename: undefined, mimetype: undefined, kind: undefined, photo: true }]
      : []),
    ...(typeof msg.file === 'string'
      ? [
          {
            ref: msg.file,
            filename: msg.file_name,
            mimetype: msg.mime_type,
            kind: msg.media_type,
            photo: false,
          },
        ]
      : []),
  ];
  const attached: AttachmentDescriptor[] = [];
  const leftOut: LeftOutMedia[] = [];

  for (const { ref, filename, mimetype, kind, photo } of refs) {
    const left = LEFT_OUT_RE.test(ref);
    const abs = left ? undefined : exportFile(exportDir, ref);
    const name = filename || (abs ? path.basename(abs) : undefined);
    const mime = mimetype || (name ? mimeForFile(name) : undefined);
    const described = {
      ...(name && { filename: name }),
      type: photo ? ('image' as const) : attachmentType(mime),
      ...(mime && { mimetype: mime }),
    };

    if (left) {
      leftOut.push({ ...described, ...(typeof kind === 'string' && kind && { kind }) });
    } else {
      attached.push({ ...(abs && { path: abs }), ...described });
    }
  }

  return { attached, leftOut };
}

/** `ref` as a regular file inside `exportDir`, or undefined. */
function exportFile(exportDir: string, ref: string): string | undefined {
  const abs = path.resolve(exportDir, ref);
  if (!insideRoot(exportDir, abs)) {
    return undefined;
  }

  try {
    return fs.lstatSync(abs).isFile() ? abs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every file the chats' messages point at (photos, files and their
 * thumbnails), as paths inside the export folder. What is left over in the
 * folder is staged as loose files ({@link TelegramFileImporter.fileImport}).
 */
function referencedFiles(data: TGExport, exportDir: string): Set<string> {
  const found = new Set<string>();

  for (const chat of data.chats?.list ?? []) {
    for (const msg of chat?.messages ?? []) {
      for (const ref of [msg?.photo, msg?.file, msg?.thumbnail]) {
        const abs =
          typeof ref === 'string' && !LEFT_OUT_RE.test(ref) ? exportFile(exportDir, ref) : undefined;

        if (abs) {
          found.add(abs);
        }
      }
    }
  }

  return found;
}

function attachmentType(mimetype: string | undefined): AttachmentDescriptor['type'] {
  if (mimetype?.startsWith('image/')) {
    return 'image';
  }

  if (mimetype?.startsWith('video/')) {
    return 'video';
  }

  if (mimetype?.startsWith('audio/')) {
    return 'audio';
  }

  return 'file';
}

export class TelegramFileImporter implements FileImporter {
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
      if (path.basename(root).toLowerCase() !== 'result.json') {
        return { confidence: 0 };
      }

      const obj = await this.tryParse(root);

      return isTelegramExport(obj) ? { confidence: 0.95 } : { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        const match = (await readdir(root)).find((n) => n.toLowerCase() === 'result.json');
        if (match) {
          const obj = await this.tryParse(path.join(root, match));
          if (isTelegramExport(obj)) {
            // As sure as the result.json inside it, so the FOLDER stays the
            // match: it holds the chats/ media this importer attaches. A match
            // on result.json alone left the generic importer to stage every
            // photo and file there again as a loose, undated item.
            return { confidence: 0.95 };
          }
        }
      } catch {
        /* ignore */
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  private async tryParse(fpath: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(fpath, 'utf8'));
    } catch {
      return undefined;
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

    let fpath: string | undefined;
    if (stat.isFile()) {
      fpath = root;
    } else if (stat.isDirectory()) {
      try {
        const match = fs.readdirSync(root).find((n) => n.toLowerCase() === 'result.json');
        if (match) {
          fpath = path.join(root, match);
        }
      } catch {
        return;
      }
    }

    if (!fpath) {
      return;
    }

    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Failed to read Telegram result.json', { error: (e as Error).message });

      return;
    }

    let data: TGExport;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (!data || typeof data !== 'object') {
      return;
    }

    // Contacts → entities
    for (const c of data.contacts?.list ?? []) {
      if (!c || typeof c !== 'object') {
        continue;
      }

      const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
      if (!c.phone_number) {
        continue;
      }

      params.pipeline.push({
        entity: {
          name,
          attributes: [{ name: 'phone', value: c.phone_number, identity: true }],
          // The number as Telegram wrote it, country code included: the person
          // is matched on its last ten digits but shows this.
          metadata: { Source: 'Telegram', Phones: [c.phone_number] },
          accumulate: ['Phones'],
        },
      });
    }

    // Owner id (from_id is the string 'user' + user_id) for direction derivation.
    const pi = data.personal_information;
    const ownerId = pi?.user_id != null ? `user${pi.user_id}` : undefined;
    const ownerName = pi ? `${pi.first_name ?? ''} ${pi.last_name ?? ''}`.trim() : '';

    // Messages → items
    for (const chat of data.chats?.list ?? []) {
      if (!chat || typeof chat !== 'object') {
        continue;
      }

      for (const [i, msg] of (chat.messages ?? []).entries()) {
        if (!msg || typeof msg !== 'object') {
          continue;
        }

        if (msg.type !== 'message') {
          params.pipeline.drop?.('non_message_type');
          continue;
        }

        let ts: Date | undefined;
        if (msg.date_unixtime != null) {
          ts = new Date(Number(msg.date_unixtime) * 1000);
        } else if (msg.date) {
          ts = new Date(msg.date);
        }

        if (ts && isNaN(ts.getTime())) {
          ts = undefined;
        }

        if (!timeframeContains(params.timeframe, ts)) {
          params.pipeline.drop?.('outside_timeframe');
          continue;
        }

        const text = this.extractText(msg.text);
        // A photo or file sent without a caption is still a message.
        const { attached, leftOut } = telegramAttachments(msg, path.dirname(fpath));
        if (!text && attached.length === 0 && leftOut.length === 0) {
          params.pipeline.drop?.('empty_after_parse');
          continue;
        }

        const isOutbound = ownerId != null && msg.from_id === ownerId;
        const direction = ownerId != null ? (isOutbound ? 'outbound' : 'inbound') : undefined;
        // 1:1 chat name is the counterpart; on outbound they are the recipient,
        // on inbound the owner is. recipientsFrom reads a single To string.
        const to =
          chat.type === 'personal_chat'
            ? isOutbound
              ? chat.name || undefined
              : ownerName || undefined
            : undefined;
        params.pipeline.push({
          item: {
            id:
              msg.id != null
                ? `telegram:${chat.id}:${msg.id}`
                : `telegram:${chat.id}:${ts?.getTime() ?? 'noTs'}:${i}`,
            classification: 'message',
            timestamp: ts,
            content: textContent('message.txt', text),
            metadata: {
              Sender: msg.from || undefined,
              To: to,
              Direction: direction,
              Conversation: chat.name || undefined,
              Source: 'Telegram',
              Text: text || undefined,
              // Uploaded with the message and catalogued as content of their
              // own, as Messenger's are: a photo someone sent is worth finding
              // by itself, not only by reading the chat.
              ...(attached.length > 0 && { MediaAttachments: attached, AttachmentContent: true }),
              ...(leftOut.length > 0 && { MediaLeftOut: leftOut }),
            },
          },
        });
      }
    }

    // A folder match claims the whole export, so the folder walk no longer
    // reaches it. The files no message points at (profile pictures, stories,
    // the media of chats the owner left) still come in as loose files, as they
    // did when the folder walk staged them. So does anything else in a folder
    // that merely holds a result.json. The depth bound is far past any export.
    if (stat.isDirectory()) {
      const exportDir = path.dirname(fpath);
      const referenced = referencedFiles(data, exportDir);

      for await (const found of walkFiles(exportDir, { maxDepth: 32, skipHidden: true })) {
        const file = path.resolve(found);
        const inJunk = path
          .relative(exportDir, file)
          .split(path.sep)
          .some((part) => JUNK_NAMES.has(part));

        if (file !== path.resolve(fpath) && !inJunk && !referenced.has(file)) {
          await stageLooseFile(file, params);
        }
      }
    }
  }

  private extractText(text: TGMessage['text']): string {
    if (typeof text === 'string') {
      return text;
    }

    if (Array.isArray(text)) {
      return text.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
    }

    return '';
  }
}

registerDataSource({
  name: 'telegram',
  title: 'Telegram',
  icon: '',
  description: 'Contacts and chat messages from a Telegram Desktop JSON export (result.json).',
  newFileImporter: () => new TelegramFileImporter(),
});
