/* Facebook — "Download Your Information" export. Imports Messenger threads
 * (every thread lane under messages/ — inbox, filtered_threads,
 * message_requests, archived_threads, e2ee_cutover; see threadLaneDirs) and
 * Posts (posts/), including their attached photos/videos,
 * plus the HTML-format equivalents nested under your_facebook_activity/. Does
 * NOT cover friends/connections, events, comments_and_reactions, groups,
 * marketplace, or logged_information/personal_information/preferences (location
 * history, search history, off-Facebook activity, ads). */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { htmlToText as sharedHtmlToText } from './htmlToText';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Metadata } from './timeline';
import { mimeForFile, timeframeContains } from './timeline';

// A media attachment in a Messenger message or a post. The `uri` is a path
// RELATIVE to the export root (e.g. "messages/inbox/<thread>/photos/x.jpg").
interface FBMediaRef {
  uri?: string;
  creation_timestamp?: number;
}
interface FBMessage {
  sender_name?: string;
  timestamp_ms?: number;
  content?: string;
  share?: { link?: string };
  is_unsent?: boolean;
  // Attachment buckets. All are arrays except `sticker`, which Meta emits as a
  // single object ({ uri, ai_stickers }). Every one of them becomes an
  // attachment on the message — see messageAttachmentUris.
  photos?: FBMediaRef[];
  videos?: FBMediaRef[];
  gifs?: FBMediaRef[];
  audio_files?: FBMediaRef[];
  files?: FBMediaRef[];
  sticker?: FBMediaRef;
}
interface FBThread {
  participants?: Array<{ name?: string }>;
  messages?: FBMessage[];
  title?: string;
}
interface FBPostData {
  post?: string;
}
// Posts carry media under attachments[].data[].media.
interface FBAttachmentDatum {
  media?: FBMediaRef;
}
interface FBAttachment {
  data?: FBAttachmentDatum[];
}
interface FBLabelValue {
  label?: string;
  value?: string;
  timestamp_value?: number;
}
interface FBPost {
  data?: FBPostData[];
  timestamp?: number;
  title?: string;
  attachments?: FBAttachment[];
  label_values?: FBLabelValue[];
}

/* ---- JSON-format mojibake repair -------------------------------------------
 * Facebook DYI JSON files serialise all non-ASCII text as raw UTF-8 BYTES, each
 * escaped as a separate \u00XX code point. JSON.parse therefore yields Latin-1
 * mojibake: "😊" arrives as "ð" ("ð"), "é" as "Ã©".
 * Re-encoding those code points as Latin-1 bytes and decoding them as UTF-8
 * recovers the original text. Guarded so correct text is never touched: a
 * string with any code point above 0xFF is already real Unicode, and a decode
 * that produces U+FFFD wasn't UTF-8 after all — both pass through unchanged.
 * --------------------------------------------------------------------------- */
function fixMojibake(s: string): string {
  if (!/[\u0080-\u00ff]/.test(s)) {
    return s;
  } // pure ASCII — nothing to repair

  if (/[\u0100-\uffff]/.test(s)) {
    return s;
  } // already real Unicode (incl. emoji)

  const decoded = Buffer.from(s, 'latin1').toString('utf8');

  return decoded.includes('\uFFFD') ? s : decoded;
}

/** Repair every string value in a parsed Facebook JSON document (keys are ASCII). */
function fixMojibakeDeep<T>(v: T): T {
  if (typeof v === 'string') {
    return fixMojibake(v) as T;
  }

  if (Array.isArray(v)) {
    return v.map(fixMojibakeDeep) as T;
  }

  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = fixMojibakeDeep(val);
    }

    return out as T;
  }

  return v;
}

/** JSON.parse a Facebook DYI file with mojibake repair. Null on invalid JSON. */
function parseFacebookJson<T>(raw: string): T | null {
  try {
    return fixMojibakeDeep(JSON.parse(raw)) as T;
  } catch {
    return null;
  }
}

/* ---- HTML-format helpers (Meta "Download Your Information" HTML export) ---- */

// Decode the handful of HTML entities Meta emits in DYI exports.
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

// Strip tags via the shared parser-based flattener (real tag nesting, the
// full HTML5 entity table — see its own doc comment), then collapse to ONE
// flat line: a heading or message bubble here has no paragraph structure of
// its own, so a newline the flattener introduces at a Meta div boundary is
// export markup, not something the person wrote.
function htmlToText(fragment: string): string {
  return sharedHtmlToText(fragment).replace(/\s+/g, ' ').trim();
}

// Extract a timestamp from an entry fragment. Prefer a machine-readable
// <time datetime="..."> attribute; fall back to the human footer timestamp
// Meta renders in <div class="_a72d">Nov 13, 2025 8:27:54 am</div>.
function extractEntryTimestamp(fragment: string): Date | undefined {
  const iso = /<time[^>]*\bdatetime="([^"]+)"/i.exec(fragment);
  if (iso) {
    const d = new Date(iso[1]);
    if (!isNaN(d.getTime())) {
      return d;
    }
  }

  const footer = /<div class="_a72d">([^<]+)<\/div>/i.exec(fragment);
  if (footer) {
    const d = new Date(decodeEntities(footer[1]).trim());
    if (!isNaN(d.getTime())) {
      return d;
    }
  }

  return undefined;
}

// Split the <main> body of a DYI HTML page into per-entry <section class="_a6-g"> fragments.
function splitEntrySections(html: string): string[] {
  const mainIdx = html.search(/<main\b/i);
  const body = mainIdx >= 0 ? html.slice(mainIdx) : html;
  const out: string[] = [];
  const re = /<section class="_a6-g"[^>]*>/gi;
  let m: RegExpExecArray | null;
  let start = -1;
  while ((m = re.exec(body)) !== null) {
    if (start >= 0) {
      out.push(body.slice(start, m.index));
    }

    start = m.index;
  }

  if (start >= 0) {
    out.push(body.slice(start));
  }

  return out;
}

// Pull the <h2> heading text from an entry (sender for messages, action for posts).
function extractHeading(fragment: string): string | undefined {
  const m = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(fragment);
  if (!m) {
    return undefined;
  }

  const text = htmlToText(m[1]);

  return text || undefined;
}

// A local (export-relative) href/src that resolves to an attached photo or
// video — the same test htmlMediaUris applies when it decides a link is a real
// attachment rather than page furniture. Kept separate from mimeForFile's
// broader table because only these two classes get a thumbnail link in Meta's
// markup; everything else (a shared URL, a mailto:, a footer permalink) is
// either external or plain text and must stay in the body untouched.
function isLocalMediaHref(raw: string): boolean {
  if (/^(?:https?:|data:|mailto:|tel:|#)/i.test(raw)) {
    return false;
  }

  const mediaType = mimeForFile(raw);

  return !!mediaType && /^(image|video)\//.test(mediaType);
}

// Every attached photo/video in a DYI entry is rendered as an <a href="...local
// path..."> whose visible text is Meta's OWN caption for the thumbnail — "Photos"
// for a photo with nothing else to show, "Click for video: " for a video — never
// what the person wrote. Real captions always live in a separate sibling text
// node, so dropping the whole anchor (tag + contents) removes exactly the
// boilerplate and nothing else. htmlMediaUris reads the same href off the
// UNMODIFIED fragment, so the attachment itself is still discovered.
function stripMediaLinks(fragment: string): string {
  return fragment.replace(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>[\s\S]*?<\/a>/gi, (whole, href) =>
    isLocalMediaHref(decodeEntities(href).trim()) ? ' ' : whole,
  );
}

// A person's own post/message text is never itself rendered as an HTML list in
// Meta's export — composing a post doesn't support markdown, so any <ul> in an
// entry is Meta's OWN chrome: a reaction summary ("❤️ Jane Doe and 11 others"),
// a tagged-friends list, or similar. Dropping it keeps a reaction from reading
// as if the sender/poster wrote it themselves.
function stripReactionLists(fragment: string): string {
  return fragment.replace(/<ul\b[^>]*>[\s\S]*?<\/ul>/gi, ' ');
}

// Visible text of an entry with its <h2> heading, <footer> (timestamp), media
// thumbnail links, and reaction/list chrome removed — all captured or discarded
// separately, so excluding them keeps the body text to what was actually typed.
function extractEntryBodyText(fragment: string): string {
  const trimmed = fragment
    .replace(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi, ' ')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ');

  return htmlToText(stripReactionLists(stripMediaLinks(trimmed)));
}

// Item ids must stay stable across re-imports, so they key off each file's path
// RELATIVE to the export root — never the absolute path. The absolute path
// includes the ephemeral inbox `_drops/<dropId>` staging dir, so re-uploading
// the same export would otherwise mint fresh ids and duplicate every row. POSIX-
// normalized so the key is identical across platforms.
function exportRelPath(root: string, fpath: string): string {
  return path.relative(root, fpath).split(path.sep).join('/');
}

// Content-derived item id for messages and posts.
//
// Meta writes message/post files NEWEST-FIRST, so an incremental re-export
// shifts every array index: a running-index id (facebook:msg:<rel>#<i>) lands
// NEW messages on (rel,#i) slots already occupied by OLD rows — the dedup
// index silently keeps the old row and the new message is lost — while old
// messages pushed past the previous count re-insert as duplicates. Hashing
// the content itself (timestamp + sender + text) keeps ids stable and
// collision-free across exports, regardless of position or file pagination.
//
// `scope` pins the id to a stable container — the immutable numeric thread id
// (see threadKey) for messages, a constant for posts — so identical content in
// different threads (Messenger's share-to-several-threads-at-once) can't
// collide. `seen` disambiguates exact duplicates (same scope + fields,
// e.g. the same "hi" sent twice in the same millisecond) with an occurrence
// suffix counted in file order; duplicates keep their relative order across
// incremental exports, so the suffix is stable too.
//
// Returns undefined when every field is empty — callers fall back to the
// legacy rel-path#index id in that (theoretical) case.
function contentId(
  kind: 'msg' | 'post',
  scope: string,
  fields: Array<string | number | undefined>,
  seen: Map<string, number>,
): string | undefined {
  if (fields.every((f) => f === undefined || f === '')) {
    return undefined;
  }

  const h = crypto.createHash('sha1');
  h.update(scope);
  for (const f of fields) {
    h.update('\0');
    h.update(f === undefined ? '' : String(f));
  }

  const base = `facebook:${kind}:v2:${h.digest('hex')}`;
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);

  return n === 0 ? base : `${base}#${n}`;
}

// Meta names thread dirs "<title>_<threadid>". Only the numeric id half is
// stable across exports: the title half tracks the CURRENT chat/contact name,
// so a rename between exports would re-mint every message id in the thread
// (one-time duplication of the whole thread on the next re-import). Scope
// message ids by the numeric id alone; threads without one (theoretical)
// keep the full dir name.
function threadKey(threadDirName: string): string {
  const m = /_(\d+)$/.exec(threadDirName);

  return m ? m[1] : threadDirName;
}

// One paginated message file of a thread, in either export format.
const THREAD_FILE_RE = /^message_\d+\.(?:json|html)$/i;

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The thread-holding subdirectories ("lanes") of one messages/ root.
 *
 * Meta does NOT keep every conversation under messages/inbox/. It splits them
 * across sibling lanes — inbox/, filtered_threads/, message_requests/,
 * archived_threads/, e2ee_cutover/ (the last added only when the account was
 * migrated to encrypted Messenger) — and invents new ones between export
 * generations. Hard-coding "inbox" therefore dropped whole conversations
 * silently: a real export here carried 24 messages across three lanes and only
 * the 7 in inbox/ were imported, with no loss report to show for the rest.
 *
 * So enumerate rather than name: any subdirectory holding at least one
 * <thread>/message_N.{json,html} is a lane. That picks up the lanes Meta ships
 * today AND whatever it renames them to tomorrow, while skipping the media
 * siblings (photos/, gifs/, stickers_used/, videos/) without having to list
 * them — their children are files, or files-in-files, never message pages.
 * Sorted so lane order is deterministic across platforms.
 */
function threadLaneDirs(messagesDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(messagesDir);
  } catch {
    return [];
  }

  const lanes: string[] = [];
  for (const name of names.sort()) {
    const laneDir = path.join(messagesDir, name);
    if (!isDirectory(laneDir)) {
      continue;
    }

    let threads: string[];
    try {
      threads = fs.readdirSync(laneDir);
    } catch {
      continue;
    }

    // First thread-shaped child is enough — `.some` short-circuits, so a real
    // lane costs one extra readdir and a media sibling costs one stat per child.
    const holdsThreads = threads.some((thread) => {
      const threadDir = path.join(laneDir, thread);
      if (!isDirectory(threadDir)) {
        return false;
      }

      try {
        return fs.readdirSync(threadDir).some((f) => THREAD_FILE_RE.test(f));
      } catch {
        return false;
      }
    });

    if (holdsThreads) {
      lanes.push(laneDir);
    }
  }

  return lanes;
}

/**
 * The attachment half of a message's metadata, from export-root-relative uris.
 *
 * `MediaFilePaths` is the same contract the SMS/MMS importer writes (absolute
 * on-disk paths, read by the push's media leg — see ci-server/mapping.ts
 * mmsMediaFilePaths); persistence retains those bytes out of the inbox before
 * cleanup can delete them. `AttachmentContent` opts this record into the
 * upload-AND-link lane, so each attachment gets a ci.content row over the
 * stored file rather than just the file — a photo someone sent is a thing worth
 * finding on its own, not only by reading the thread it arrived in.
 */
function attachmentMetadata(root: string, uris: string[]): Metadata {
  if (uris.length === 0) {
    return {};
  }

  return {
    MediaFilePaths: uris.map((u) => path.join(root, u)),
    AttachmentContent: true,
  };
}

export class FacebookFileImporter implements FileImporter {
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

    if (st.isDirectory()) {
      try {
        const names = await readdir(root);
        if (names.includes('your_facebook_activity')) {
          return { confidence: 0.9 };
        }

        if (names.includes('messages') && names.includes('profile_information')) {
          return { confidence: 0.9 };
        }

        if (names.includes('messages') && names.includes('posts')) {
          return { confidence: 0.85 };
        }

        if (names.includes('messages') && names.includes('friends')) {
          return { confidence: 0.8 };
        }

        if (names.includes('messages')) {
          return { confidence: 0.6 };
        }
      } catch {
        /* ignore */
      }

      return { confidence: 0, dir_threshold: 0.6 };
    }

    return { confidence: 0 };
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

    if (!stat.isDirectory()) {
      return;
    }

    // Messages — JSON format lives directly under messages/<lane>/<thread>/.
    // The HTML ("Download Your Information" HTML) format nests the same tree
    // under your_facebook_activity/messages/. Try both roots; per thread,
    // prefer JSON when present and fall back to HTML otherwise.
    const laneDirs = [
      path.join(root, 'messages'),
      path.join(root, 'your_facebook_activity', 'messages'),
    ].flatMap((messagesDir) => threadLaneDirs(messagesDir));
    for (const laneDir of laneDirs) {
      let threads: string[];
      try {
        threads = fs.readdirSync(laneDir);
      } catch {
        continue;
      }

      for (const thread of threads) {
        const threadDir = path.join(laneDir, thread);
        let files: string[];
        try {
          if (!fs.statSync(threadDir).isDirectory()) {
            continue;
          }

          files = fs.readdirSync(threadDir);
        } catch {
          continue;
        }

        // Occurrence map shared across ALL files of one thread, so exact-duplicate
        // messages keep stable suffixes even when pagination boundaries shift
        // between exports (a message may move from message_1.json to message_2.json).
        const seen = new Map<string, number>();
        const jsonFiles = files.filter((f) => /^message_\d+\.json$/i.test(f)).sort();
        if (jsonFiles.length) {
          for (const mf of jsonFiles) {
            await this.processThread(path.join(threadDir, mf), thread, root, params, seen);
          }
        } else {
          const htmlFiles = files.filter((f) => /^message_\d+\.html$/i.test(f)).sort();
          for (const mf of htmlFiles) {
            await this.processThreadHtml(path.join(threadDir, mf), thread, root, params, seen);
          }
        }
      }
    }

    // Posts
    const postsDir = fs.existsSync(path.join(root, 'your_facebook_activity', 'posts'))
      ? path.join(root, 'your_facebook_activity', 'posts')
      : fs.existsSync(path.join(root, 'posts'))
        ? path.join(root, 'posts')
        : null;
    if (postsDir) {
      let postFiles: string[];
      try {
        postFiles = fs.readdirSync(postsDir);
      } catch {
        postFiles = [];
      }

      // One occurrence map across ALL post files (sorted for a deterministic
      // order), so exact-duplicate posts keep stable suffixes across exports
      // even if they shift between pagination files.
      const seen = new Map<string, number>();
      const jsonPosts = postFiles.filter((f) => f.endsWith('.json')).sort();
      if (jsonPosts.length) {
        for (const pf of jsonPosts) {
          await this.processPosts(path.join(postsDir, pf), root, params, seen);
        }
      } else {
        // HTML format: only the "your_posts__*" page holds real status/photo posts;
        // sibling HTML pages (your_photos, shared_memories, …) are media indexes.
        const htmlPosts = postFiles.filter((f) => /^your_posts__.*\.html$/i.test(f)).sort();
        for (const pf of htmlPosts) {
          await this.processPostsHtml(path.join(postsDir, pf), root, params, seen);
        }
      }
    }
  }

  // Emit a 'media' item for one photo/video on disk. `relKey` is the file's path
  // RELATIVE to the export root, so it doubles as a stable, unique identity: it's
  // the same string no matter which inbox/_drops/<dropId> dir the export was
  // staged in, so the id dedupes cleanly on re-import (unlike the absolute path).
  // Unlike message/post ids, media ids carry NO running index — the file's own
  // rel path identifies exactly one file and doesn't shift when an incremental
  // re-export prepends new entries, so the rel-path scheme stays correct here.
  // The bytes are loaded lazily. Scope is photos and videos — anything whose MIME
  // isn't image/* or video/* (audio, files, stickers, non-media hrefs) is skipped.
  private pushMediaFile(
    abs: string,
    relKey: string,
    fallbackTs: Date | undefined,
    creationTs: number | undefined,
    context: Metadata,
    params: ImportParams,
  ): void {
    if (!fs.existsSync(abs)) {
      params.log?.('warn', 'Facebook media referenced but missing on disk', { uri: relKey });

      return;
    }

    const filename = path.basename(relKey);
    const mediaType = mimeForFile(filename);
    const type = mediaType?.startsWith('video/')
      ? 'Video'
      : mediaType?.startsWith('image/')
        ? 'Photo'
        : undefined;
    if (!type) {
      return;
    } // not a photo or video — out of scope

    // Prefer the media's own capture time; fall back to the message/post time.
    const ts = creationTs ? new Date(creationTs * 1000) : fallbackTs;
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    params.pipeline.push({
      item: {
        id: `facebook:media:${relKey}`,
        classification: 'media',
        timestamp: ts,
        // intermediateLocation is the on-disk source path: the push reads bytes
        // from it, and persist retains a copy from it before the inbox is purged.
        intermediateLocation: abs,
        content: { filename, mediaType, data: async () => fs.promises.readFile(abs) },
        metadata: { ...context, Type: type, Source: 'Facebook' },
      },
    });
  }

  /**
   * Every attachment on a Messenger message, as export-root-relative uris in a
   * stable order (photos, videos, gifs, audio, files, sticker). Unlike media
   * ITEMS — which only ever covered photos and videos, because a standalone
   * capture.photo/capture.video row is all the timeline can model — an
   * attachment has no MIME constraint, so audio clips, shared PDFs, gifs and
   * stickers all ride along on the message they arrived in.
   *
   * Missing files are dropped (and logged): Meta's export splits media across
   * several zips, so an unpacked-only-partly export references bytes that
   * genuinely aren't on disk, and a task pointing at nothing would just fail
   * the upload later.
   */
  private messageAttachmentUris(root: string, msg: FBMessage, params: ImportParams): string[] {
    const refs = [
      ...(msg.photos ?? []),
      ...(msg.videos ?? []),
      ...(msg.gifs ?? []),
      ...(msg.audio_files ?? []),
      ...(msg.files ?? []),
      ...(msg.sticker ? [msg.sticker] : []),
    ];
    const out: string[] = [];
    for (const ref of refs) {
      if (!ref?.uri) {
        continue;
      }

      const rel = ref.uri.split('\\').join('/'); // normalize any Windows separators
      if (!fs.existsSync(path.join(root, rel))) {
        params.log?.('warn', 'Facebook message attachment referenced but missing on disk', { uri: rel });
        continue;
      }

      out.push(rel);
    }

    return out;
  }

  // JSON attachment: the `uri` is already relative to the export root.
  private pushMedia(
    root: string,
    ref: FBMediaRef,
    fallbackTs: Date | undefined,
    context: Metadata,
    params: ImportParams,
  ): void {
    if (!ref.uri) {
      return;
    }

    const rel = ref.uri.split('\\').join('/'); // normalize any Windows separators
    this.pushMediaFile(path.join(root, ref.uri), rel, fallbackTs, ref.creation_timestamp, context, params);
  }

  // Pull local photo/video references (src=/href=) out of one HTML entry, as
  // export-root-relative uris. External URLs and non-file schemes are ignored;
  // Meta roots media at the export root, but we fall back to the page's own dir.
  // pushMediaFile does the final MIME gate, so a stray non-media href is harmless.
  private htmlMediaUris(section: string, fpath: string, root: string): string[] {
    const out = new Set<string>();
    const re = /(?:src|href)\s*=\s*"([^"]*)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(section)) !== null) {
      let raw = decodeEntities(m[1]).trim();
      if (!raw || /^(https?:|data:|mailto:|tel:|#)/i.test(raw)) {
        continue;
      }

      try {
        raw = decodeURIComponent(raw);
      } catch {
        /* keep raw on malformed % escapes */
      }

      const abs = [path.join(root, raw), path.join(path.dirname(fpath), raw)].find((p) => fs.existsSync(p));
      if (!abs) {
        continue;
      }

      out.add(path.relative(root, abs).split(path.sep).join('/'));
    }

    return [...out];
  }

  private async processThreadHtml(
    fpath: string,
    threadDir: string,
    root: string,
    params: ImportParams,
    seen: Map<string, number>,
  ): Promise<void> {
    let html: string;
    try {
      html = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${path.basename(fpath)}`, { error: (e as Error).message });

      return;
    }

    const rel = exportRelPath(root, fpath);
    // Thread name: Meta suffixes the directory with an id (e.g. "name_2031253580255991").
    const thread = threadDir.replace(/_\d+$/, '').replace(/_/g, ' ').trim() || undefined;
    const sections = splitEntrySections(html);
    // The participants-only section heading ("Participants: A, B, ...") carries the
    // thread roster; capture it so each message can derive its recipients (To).
    let participants: string[] = [];
    for (const section of sections) {
      const m = /^Participants:\s*(.+)$/i.exec(extractHeading(section) || '');
      if (m) {
        participants = m[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      }
    }

    let idx = 0;
    for (const section of sections) {
      const i = idx++;
      try {
        const sender = extractHeading(section);
        const ts = extractEntryTimestamp(section);
        const to = participants.filter((n) => n !== sender);
        const context: Metadata = {
          Sender: sender,
          To: to.length ? to.join(', ') : undefined,
          Thread: thread,
        };
        const text = extractEntryBodyText(section);
        if (!timeframeContains(params.timeframe, ts)) {
          continue;
        }

        // Attachments ride ON the message, same as the JSON path above.
        const attachmentUris = this.htmlMediaUris(section, fpath, root);
        if (!text && attachmentUris.length === 0) {
          continue;
        }

        params.pipeline.push({
          item: {
            // Content-derived id: stable across incremental re-exports (Meta
            // prepends new messages, shifting every index — see contentId).
            // Attachment uris join the digest so media-only messages are both
            // identifiable and distinct from each other.
            id:
              contentId(
                'msg',
                threadKey(threadDir),
                [ts?.getTime(), sender, text, attachmentUris.join(',') || undefined],
                seen,
              ) ?? `facebook:msg:${rel}#${i}`,
            classification: 'message',
            timestamp: ts,
            content: {
              filename: path.basename(fpath),
              mediaType: 'text/plain',
              data: async () => Buffer.from(text),
            },
            metadata: {
              ...context,
              Source: 'Facebook',
              Text: text || undefined,
              ...attachmentMetadata(root, attachmentUris),
            },
          },
        });
      } catch (e) {
        params.log?.('error', `Failed to import message in ${path.basename(fpath)}`, {
          error: (e as Error).message,
        });
      }
    }
  }

  private async processPostsHtml(
    fpath: string,
    root: string,
    params: ImportParams,
    seen: Map<string, number>,
  ): Promise<void> {
    let html: string;
    try {
      html = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${path.basename(fpath)}`, { error: (e as Error).message });

      return;
    }

    const rel = exportRelPath(root, fpath);
    let idx = 0;
    for (const section of splitEntrySections(html)) {
      const i = idx++;
      try {
        const ts = extractEntryTimestamp(section);
        const text = extractEntryBodyText(section);
        const context: Metadata = { Text: text || undefined };
        // Photos/videos on this post → media items (before the empty-text skip,
        // so a photo-only post still contributes its media).
        for (const uri of this.htmlMediaUris(section, fpath, root)) {
          this.pushMediaFile(path.join(root, uri), uri, ts, undefined, context, params);
        }

        if (!text) {
          continue;
        }

        if (!timeframeContains(params.timeframe, ts)) {
          continue;
        }

        params.pipeline.push({
          item: {
            // Content-derived id: stable across incremental re-exports (Meta
            // prepends new posts, shifting every index — see contentId).
            id: contentId('post', 'posts', [ts?.getTime(), text], seen) ?? `facebook:post:${rel}#${i}`,
            classification: 'social',
            timestamp: ts,
            content: { filename: 'post.txt', mediaType: 'text/plain', data: async () => Buffer.from(text) },
            metadata: { Text: text || undefined, Source: 'Facebook' },
          },
        });
      } catch (e) {
        params.log?.('error', `Failed to import post in ${path.basename(fpath)}`, {
          error: (e as Error).message,
        });
      }
    }
  }

  private async processThread(
    fpath: string,
    threadDir: string,
    root: string,
    params: ImportParams,
    seen: Map<string, number>,
  ): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch {
      return;
    }

    const thread = parseFacebookJson<FBThread>(raw);
    if (!thread) {
      return;
    }

    const rel = exportRelPath(root, fpath);
    // Thread roster, so each message can derive recipients (To = participants minus sender).
    const participants = (thread.participants ?? []).map((p) => p.name).filter(Boolean) as string[];
    let idx = 0;
    for (const msg of thread.messages ?? []) {
      const i = idx++;
      if (msg.is_unsent) {
        continue;
      }

      const ts = msg.timestamp_ms ? new Date(msg.timestamp_ms) : undefined;
      const to = participants.filter((n) => n !== msg.sender_name);
      const context: Metadata = {
        Sender: msg.sender_name || undefined,
        To: to.length ? to.join(', ') : undefined,
        Conversation: thread.title || undefined,
      };
      if (!timeframeContains(params.timeframe, ts)) {
        continue;
      }

      const text = msg.content ?? msg.share?.link ?? '';
      // Attachments ride ON the message rather than becoming standalone media
      // items: one communication per message, with the photos/videos/etc. it
      // carried referenced from its `attachments` column (the push uploads them
      // and creates a content row each — see graphql.ts withCommunicationMedia).
      const attachmentUris = this.messageAttachmentUris(root, msg, params);
      // A message with neither text nor attachments has nothing to record.
      if (!text && attachmentUris.length === 0) {
        continue;
      }

      params.pipeline.push({
        item: {
          // Content-derived id: stable across incremental re-exports (Meta
          // prepends new messages, shifting every index — see contentId). The
          // attachment uris join the digest so two media-only messages from the
          // same sender in the same millisecond stay distinct — and so a
          // media-only message has any identity at all (its text is empty).
          id:
            contentId(
              'msg',
              threadKey(threadDir),
              [msg.timestamp_ms, msg.sender_name, text, attachmentUris.join(',') || undefined],
              seen,
            ) ?? `facebook:msg:${rel}#${i}`,
          classification: 'message',
          timestamp: ts,
          // Media-only messages persist with empty content — the message IS its
          // attachments, and the communication's content field is blank.
          content: {
            filename: path.basename(fpath),
            mediaType: 'text/plain',
            data: async () => Buffer.from(text),
          },
          metadata: {
            ...context,
            Source: 'Facebook',
            Text: text || undefined,
            ...attachmentMetadata(root, attachmentUris),
          },
        },
      });
    }
  }

  private async processPosts(
    fpath: string,
    root: string,
    params: ImportParams,
    seen: Map<string, number>,
  ): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch {
      return;
    }

    const posts = parseFacebookJson<FBPost[]>(raw);
    if (!Array.isArray(posts)) {
      return;
    }

    const rel = exportRelPath(root, fpath);
    let idx = 0;
    for (const post of posts) {
      const i = idx++;
      let ts = post.timestamp ? new Date(post.timestamp * 1000) : undefined;
      let text = post.data?.find((d) => d.post)?.post ?? post.title ?? '';
      // Place check-ins have no top-level title; derive "Visited <place>" and use
      // the visit time from label_values instead of the post timestamp.
      if (!post.title) {
        const placeName = post.label_values?.find((l) => l.label === 'Place name')?.value;
        const visitTime = post.label_values?.find((l) => l.label === 'Visit time')?.timestamp_value;
        if (placeName && visitTime != null) {
          text = `Visited ${placeName}`;
          ts = new Date(visitTime * 1000);
        }
      }

      // Photos/videos attached to the post → 'media' items. Posts don't tag the
      // media type, so pushMedia infers photo vs video from the file extension.
      const context: Metadata = { Text: text || undefined };
      for (const att of post.attachments ?? []) {
        for (const datum of att.data ?? []) {
          if (datum.media) {
            this.pushMedia(root, datum.media, ts, context, params);
          }
        }
      }

      if (!timeframeContains(params.timeframe, ts)) {
        continue;
      }

      params.pipeline.push({
        item: {
          // Content-derived id: stable across incremental re-exports (Meta
          // prepends new posts, shifting every index — see contentId).
          id: contentId('post', 'posts', [ts?.getTime(), text], seen) ?? `facebook:post:${rel}#${i}`,
          classification: 'social',
          timestamp: ts,
          content: { filename: 'post.txt', mediaType: 'text/plain', data: async () => Buffer.from(text) },
          metadata: { Text: text || undefined, Source: 'Facebook' },
        },
      });
    }
  }
}

registerDataSource({
  name: 'facebook',
  title: 'Facebook',
  icon: '',
  description:
    'Messenger threads and Posts (with attached photos/videos) from a Facebook "Download Your Information" export.',
  newFileImporter: () => new FacebookFileImporter(),
});
