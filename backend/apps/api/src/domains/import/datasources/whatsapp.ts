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
 * The AM or PM of a 12-hour header as phones outside the US write it too:
 * lowercase (`10:02 am`, English in India or Australia), with dots (`a.m.`,
 * `p. m.`) and after a narrow or ordinary no-break space, which `\s` matches.
 * {@link IOS_RE} and {@link ANDROID_12H_RE} take only `AM` and `PM`.
 */
const ANY_MARKER = String.raw`[AaPp]\.?\s?[Mm]\.?`;

/** {@link IOS_RE} with {@link ANY_MARKER}. */
const IOS_ANY_MARKER_RE = new RegExp(
  String.raw`^\[(\d{1,2}\/\d{1,2}\/\d{2,4}), (\d{1,2}:\d{2}(?::\d{2})?(?:\s?${ANY_MARKER})?)\] ([^:]+):[ ]?([\s\S]*)$`,
);

/** A header's time with {@link ANY_MARKER}, split into the clock and the marker's first letter. */
const ANY_MARKER_TIME_RE = new RegExp(String.raw`^(\d{1,2}:\d{2}(?::\d{2})?)\s?(?:([AaPp])\.?\s?[Mm]\.?)?$`);

/** A time written with {@link ANY_MARKER} as `H:MM[:SS] AM`, the shape `new Date` and {@link iosWallClock} read. */
function normalisedTime(time: string): string {
  const m = ANY_MARKER_TIME_RE.exec(time.trim());

  if (m == null) {
    return time;
  }

  return m[2] ? `${m[1]} ${m[2].toUpperCase()}M` : m[1];
}

/** A day-first `D/M/Y` date as `M/D/Y`, the order `new Date` and {@link iosWallClock} read. */
function monthFirst(date: string): string {
  const [day, month, year] = date.split('/');

  return `${month}/${day}/${year}`;
}

/**
 * The time in the ids of a file read with {@link ANY_MARKER_SHAPES}: the date's
 * numbers as written and the clock on 24 hours, as `14-11-26T19:15`. No such
 * file was saved before, so its ids need no old reading. These read neither
 * the date order nor a zone: a newer export of the chat whose dates settle the
 * order the other way, or an import on a server in another zone, gives every
 * message the same id. Undefined when the time doesn't read.
 */
function writtenIdTime(date: string, time: string): string | undefined {
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?: ([AP])M)?$/.exec(normalisedTime(time));

  if (t == null) {
    return undefined;
  }

  let hour = Number(t[1]);

  if (t[4] === 'P' && hour < 12) {
    hour += 12;
  } else if (t[4] === 'A' && hour === 12) {
    hour = 0;
  }

  const two = (n: number | string) => String(n).padStart(2, '0');
  const [first, second, year] = date.split('/');

  return `${two(first)}-${two(second)}-${year}T${two(hour)}:${t[2]}${t[3] ? `:${t[3]}` : ''}`;
}

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
async function conversationNameFromTranscript(chatPath: string, format: ChatFormat): Promise<string> {
  const input = fs.createReadStream(chatPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const senders = new Set<string>();

  try {
    for await (const line of rl) {
      // Only the sender and text are read here, so the times need no account zone.
      const parsed = parseWALine(line, undefined, format);

      if (parsed == null || parsed.system) {
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
// The sender is split off afterwards ({@link androidSender}): the lines
// WhatsApp writes itself have the same header and no sender.
const ANDROID_RE = /^(\d{2}\/\d{2}\/\d{4}), (\d{2}:\d{2}) - ([\s\S]*)$/;

// Android with a 12-hour clock, as in US English: M/D/YY, H:MM AM - Sender:
// message. Newer phones put a U+202F NARROW NO-BREAK SPACE before AM/PM, which
// `\s` matches. Some phones write the day first; see {@link chatFormat}.
const ANDROID_12H_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}), (\d{1,2}:\d{2}\s[AP]M) - ([\s\S]*)$/;

/** {@link ANDROID_12H_RE} with {@link ANY_MARKER} and a four-digit year as well: `14/11/2026, 7:15 pm - `. */
const ANDROID_12H_ANY_MARKER_RE = new RegExp(
  String.raw`^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4}), (\d{1,2}:\d{2}\s?${ANY_MARKER}) - ([\s\S]*)$`,
);

/** The header patterns a chat's file is read with. */
interface HeaderShapes {
  ios: RegExp;
  android12h: RegExp;
  anyMarker: boolean;
}

/**
 * The patterns every saved message id comes from. A file whose first header is
 * in one of these shapes is read with them, so it keeps the ids it was saved
 * with.
 */
const STRICT_SHAPES: HeaderShapes = { ios: IOS_RE, android12h: ANDROID_12H_RE, anyMarker: false };

/**
 * For a file whose first header is in a shape only these read. Such a file
 * imported nothing, or only from a line pasted into it, so no saved id is
 * worth keeping its reading for. Inside a strict file a line in one of these
 * shapes is text someone pasted into a message, as it always was.
 */
const ANY_MARKER_SHAPES: HeaderShapes = {
  ios: IOS_ANY_MARKER_RE,
  android12h: ANDROID_12H_ANY_MARKER_RE,
  anyMarker: true,
};

/** The kind of header a chat's file is written in, plus the order of its dates. */
interface ChatFormat {
  kind: 'ios' | 'android' | 'android12h' | undefined;
  /** For a 12-hour Android or an iPhone export: its dates are written day first. */
  dayFirst: boolean;
  /** Read with {@link ANY_MARKER_SHAPES}. */
  anyMarker: boolean;
}

/** A two-digit year as `new Date` reads it: 00-49 are 20xx, 50-99 are 19xx. */
function fullYear(year: number): number {
  return year < 100 ? year + (year < 50 ? 2000 : 1900) : year;
}

/** Days since the epoch of a 12-hour Android date read one way or the other. */
function androidDay(first: number, second: number, year: number, dayFirst: boolean): number {
  const [day, month] = dayFirst ? [first, second] : [second, first];

  return Date.UTC(fullYear(year), month - 1, day) / 86_400_000;
}

/**
 * The kind of header a chat is written in, from its first header: an export
 * is written in one kind throughout. In another kind of export a line in the
 * new Android shapes is text someone pasted into a message. It is read the
 * way it always was ({@link parseWALine}).
 *
 * The first header also picks the patterns. A file that starts in the strict
 * shapes ({@link STRICT_SHAPES}) is read with them, as it always was, so a
 * lowercase line pasted into it stays text. One that starts in a shape only
 * {@link ANY_MARKER_SHAPES} reads is read with those, so a line pasted into it
 * in the strict shapes doesn't decide how the whole chat is read.
 *
 * A 12-hour Android or an iPhone date doesn't say whether the day or the month
 * comes first: `05/11/26, 9:31 PM` is May 11 on a US phone and November 5 on
 * many others. The first date with a number above 12 settles it. Until one
 * does, the dates are read both ways and the way that keeps them closer
 * together wins: a chat from 05/11/26 to 07/11/26 spans two days read day
 * first and two months read month first. A file that never changes date is
 * read month first, the US order.
 *
 * An iPhone export in the strict shapes was always read month first. It is
 * read day first only when a date in it can't be month first and none can't
 * be day first, so a day-first header pasted into a US chat doesn't turn the
 * chat's own dates around. One that never settles it is read month first.
 *
 * Reading stops at the header that settles the order, or at a 24-hour Android
 * header that comes first.
 */
async function chatFormat(chatPath: string): Promise<ChatFormat> {
  const input = fs.createReadStream(chatPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let scan: FormatScan | undefined;

  try {
    for await (const line of rl) {
      const cleaned = stripLeadingInvisible(line);

      if (scan == null) {
        if (
          STRICT_SHAPES.ios.test(cleaned) ||
          STRICT_SHAPES.android12h.test(cleaned) ||
          ANDROID_RE.test(cleaned)
        ) {
          scan = new FormatScan(STRICT_SHAPES);
        } else if (ANY_MARKER_SHAPES.ios.test(cleaned) || ANY_MARKER_SHAPES.android12h.test(cleaned)) {
          scan = new FormatScan(ANY_MARKER_SHAPES);
        } else {
          continue;
        }
      }

      scan.read(cleaned);

      if (scan.settled) {
        return scan.settled;
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }

  return scan?.result() ?? { kind: undefined, dayFirst: false, anyMarker: false };
}

/** {@link chatFormat} for one set of patterns, fed one line at a time. */
class FormatScan {
  private kind: 'ios' | 'android12h' | undefined;

  private previous: [number, number, number] | undefined;

  private spanMonthFirst = 0;

  private spanDayFirst = 0;

  /** A strict iPhone date that can only be day first, which a later month-first one overrules. */
  private dayFirstSeen = false;

  /** The format, once a line has settled it. */
  settled: ChatFormat | undefined;

  constructor(private readonly shapes: HeaderShapes) {}

  /** Reads one line, its leading marks already stripped. */
  read(cleaned: string): void {
    if (this.settled) {
      return;
    }

    const { anyMarker } = this.shapes;
    let date: [number, number, number] | undefined;

    if (this.kind !== 'ios') {
      const m = this.shapes.android12h.exec(cleaned);

      if (m) {
        this.kind = 'android12h';
        date = [Number(m[1]), Number(m[2]), Number(m[3])];
      }
    }

    if (date == null && this.kind !== 'android12h') {
      const m = this.shapes.ios.exec(cleaned);

      if (m) {
        this.kind = 'ios';
        date = m[1].split('/').map(Number) as [number, number, number];
      } else if (this.kind == null && ANDROID_RE.test(cleaned)) {
        this.settled = { kind: 'android', dayFirst: false, anyMarker };

        return;
      }
    }

    if (date == null) {
      return;
    }

    if (date[1] > 12) {
      this.settled = { kind: this.kind, dayFirst: false, anyMarker };

      return;
    }

    if (date[0] > 12) {
      if (this.kind === 'ios' && !anyMarker) {
        this.dayFirstSeen = true;

        return;
      }

      this.settled = { kind: this.kind, dayFirst: true, anyMarker };

      return;
    }

    if (this.previous) {
      this.spanMonthFirst += Math.abs(androidDay(...date, false) - androidDay(...this.previous, false));
      this.spanDayFirst += Math.abs(androidDay(...date, true) - androidDay(...this.previous, true));
    }

    this.previous = date;
  }

  /** The format after the last line, or undefined when no line had a header in these patterns. */
  result(): ChatFormat | undefined {
    if (this.settled || this.kind == null) {
      return this.settled;
    }

    const { anyMarker } = this.shapes;
    const dayFirst =
      this.kind === 'ios' && !anyMarker ? this.dayFirstSeen : this.spanDayFirst < this.spanMonthFirst;

    return { kind: this.kind, dayFirst, anyMarker };
  }
}

/** `Sender: message`, split at the first colon: how Android lines were always read. */
const SENDER_RE = /^([^:]+):[ ]?([\s\S]*)$/;

/** The same, except that a colon inside double quotes doesn't end the sender. */
const QUOTED_SENDER_RE = /^((?:[^:"]|"[^"]*")+):[ ]?([\s\S]*)$/;

interface Said {
  sender: string;
  text: string;
}

/** The text after an Android header split at its first colon ({@link SENDER_RE}), or null when it has none. */
function firstColonSplit(rest: string): Said | null {
  const m = SENDER_RE.exec(rest);

  return m && { sender: m[1], text: m[2] };
}

/**
 * The sender and text after an Android header, or null for a line WhatsApp
 * wrote itself, which has no sender: `Robin Hale added Casey Moreno`.
 * `firstColon` is `rest` split the old way ({@link firstColonSplit}).
 *
 * WhatsApp puts a group's name in double quotes in those lines. A name may
 * hold a colon. Split at the first colon, `Robin Hale created group "Trip:
 * Lisbon"` became a message from `Robin Hale created group "Trip`. So a colon
 * inside quotes doesn't end the sender. When a line's quotes don't pair up,
 * they can't be read that way and the first colon ends it, as before.
 */
function androidSender(rest: string, firstColon: Said | null): Said | null {
  if (firstColon == null) {
    return null;
  }

  if (firstColon.sender.includes('"') && rest.split('"').length % 2 === 1) {
    const quoted = QUOTED_SENDER_RE.exec(rest);

    return quoted && { sender: quoted[1], text: quoted[2] };
  }

  return firstColon;
}

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
   *
   * For the same reason a strict iPhone export written day first keeps the
   * month first reading here, which is all the old code had: a date past the
   * 12th leaves the id at `noTs`. Only {@link ParsedLine.ts} reads the file's
   * own order.
   */
  idTime: Date | undefined;
  /**
   * For a file read with {@link ANY_MARKER_SHAPES}, the time its message ids
   * carry instead of {@link ParsedLine.idTime}: the date as written and the
   * clock on 24 hours ({@link writtenIdTime}).
   */
  idKey?: string;
  sender: string;
  text: string;
  /**
   * A line WhatsApp wrote itself, which an Android export writes with no
   * sender (`14/11/2026, 10:02 - Robin Hale added Casey Moreno`). It is
   * dropped along with the lines under it.
   */
  system?: boolean;
  /**
   * For a `system` line: the old pattern read it as a message, which took a
   * sequence number. Only a day-first line with a colon in a quoted name was
   * read that way. The others were added to the message before them or not
   * read at all.
   */
  savedBefore?: boolean;
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

  return validWallClock({
    year: fullYear(rawYear),
    month,
    day,
    hour,
    minute: Number(t[2]),
    second: Number(t[3] ?? 0),
  });
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
 * time stays the server's reading, the same instant the id carries. A
 * day-first iPhone date is the exception: the id keeps the old month-first
 * reading ({@link ParsedLine.idTime}).
 *
 * `format` is the file's own ({@link chatFormat}). A 12-hour header, or an
 * Android header with no sender, is a header only in an Android export of its
 * own kind. Anywhere else it is a line pasted into a message and stays part of
 * that message, as it always did: reading it as a header would give every
 * message after it a new id. A 12-hour export reads only its own headers. An
 * iPhone or 24-hour line in one was pasted there too, and no 12-hour export was
 * read before, so no id depends on reading it as a header.
 */
function parseWALine(line: string, accountZone: string | undefined, format: ChatFormat): ParsedLine | null {
  const cleaned = stripLeadingInvisible(line);
  let wall: WallClock | undefined;
  let idTime: Date | undefined;
  let idKey: string | undefined;
  // What `new Date` makes of the header read in the file's own date order. The
  // stored time when the account has no zone.
  let serverTime: Date | undefined;
  let said: Said | null;
  let rest = '';
  let firstColon: Said | null = null;
  const shapes = format.anyMarker ? ANY_MARKER_SHAPES : STRICT_SHAPES;
  const twelveHour = format.kind === 'android12h';
  const ios = twelveHour ? null : shapes.ios.exec(cleaned);
  const android = twelveHour || ios ? null : ANDROID_RE.exec(cleaned);
  const android12h = twelveHour ? shapes.android12h.exec(cleaned) : null;

  if (ios) {
    const date = format.kind === 'ios' && format.dayFirst ? monthFirst(ios[1]) : ios[1];
    const time = format.anyMarker ? normalisedTime(ios[2]) : ios[2];

    wall = iosWallClock(date, time);
    serverTime = dated(new Date(`${date} ${time}`));
    // The ids of a strict file read every date month first, as the old code
    // did, so a day-first date past the 12th still gives `noTs`. Importing a
    // newer export of a chat saved back then must find the same ids.
    idTime = dated(new Date(`${ios[1]} ${ios[2]}`));
    idKey = format.anyMarker ? writtenIdTime(ios[1], ios[2]) : undefined;
    said = { sender: ios[3], text: ios[4] };
  } else if (android) {
    // DD/MM/YYYY as an ISO local date-time, exactly as the old code built it.
    const [day, month, year] = android[1].split('/');

    wall = androidWallClock(android[1], android[2]);
    idTime = dated(new Date(`${year}-${month}-${day}T${android[2]}:00`));
    serverTime = idTime;
    rest = android[3];
    firstColon = firstColonSplit(rest);

    if (format.kind !== 'android' && firstColon == null) {
      return null;
    }

    said = format.kind === 'android' ? androidSender(rest, firstColon) : firstColon;
  } else if (android12h) {
    // As M/D/YY, the order the iPhone's dates are read in.
    const [first, second, year, written] = android12h.slice(1, 5);
    const date = format.dayFirst ? `${second}/${first}/${year}` : `${first}/${second}/${year}`;
    const time = format.anyMarker ? normalisedTime(written) : written;

    wall = iosWallClock(date, time);
    idTime = dated(new Date(`${date} ${time}`));
    idKey = format.anyMarker ? writtenIdTime(`${first}/${second}/${year}`, written) : undefined;
    serverTime = idTime;
    rest = android12h[5];
    said = androidSender(rest, firstColonSplit(rest));
  } else {
    return null;
  }

  const ts = accountZone == null ? serverTime : wall && wallClockToUTC(wall, accountZone);

  if (said == null) {
    // The old pattern read only day-first lines and split them at the first
    // colon, so one of those with a colon was a message.
    const savedBefore = android != null && firstColon != null;

    return { ts, idTime, idKey, sender: '', text: rest, system: true, savedBefore };
  }

  return { ts, idTime, idKey, sender: said.sender.trim(), text: said.text };
}

const SYSTEM_VERB_RE =
  /^(Messages and calls are end-to-end encrypted|.+ (added|removed|left|created group|changed|deleted|updated))/i;

/**
 * The system-line pattern as it was used while the encryption notice was still
 * saved: on the raw text, marker in front. Every marked line it missed was
 * saved as a message and took a sequence number. `flush` reads it so such a
 * line, dropped now, still takes that number and the ids after it stay where
 * they were. A literal copy on purpose: when `SYSTEM_VERB_RE` learns another
 * notice, this must not follow, or the ids would move again.
 */
const LEGACY_SYSTEM_VERB_RE =
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
 *
 * The verb pattern reads the text after the marker. Its notice alternative is
 * anchored (`^Messages and calls…`), so with the marker still in front it
 * never matched. Every iPhone export saved the encryption notice as a message
 * from the other person, or in a group from the group. The `.+` alternative
 * matched either way, because `.+` took the marker along with the name.
 */
function isSystemLine(text: string): boolean {
  return LEADING_INVISIBLE_RE.test(text) && SYSTEM_VERB_RE.test(stripLeadingInvisible(text));
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
    const format = await chatFormat(chatPath);
    const conversationName =
      conversationNameFrom(chatPath) ?? (await conversationNameFromTranscript(chatPath, format));

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

      if (p.system || isSystemLine(p.text)) {
        // Counted, not silent. The bare `return` here reported `dropped: 0` and
        // `reconciled: true` while discarding rows — and because it sits above
        // the attachment block, a photo whose caption tripped the old regex lost
        // its bytes with no record either.
        params.pipeline.drop?.('whatsapp_system_line');

        // A line the old check let through (the iPhone encryption notice, an
        // Android line with a colon in a quoted group name) was saved as a
        // message and took a number. It still takes one. The ids after it end
        // in that number: if they moved down by one, importing a chat that was
        // imported back then would save every message in it a second time.
        // No other Android system line ever took one.
        if (p.system ? p.savedBefore : !LEGACY_SYSTEM_VERB_RE.test(p.text)) {
          seq++;
        }

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
          id: `whatsapp:${conversationName}:${p.idKey ?? (p.idTime ? p.idTime.toISOString() : 'noTs')}:${seq++}`,
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

    let unread = false;

    for await (const line of rl) {
      const parsed = parseWALine(line, params.timeZone, format);
      if (parsed) {
        if (current) {
          flush(current);
        }

        current = parsed;
      } else if (current) {
        current.text += '\n' + line;
      } else if (line.trim()) {
        unread = true;
      }
    }

    if (current) {
      flush(current);
    } else if (unread) {
      // Not one line read as a header: the file is in a shape this parser
      // doesn't know. Counted, so the run says so instead of finishing as a
      // clean import of nothing.
      total++;
      params.pipeline.drop?.('whatsapp_no_header', path.basename(chatPath));
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
