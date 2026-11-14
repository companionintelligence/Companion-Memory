/* WhatsApp — per-chat _chat.txt export (iOS and Android formats). */
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { wallClockToUTC, type WallClock } from '@ci/common/time/zoned';

import { serviceInboxFolders } from '../sources/inboxFolders';

import { mediaAttachmentsFor, mediaItemForAsset, insideRoot } from './_ai_media';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, MediaAttachment } from './timeline';
import { textContent, timeframeContains } from './timeline';

// iOS 12-hr: [M/D/YY, H:MM:SS AM] Sender: message
// iOS 24-hr: [M/D/YY, H:MM:SS] Sender: message  (common outside US)
// The space after the colon is optional: when a message's body starts with a
// newline (e.g. some multi-line/quoted messages), the header line ends right
// at the colon with nothing following. Requiring ": " (colon+space) made that
// header fail to match entirely, so it fell through to the continuation-line
// branch and got appended to the PREVIOUS (wrong-sender) message instead of
// starting its own — the source of the cross-sender content merging.
const IOS_RE =
  /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}), (\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?)\] ([^:]+):[ ]?([\s\S]*)$/;
/**
 * The chat's name, from the only place an export records it: the directory.
 *
 * This is IDENTITY, not decoration — every message id is
 * `whatsapp:<conversationName>:<timestamp>:<seq>`, and `Conversation` becomes
 * the thread id. So it has to be the same name however the archive arrived, and
 * it was not: uploading sanitises spaces to underscores, while the inbox keeps
 * the name verbatim. The same export therefore produced
 *
 *   whatsapp:LITA _ Companion Tech Team:2025-12-21T17:58:57.000Z:267          (inbox)
 *   whatsapp:WhatsApp_Chat_-_LITA___Companion_Tech_Team:2026-02-04T…:2683     (upload)
 *
 * — different provenance triples for the same message, so re-importing one
 * export through the other route duplicated all 5,329 messages instead of
 * deduping them, and the two runs disagreed about the thread as well. The old
 * prefix strip contributed: `/^WhatsApp Chat( with| -)?/i` only matches the
 * space-separated form, so the sanitised name kept `WhatsApp_Chat_-_` as part
 * of the chat's own name.
 *
 * Separators are normalised BEFORE the prefix is stripped, so both spellings
 * converge on `LITA Companion Tech Team`.
 *
 * The FILE is consulted before the directory. WhatsApp writes the transcript
 * as the generic `_chat.txt` and puts the chat name on the containing folder,
 * which is the layout the directory rule was written for — and for that layout
 * nothing changes, because `_chat` normalises away to nothing. But WhatsApp's
 * other supported shape, which `recognize` below accepts explicitly, names the
 * FILE after the chat: `WhatsApp Chat with Alice.txt`. Several of those land in
 * one folder, and the directory-first rule gave every one of them the folder's
 * name — a single thread id for every chat in the export, and one identity
 * namespace for every message id. Whichever half of the path actually names the
 * chat has to win, and that is the more specific half.
 *
 * Null when the folder was named by the system rather than by an export (see
 * {@link namedBySystem}). A `_chat.txt` dropped straight into
 * `<inbox>/whatsapp/` was named "whatsapp": every message of the same export
 * uploaded earlier through the wizard was saved a second time under that name
 * and two different chats dropped that way shared one thread. Null too when
 * the folder name is nothing but the exporter's prefix: an upload replaces
 * every non-ASCII character with `_`, so a chat named in another script
 * arrived as `WhatsApp_Chat_-___` and every such chat was called "Chat". The
 * caller names these chats from their transcript instead
 * ({@link conversationNameFromTranscript}).
 */
function conversationNameFrom(chatPath: string): string | null {
  const stripPrefix = (value: string): string =>
    value.replace(/^WhatsApp Chat(\s+(?:with|-))?\s*/i, '').trim();

  // `_chat.txt` — the generic transcript name — normalises to '' and falls
  // through to the directory, which is where that layout keeps the chat name.
  const fromFile = stripPrefix(normaliseName(path.basename(chatPath, '.txt').replace(/_chat/i, '')));
  if (fromFile) {
    return fromFile;
  }

  const directory = path.basename(path.dirname(chatPath));

  if (namedBySystem(directory)) {
    return null;
  }

  return stripPrefix(normaliseName(directory)) || null;
}

function normaliseName(value: string): string {
  // Underscores stand in for characters the exporter or the upload path
  // could not keep, such as the `|` in this corpus's own chat name.
  return value.replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The inbox's service folders (`whatsapp`, `google-takeout`, …): folders the inbox made, not names an export chose. */
const INBOX_SERVICE_FOLDERS = new Set(serviceInboxFolders().map((folder) => folder.toLowerCase()));

/** An import run's scratch folder, named after the run's id. No export names a chat like this. */
const RUN_FOLDER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The zip the import wizard packs loose files into, `<card title> (<n> files).zip`,
 * as it reads once the upload has sanitised and unpacked it (`WhatsApp__3_files_`
 * normalises to `WhatsApp 3 files`). Picking `_chat.txt` and its photos with
 * "Choose files" lands them in one of these. The count changes with every
 * upload of the same chat.
 */
const LOOSE_FILES_FOLDER_RE = /^(?!WhatsApp Chat\b).+ \(?\d+ files\)?$/i;

/**
 * A folder the inbox, an import run or the wizard named, which says nothing
 * about the chat inside it: the inbox's own `whatsapp/`, the run's scratch
 * folder a bare `_chat.txt` is moved into, or the wizard's loose-files zip.
 */
function namedBySystem(directory: string): boolean {
  return (
    INBOX_SERVICE_FOLDERS.has(directory.toLowerCase()) ||
    RUN_FOLDER_RE.test(directory) ||
    LOOSE_FILES_FOLDER_RE.test(normaliseName(directory))
  );
}

const ENCRYPTION_NOTICE_RE = /^Messages and calls are end-to-end encrypted/i;

/** Bidi and direction marks anywhere in a name. WhatsApp wraps a phone number in U+202A and U+202C. */
const INVISIBLE_MARKS_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Characters a filename cannot hold. The exporter writes `_` for them (`LITA | …` became `LITA _ …`). */
const FILENAME_UNSAFE_RE = /[\\/:*?"<>|]/g;

/**
 * The notice's sender spelled the way the folder route spells the same chat.
 * Without this the transcript called the corpus's own chat
 * "LITA | Companion Tech Team" while its zip, uploaded or dropped in the inbox,
 * was "LITA Companion Tech Team", so the two never deduped.
 */
function chatNameFromSender(sender: string): string {
  return normaliseName(sender.replace(INVISIBLE_MARKS_RE, '').replace(FILENAME_UNSAFE_RE, '_'));
}

/**
 * A chat's name from its own transcript, for a `_chat.txt` whose folder does
 * not name the chat.
 *
 * iOS starts every export with WhatsApp's encryption notice, sent "by" the chat
 * itself: `[1/3/21, 9:00:00 AM] Alice: Messages and calls are end-to-end
 * encrypted. …`. That sender is the name the export's zip carries too
 * (`WhatsApp Chat - Alice.zip`), so the chat gets the same identity as an
 * upload of that zip and dedupes against it. A transcript without the notice
 * is named after the people in it, sorted, which at least keeps two different
 * chats in two threads.
 */
async function conversationNameFromTranscript(chatPath: string): Promise<string> {
  const input = fs.createReadStream(chatPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const senders = new Set<string>();

  try {
    for await (const line of rl) {
      // Only the sender and text are read here, so the times need no account zone.
      const parsed = parseWALine(line, undefined);

      if (parsed == null) {
        continue;
      }

      if (senders.size === 0 && ENCRYPTION_NOTICE_RE.test(stripLeadingInvisible(parsed.text))) {
        const name = chatNameFromSender(parsed.sender);

        if (name) {
          return name;
        }
      }

      senders.add(parsed.sender);
    }
  } finally {
    rl.close();
    // Closing readline does not close its input. Returning at the notice left
    // the stream paused on its first chunk with the file still open, one
    // descriptor per chat for the life of the process.
    input.destroy();
  }

  return [...senders].sort().join(', ') || 'Chat';
}

// Android: DD/MM/YYYY, HH:MM - Sender: message
const ANDROID_RE = /^(\d{2}\/\d{2}\/\d{4}), (\d{2}:\d{2}) - ([^:]+):[ ]?([\s\S]*)$/;

// WhatsApp's iOS export prefixes many lines — overwhelmingly the ones
// announcing an attachment or "omitted" media — with an invisible U+200E
// (LEFT-TO-RIGHT MARK) before the leading '['. IOS_RE/ANDROID_RE anchor on a
// literal opening character at line start, so an unstripped mark makes the
// header fail to match entirely, and the line falls through to the
// continuation branch and gets appended onto the PREVIOUS (wrong-sender)
// message. Strip a leading run of zero-width/bidi control marks once per
// line, before matching, rather than loosening the anchored regexes
// themselves (loosening risks new false-positive matches).
// U+200E/U+200F (LTR/RTL mark), U+202A-U+202E (bidi embed/override), and
// U+2066-U+2069 (bidi isolate) — the zero-width/bidi control marks WhatsApp
// (and other chat apps) sprinkle around punctuation for RTL-safe rendering.
const LEADING_INVISIBLE_RE = /^[‎‏‪-‮⁦-⁩]+/;
function stripLeadingInvisible(line: string): string {
  return line.replace(LEADING_INVISIBLE_RE, '');
}

interface ParsedLine {
  ts: Date | undefined;
  /**
   * What `new Date(…)` made of the header on this server, which is what
   * {@link ParsedLine.ts} was before it moved to the account's zone. Only the
   * message id uses it. The id carries a time, so an id built from `ts` would
   * change for every message of a chat imported before. Importing a newer
   * export of that chat (WhatsApp exports are cumulative) would then save every
   * old message a second time. Changing the profile's zone later can't fork it
   * either.
   *
   * It runs the old expression itself rather than re-reading the wall clock in
   * `serverTimezone()`. The two disagree: a `TZ` that ICU can't name (such as
   * `:/etc/localtime`) reports no zone, which `serverTimezone()` turns into UTC
   * while `Date` still reads the host's clock. The repeated fall-back hour east
   * of UTC also resolves the other way, so those ids would fork too.
   */
  idTime: Date | undefined;
  sender: string;
  text: string;
}

/** `d`, or undefined when it is an Invalid Date. */
function dated(d: Date): Date | undefined {
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Out-of-range fields leave the line undated, with two edges. A day past a
 * short month's end (2/30) rolls into the next month, as `new Date` did.
 * `24:00`, which `new Date` read as the next day's midnight, is undated here.
 * Neither appears in a real export.
 */
function validWallClock(w: WallClock): WallClock | undefined {
  if (
    w.month < 1 ||
    w.month > 12 ||
    w.day < 1 ||
    w.day > 31 ||
    w.hour > 23 ||
    w.minute > 59 ||
    w.second > 59
  ) {
    return undefined;
  }

  return w;
}

const IOS_TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s?([AP]M)?$/;

/** iOS `M/D/YY` (or `M/D/YYYY`) and `H:MM[:SS][ AM|PM]`. */
function iosWallClock(date: string, time: string): WallClock | undefined {
  const [month, day, rawYear] = date.split('/').map(Number);
  const t = IOS_TIME_RE.exec(time.trim());

  if (t == null) {
    return undefined;
  }

  let hour = Number(t[1]);

  if (t[4] === 'PM' && hour < 12) {
    hour += 12;
  } else if (t[4] === 'AM' && hour === 12) {
    hour = 0;
  }

  // Two-digit years as `new Date` read them: 00-49 are 20xx, 50-99 are 19xx.
  const year = rawYear < 100 ? rawYear + (rawYear < 50 ? 2000 : 1900) : rawYear;

  return validWallClock({ year, month, day, hour, minute: Number(t[2]), second: Number(t[3] ?? 0) });
}

/** Android `DD/MM/YYYY` and `HH:MM`. */
function androidWallClock(date: string, time: string): WallClock | undefined {
  const [day, month, year] = date.split('/').map(Number);
  const [hour, minute] = time.split(':').map(Number);

  return validWallClock({ year, month, day, hour, minute, second: 0 });
}

/**
 * One header line, with its time read in `accountZone`.
 *
 * Neither platform writes a zone or an offset: the times are what the phone's
 * clock read. They used to go through `new Date(…)`, which reads them in the
 * SERVER's zone. The same chat landed at different instants on different
 * machines. In a UTC container a Pacific account's midnight New Year messages
 * sat at 4 PM on Dec 31. The importer is told the account's zone
 * (`ImportParams.timeZone`) and stores them there. Without one, the stored
 * time stays the server's reading, the same instant the id carries.
 */
function parseWALine(line: string, accountZone: string | undefined): ParsedLine | null {
  const cleaned = stripLeadingInvisible(line);
  let wall: WallClock | undefined;
  let idTime: Date | undefined;
  let m = IOS_RE.exec(cleaned);

  if (m) {
    wall = iosWallClock(m[1], m[2]);
    idTime = dated(new Date(`${m[1]} ${m[2]}`));
  } else {
    m = ANDROID_RE.exec(cleaned);

    if (m == null) {
      return null;
    }

    // DD/MM/YYYY as an ISO local date-time, exactly as the old code built it.
    const [day, month, year] = m[1].split('/');

    wall = androidWallClock(m[1], m[2]);
    idTime = dated(new Date(`${year}-${month}-${day}T${m[2]}:00`));
  }

  return {
    ts: accountZone == null ? idTime : wall && wallClockToUTC(wall, accountZone),
    idTime,
    sender: m[3].trim(),
    text: m[4],
  };
}

const SYSTEM_VERB_RE =
  /^(Messages and calls are end-to-end encrypted|.+ (added|removed|left|created group|changed|deleted|updated))/i;

/**
 * True only for a line WhatsApp wrote itself.
 *
 * `SYSTEM_VERB_RE` alone is right-unbounded: `.+ (added|removed|left|…)` matches
 * those words ANYWHERE in a body, so ordinary prose was being destroyed —
 * "everybody just LEFT the house", "I CHANGED the copyright", "there is a
 * RS-232 cable … for reading from the LEFT side elevator motherboard". Measured
 * on one real 5,254-message export: 94 lines matched, of which only 41 were
 * system lines and 53 were human messages, 7,901 characters of them.
 *
 * WhatsApp prefixes every line it generates with U+200E LEFT-TO-RIGHT MARK, and
 * a typed message never carries one — 41/41 of the genuine system lines were
 * marked and 0/53 of the human messages were. The marker is NOT sufficient on
 * its own: it also sits on every `image omitted` placeholder and every
 * `<attached: …>` reference, which must be kept. So both conditions are
 * required, and each covers the other's failure.
 */
function isSystemLine(text: string): boolean {
  return LEADING_INVISIBLE_RE.test(text) && SYSTEM_VERB_RE.test(text);
}

// Shared-location messages embed a maps link, e.g.
//   "location: https://maps.google.com/?q=37.7749,-122.4194"
//   "https://maps.google.com/maps/@37.77,-122.41,15z"
// Pull the first lat,long pair out of such a link so the pin lands on the map.
const GEO_RE = /(?:[?&]q=|maps\/@|\/@|q=loc:)(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/i;
function parseSharedLocation(text: string): { latitude: number; longitude: number } | undefined {
  if (!/location|maps\.|maps\?|maps\//i.test(text)) {
    return undefined;
  }

  const m = GEO_RE.exec(text);
  if (!m) {
    return undefined;
  }

  const latitude = parseFloat(m[1]);
  const longitude = parseFloat(m[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return undefined;
  }

  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return undefined;
  }

  return { latitude, longitude };
}

// A message whose body references an attached file — the bytes live
// alongside _chat.txt in the same export directory, but WhatsApp's exporter
// never puts the media inline; it only leaves a text marker in the transcript:
//   iOS:     "<attached: 00000048-PHOTO-2026-05-08-08-35-29.jpg>"
//   Android: "IMG-20260508-WA0001.jpg (file attached)"
// The two platforms use different markers, so both are checked.
const IOS_ATTACHED_RE = /<attached:\s*([^>]+?)>/i;
const ANDROID_ATTACHED_RE = /([^\s<>]+)\s+\(file attached\)/i;
function attachedFilename(text: string): string | undefined {
  const iosMatch = IOS_ATTACHED_RE.exec(text);
  if (iosMatch) {
    return iosMatch[1].trim();
  }

  const androidMatch = ANDROID_ATTACHED_RE.exec(text);
  if (androidMatch) {
    return androidMatch[1].trim();
  }

  return undefined;
}

export class WhatsAppFileImporter implements FileImporter {
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
      const base = path.basename(root).toLowerCase();
      if (base === '_chat.txt') {
        return { confidence: 0.97 };
      }

      if (base.startsWith('whatsapp chat') && base.endsWith('.txt')) {
        return { confidence: 0.95 };
      }

      return { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        const names = (await readdir(root)).map((n) => n.toLowerCase());
        if (names.includes('_chat.txt')) {
          return { confidence: 0.97 };
        }

        if (names.some((n) => n.startsWith('whatsapp chat') && n.endsWith('.txt'))) {
          return { confidence: 0.95 };
        }
      } catch {
        /* ignore */
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return;
    }

    let chatPaths: string[] = [root];
    try {
      if (fs.statSync(root).isDirectory()) {
        const names = fs.readdirSync(root);
        const canonical = names.find((n) => n.toLowerCase() === '_chat.txt');
        // A `_chat.txt` is WhatsApp's single-chat export directory, so it is
        // the whole conversation and nothing else in the folder is a
        // transcript. Otherwise every `WhatsApp Chat …txt` sibling is its own
        // chat — `find` imported only the FIRST and silently discarded the
        // rest, which is a whole conversation lost per extra file.
        chatPaths = canonical
          ? [path.join(root, canonical)]
          : // sorted so the emission order does not depend on readdir order
            names
              .filter((n) => /^whatsapp chat/i.test(n) && n.endsWith('.txt'))
              .sort()
              .map((n) => path.join(root, n));
        if (!chatPaths.length) {
          return;
        }
      }
    } catch {
      return;
    }

    for (const chatPath of chatPaths) {
      await this.importChat(chatPath, params);
    }
  }

  private async importChat(chatPath: string, params: ImportParams): Promise<void> {
    const conversationName =
      conversationNameFrom(chatPath) ?? (await conversationNameFromTranscript(chatPath));

    // Attached media sits next to _chat.txt in the same export directory.
    const mediaDir = path.dirname(chatPath);

    const rl = readline.createInterface({
      input: fs.createReadStream(chatPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    let current: ParsedLine | null = null;
    let seq = 0;
    // How many logical messages this chat actually offered the parser — the
    // floor `reconciled` checks every produced/dropped message against.
    // Counted per flush(), not per physical line: a multi-line message folds
    // several lines into one ParsedLine before it ever reaches here.
    let total = 0;

    const flush = (p: ParsedLine) => {
      total++;

      if (!timeframeContains(params.timeframe, p.ts)) {
        params.pipeline.drop?.('outside_timeframe');

        return;
      }

      if (isSystemLine(p.text)) {
        // Counted, not silent. The bare `return` here reported `dropped: 0` and
        // `reconciled: true` while discarding rows — and because it sits above
        // the attachment block, a photo whose caption tripped the old regex lost
        // its bytes with no record either.
        params.pipeline.drop?.('whatsapp_system_line');

        return;
      }

      const loc = parseSharedLocation(p.text);

      // Resolve an attached-file reference to the sibling file on disk and
      // emit it as its own 'media' item (the text item below still carries
      // the transcript line, e.g. "<attached: X.jpg>", so nothing about the
      // original message is lost — this only adds the actual bytes).
      //
      // The message ALSO carries the resolved file as a `MediaAttachments`
      // descriptor, which is what links the two. Without it the export produced
      // two unrelated rows: a `ci.files` blob with no idea which message it
      // arrived in, and a message whose whole body was the placeholder
      // "<attached: X.jpg>" and whose `attachments` column was empty. The media
      // leg uploads both paths, but they are the same bytes, so the object
      // store's content hash resolves them onto ONE file — the attachment costs
      // no storage and the message gains the reference.
      //
      // Deliberately no `AttachmentContent`: unlike Messenger, this file is
      // already a standalone media item, so it already catalogues itself. Opting
      // in would mint a SECOND ci.content row over the same bytes.
      let attachments: MediaAttachment[] = [];
      const attached = attachedFilename(p.text);
      if (attached) {
        // A referenced attachment is a SECOND thing this flush offers the
        // parser beyond the message itself, and every branch below resolves
        // it to exactly one push() (a media item) or one drop() — so it gets
        // its own unit here too, or `produced + dropped` runs ahead of
        // `consumed` by one for every message that carries an attachment.
        total++;
        // path.basename strips any directory components the reference might
        // (maliciously or accidentally) contain, so the resolved path can
        // never escape mediaDir.
        const base = path.basename(attached);
        const abs = path.join(mediaDir, base);
        if (base && insideRoot(mediaDir, abs) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          const mediaItem = mediaItemForAsset(
            `whatsapp:media:${conversationName}`,
            'WhatsApp',
            { abs, relKey: path.relative(mediaDir, abs) },
            p.ts,
            { Sender: p.sender, Conversation: conversationName },
          );
          if (mediaItem) {
            attachments = mediaAttachmentsFor([mediaItem]);
            params.pipeline.push({
              item: mediaItem,
              edges: p.sender
                ? [{ relation: 'participant', to: { entity: { type: 'contact', name: p.sender } } }]
                : [],
            });
          } else {
            // Referenced file exists but isn't a photo/video (e.g. a .vcf
            // contact card or .opus voice note) — out of scope for a media
            // item; report it rather than silently doing nothing.
            params.pipeline.drop?.('whatsapp_attachment_unsupported', base);
          }
        } else {
          // Real export referenced a file that isn't sitting next to
          // _chat.txt (export truncated, media stripped before sharing,
          // etc.) — report the loss instead of silently dropping it.
          params.pipeline.drop?.('whatsapp_attachment_missing', base || attached);
        }
      }

      params.pipeline.push({
        item: {
          id: `whatsapp:${conversationName}:${p.idTime ? p.idTime.toISOString() : 'noTs'}:${seq++}`,
          classification: loc ? 'location' : 'message',
          timestamp: p.ts,
          ...(loc && { location: loc }),
          content: textContent('_chat.txt', p.text),
          metadata: {
            Sender: p.sender,
            Conversation: conversationName,
            Source: 'WhatsApp',
            // Surface the body in metadata so the canonical mapping (descriptionFor)
            // carries it through to CI-Server; otherwise it only lives in content.data.
            Text: p.text || undefined,
            ...(loc && { Location: `${loc.latitude}, ${loc.longitude}` }),
            ...(attachments.length > 0 && { MediaAttachments: attachments }),
          },
        },
        // Link the message to whoever sent it, so the graph view gets a real
        // item↔entity edge. The sender name matches imported contacts (vCard) by
        // name when present, otherwise a lightweight contact entity is created.
        edges: p.sender
          ? [{ relation: 'participant', to: { entity: { type: 'contact', name: p.sender } } }]
          : [],
      });
    };

    for await (const line of rl) {
      const parsed = parseWALine(line, params.timeZone);
      if (parsed) {
        if (current) {
          flush(current);
        }

        current = parsed;
      } else if (current) {
        current.text += '\n' + line;
      }
    }

    if (current) {
      flush(current);
    }

    params.pipeline.consumed?.(total);
  }
}

registerDataSource({
  name: 'whatsapp',
  title: 'WhatsApp',
  icon: '',
  description: 'Per-chat WhatsApp message exports (text + media).',
  newFileImporter: () => new WhatsAppFileImporter(),
});
