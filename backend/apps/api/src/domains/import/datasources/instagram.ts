/* Instagram — "Download Your Information" export.
 *
 * Supports BOTH formats Meta produces:
 *  - JSON: your_instagram_activity/ with message_*.json + posts JSON.
 *  - HTML: the same tree but rendered as .html (messages/inbox/<thread>/message_*.html,
 *    likes/liked_posts.html, comments/*.html, saved/saved_posts.html, ...).
 *
 * The HTML format has no per-entry <time datetime> attributes for activity logs;
 * each entry block ends with a human-readable date div: <div class="_3-94 _a6-o">May 04, 2026 10:01 am</div>.
 * We split each file's <main> body on that date div and treat the text before each
 * date as one entry. Message files additionally carry a per-entry <h2> sender.
 */
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { htmlToText } from './htmlToText';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Metadata } from './timeline';
import { mediaItemFromFile, timeframeContains } from './timeline';

interface IGMessage {
  sender_name?: string;
  timestamp_ms?: number;
  content?: string;
  share?: { link?: string };
  is_unsent?: boolean;
}
interface IGThread {
  participants?: Array<{ name: string }>;
  messages?: IGMessage[];
  title?: string;
}
interface IGPostMedia {
  uri?: string;
  creation_timestamp?: number;
  title?: string;
}
interface IGPost {
  media?: IGPostMedia[];
  title?: string;
  creation_timestamp?: number;
}

// ---- HTML helpers (mirrors mastodon.ts style) ----
// decodeHtml below is for attribute/date-fragment-scoped strings ALREADY
// pulled out of a larger document by a regex capture group; body-flattening
// goes through the shared htmlToText instead (see its own doc comment).

function decodeHtml(h: string): string {
  return h
    .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// Per-entry date div used across Meta HTML activity logs.
const DATE_DIV_RE = /<div class="_3-94 _a6-o">([^<]*)<\/div>/g;

function parseMetaDate(s: string): Date | undefined {
  const t = decodeHtml(s)
    .replace(/\u202F/g, ' ')
    .trim();
  if (!t) {
    return undefined;
  }

  const d = new Date(t);

  return isNaN(d.getTime()) ? undefined : d;
}

interface HtmlEntry {
  sender?: string;
  text: string;
  ts?: Date;
  /**
   * The entry's own markup (already de-duplicated, see dedupeRepeatedFieldRows).
   * `text` is what survives htmlToText, which throws away every identity the
   * entry carries — the post permalink lives in an `<a href>` ATTRIBUTE and the
   * media file in an `<img src>`, neither of which a tag strip can reach. The
   * activity importer reads those off the markup before falling back to text.
   */
  html: string;
}

/**
 * One label/value cell pair from a Meta activity table, e.g.
 * `<tr><td class="_a6_q">Caption</td><td class="_2piu _a6_r">…</td></tr>`.
 *
 * The label cell is `[^<]*` on purpose: a `<tr>` whose first cell OPENS a
 * nested block (`<td colspan="2" …><div><div class="pam …"><h2>Owner</h2>…`)
 * carries a section heading, not a field, and must not match — otherwise the
 * lazy value group would swallow the sub-table's first `</td></tr>` and report
 * a fragment as a field value.
 */
const FIELD_ROW_PATTERN = '<tr>\\s*<td[^>]*>([^<]*)</td>\\s*<td[^>]*>([\\s\\S]*?)</td>\\s*</tr>';

interface FieldRow {
  label: string;
  value: string;
}

function fieldRows(html: string): FieldRow[] {
  const re = new RegExp(FIELD_ROW_PATTERN, 'g');
  const rows: FieldRow[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    rows.push({ label: decodeHtml(m[1]).trim(), value: htmlToText(m[2]) });
  }

  return rows;
}

/**
 * Drop a field row that is byte-identical to the one immediately before it.
 *
 * Meta's own renderer emits every post Caption TWICE in liked_posts.html,
 * saved_posts.html, reposts.html and stories_viewed.html — two adjacent
 * `<tr>Caption…</tr>` rows with identical text — so the stripped entry text
 * carried the caption twice, and so did metadata.Description and every
 * embedding derived from it. Same class of source-side doubling as the Google
 * Voice call heading (see 20260818213148_backfill_google_voice_call_heading_
 * duplication.sql); same fix — collapse the literal repeat, invent nothing.
 *
 * Scoped to CONSECUTIVE identical rows within ONE entry: two entries that
 * happen to share a caption are separate chunks and never compare, and a
 * repeated label with a different value (an Owner's Name vs Username) never
 * matches.
 */
function dedupeRepeatedFieldRows(html: string): string {
  const re = new RegExp(FIELD_ROW_PATTERN, 'g');
  let out = '';
  let last = 0;
  let previous: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const row = m[0];
    // Everything between the previous row and this one is kept verbatim; the
    // row itself is kept only when it is not a repeat of the row before it.
    out += html.slice(last, m.index) + (row === previous ? '' : row);
    previous = row;
    last = re.lastIndex;
  }

  return out + html.slice(last);
}

/** The anchor TEXT of an entry's first link. A follower/following entry is
 *  nothing but `<a href="…/johndoe">johndoe</a>`, so this is the only name it
 *  has. */
function firstLinkText(html: string): string | undefined {
  const m = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(html);
  const t = m ? htmlToText(m[1]) : '';

  return t ? clipText(t) : undefined;
}

/** The first absolute http(s) link in an entry — Meta's per-entry permalink. */
function firstWebLink(html: string): string | undefined {
  const re = /<a\b[^>]*\bhref="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = decodeHtml(m[1]).trim();
    if (/^https?:\/\//i.test(href)) {
      return href;
    }
  }

  return undefined;
}

/**
 * The post/reel shortcode in an Instagram permalink — the id of the THING the
 * entry is about, as opposed to the id of the activity (a like, a save, a story
 * view), which is per-file and per-position.
 */
function instagramShortcode(url: string): string | undefined {
  const m = /instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i.exec(url);

  return m ? m[1] : undefined;
}

/** Field rows that belong to the entry ITSELF — everything before the first
 *  `<h2>` sub-section (Owner / Media / Hashtags). Without the cut, a saved
 *  COLLECTION would be named after the first post filed inside it. */
function headFieldRows(html: string): FieldRow[] {
  const h2 = html.search(/<h2[\s>]/i);

  return fieldRows(h2 >= 0 ? html.slice(0, h2) : html);
}

/** Display name + handle of the account that posted the thing this entry is
 *  about, off the entry's `<h2>Owner</h2>` sub-table. */
function ownerOf(html: string): { name?: string; handle?: string } {
  const m = /<h2[^>]*>\s*Owner\s*<\/h2>/i.exec(html);
  if (!m) {
    return {};
  }

  const rows = fieldRows(html.slice(m.index + m[0].length));

  return {
    name: rows.find((r) => r.label === 'Name')?.value || undefined,
    handle: rows.find((r) => r.label === 'Username')?.value || undefined,
  };
}

function valueOf(rows: FieldRow[], label: string): string | undefined {
  return rows.find((r) => r.label === label)?.value || undefined;
}

/** Single-line, length-capped copy of a value, for a title. */
function clipText(s: string, n = 80): string {
  const flat = s.replace(/\s+/g, ' ').trim();

  return flat.length > n ? `${flat.slice(0, n - 1).trimEnd()}…` : flat;
}

/**
 * Labels that only ever describe an entry's bookkeeping. An entry carrying
 * nothing BUT these has no content — see hasSubstance.
 */
const NON_CONTENT_FIELD_LABELS = new Set(['update time', 'expiration time', 'is an advertisement']);

/**
 * Does this entry say anything at all?
 *
 * other_content.html ships five byte-identical placeholder entries whose only
 * fields are an EMPTY `Media` cell plus "Is an advertisement: False" and an
 * "Update time" — no media uri, no caption, no link, nothing. None of that is
 * an empty string, so the old `if (!text) continue` let all five through, each
 * under its own `#<i>` id so they never deduped against each other either.
 */
function hasSubstance(html: string, url: string | undefined, mediaPath: string | undefined): boolean {
  if (url || mediaPath) {
    return true;
  }

  for (const row of fieldRows(html)) {
    if (row.value && !NON_CONTENT_FIELD_LABELS.has(row.label.toLowerCase())) {
      return true;
    }
  }

  // Text that is not in a label/value row at all — a follower handle, a
  // "Product names" list — is content too.
  return htmlToText(html.replace(new RegExp(FIELD_ROW_PATTERN, 'g'), ' ')).length > 0;
}

/**
 * The directory this file's export-relative hrefs resolve against. Meta stamps
 * `<base href="../../">` in every activity page's <head>, so `media/other/x.jpg`
 * inside your_instagram_activity/media/profile_photos.html means
 * <export root>/media/other/x.jpg — two directories UP, not alongside the page.
 */
function exportBaseDir(fpath: string, html: string): string {
  const dir = path.dirname(fpath);
  const m = /<base[^>]*\bhref="([^"]+)"/i.exec(html);

  return m ? path.resolve(dir, decodeHtml(m[1]).trim()) : dir;
}

/** Resolve one export-relative href to an absolute path inside the export, or
 *  null for an absolute URL, a fragment, or anything that escapes the export. */
function resolveLocalRef(baseDir: string, ref: string): string | null {
  const href = decodeHtml(ref).trim();
  if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return null;
  }

  let rel = href;
  try {
    rel = decodeURIComponent(href);
  } catch {
    /* keep the raw href when it isn't valid percent-encoding */
  }

  const abs = path.resolve(baseDir, rel);

  return abs === baseDir || abs.startsWith(baseDir + path.sep) ? abs : null;
}

/** The first `<img src>` / `<a href>` in the entry pointing at a file that
 *  actually exists on disk inside the export. */
function localMediaPath(html: string, baseDir: string): string | undefined {
  const re = /<(?:img\b[^>]*\bsrc|a\b[^>]*\bhref)="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const abs = resolveLocalRef(baseDir, m[1]);
    if (!abs) {
      continue;
    }

    try {
      if (fs.statSync(abs).isFile()) {
        return abs;
      }
    } catch {
      /* not on disk — Meta ships incomplete media trees routinely */
    }
  }

  return undefined;
}

/**
 * Classifications whose entries ARE a media file. An entry in one of these
 * files that resolves to no bytes on disk is skipped: kindFor maps both to
 * capture.photo (canonical.ts), so emitting one anyway manufactures a photo
 * event with no photo — six of them in the live database.
 */
const MEDIA_LANE_CLASSIFICATIONS = new Set(['media', 'photo', 'image', 'video', 'audio']);

interface ActivityOptions {
  /**
   * Entries in this file are single Instagram POSTS, so the post's shortcode is
   * a legitimate identity for the content row (metadata.URI). False for files
   * whose entry is a container (a saved collection) or a different object that
   * merely links to a post (a liked comment).
   */
  postUri?: boolean;
}

// Split a file's <main> body into one entry per trailing date div.
// The text BEFORE each date div is that entry's content.
function parseHtmlEntries(html: string): HtmlEntry[] {
  const mainIdx = html.indexOf('<main');
  let body = mainIdx >= 0 ? html.slice(mainIdx) : html;
  body = body.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');

  const entries: HtmlEntry[] = [];
  DATE_DIV_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = DATE_DIV_RE.exec(body)) !== null) {
    // Meta repeats a post's Caption row verbatim; collapse it here so BOTH the
    // stripped text and any per-field read below see the caption exactly once.
    const chunk = dedupeRepeatedFieldRows(body.slice(last, m.index));
    last = DATE_DIV_RE.lastIndex;
    const ts = parseMetaDate(m[1]);
    // Per-entry sender (message logs put it in an <h2>).
    let sender: string | undefined;
    const h2 = chunk.match(/<h2[^>]*>([^<]*)<\/h2>/);
    if (h2) {
      const s = decodeHtml(h2[1]).trim();
      if (s) {
        sender = s;
      }
    }

    const text = htmlToText(chunk);
    if (text || ts) {
      entries.push({ sender, text, ts, html: chunk });
    }
  }

  return entries;
}

function readTitle(html: string): string | undefined {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  if (!m) {
    return undefined;
  }

  const t = decodeHtml(m[1]).trim();

  return t || undefined;
}

// Recursively collect files matching a predicate (bounded; tolerant of bad dirs).
function walkFiles(dir: string, match: (name: string) => boolean, out: string[], depth = 0): void {
  if (depth > 8) {
    return;
  }

  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const d of names) {
    const full = path.join(dir, d.name);
    try {
      if (d.isDirectory()) {
        walkFiles(full, match, out, depth + 1);
      } else if (d.isFile() && match(d.name)) {
        out.push(full);
      }
    } catch {
      /* ignore */
    }
  }
}

function hasHtmlActivity(actRoot: string): boolean {
  const found: string[] = [];
  walkFiles(actRoot, (n) => /\.html$/i.test(n), found, 0);

  return found.length > 0;
}

function hasJsonActivity(actRoot: string): boolean {
  const found: string[] = [];
  walkFiles(actRoot, (n) => /^(message_\d+|post_\d+|posts_\d+)\.json$/i.test(n), found, 0);

  return found.length > 0;
}

export class InstagramFileImporter implements FileImporter {
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
        if (names.includes('your_instagram_activity')) {
          return { confidence: 0.95 };
        }

        if (names.includes('personal_information') && names.includes('media')) {
          return { confidence: 0.9 };
        }

        if (names.includes('connections') && names.includes('messages')) {
          return { confidence: 0.85 };
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

    const actRoot = fs.existsSync(path.join(root, 'your_instagram_activity'))
      ? path.join(root, 'your_instagram_activity')
      : root;

    // Decide format. Prefer JSON when present; fall back to HTML.
    const jsonPresent = hasJsonActivity(actRoot);
    if (jsonPresent) {
      await this.importJson(actRoot, params);
    }

    // HTML may coexist (or be the only format). Only run it when there is no
    // JSON message/post data, so we never double-import.
    if (!jsonPresent && hasHtmlActivity(actRoot)) {
      await this.importHtml(actRoot, params);
    }
  }

  // ---------- JSON path (unchanged behaviour) ----------

  private async importJson(actRoot: string, params: ImportParams): Promise<void> {
    const inboxDir = path.join(actRoot, 'messages', 'inbox');
    if (fs.existsSync(inboxDir)) {
      let threads: string[] = [];
      try {
        threads = fs.readdirSync(inboxDir);
      } catch {
        /* ignore */
      }

      for (const thread of threads) {
        const threadDir = path.join(inboxDir, thread);
        try {
          if (!fs.statSync(threadDir).isDirectory()) {
            continue;
          }
        } catch {
          continue;
        }

        let msgFiles: string[] = [];
        try {
          msgFiles = fs
            .readdirSync(threadDir)
            .filter((f) => /^message_\d+\.json$/i.test(f))
            .sort();
        } catch {
          /* ignore */
        }

        for (const mf of msgFiles) {
          await this.processThread(path.join(threadDir, mf), params);
        }
      }
    }

    const postsDir = path.join(actRoot, 'posts');
    if (fs.existsSync(postsDir)) {
      let postFiles: string[] = [];
      try {
        postFiles = fs.readdirSync(postsDir).filter((f) => /^(post_\d+|posts_\d+)\.json$/i.test(f));
      } catch {
        /* ignore */
      }

      for (const pf of postFiles) {
        await this.processPosts(path.join(postsDir, pf), params);
      }
    }
  }

  private async processThread(fpath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${path.basename(fpath)}`, { error: (e as Error).message });

      return;
    }

    let thread: IGThread;
    try {
      thread = JSON.parse(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${path.basename(fpath)}`, { error: (e as Error).message });

      return;
    }

    // Recipient/direction signal: the roster is participants[]; Instagram names the
    // thread after the OTHER party, so the owner is the participant that is NOT the title.
    const names = (thread.participants ?? []).map((p) => p.name).filter(Boolean);
    const owner = names.length === 2 ? names.find((n) => n !== thread.title) : undefined;
    for (const msg of thread.messages ?? []) {
      if (msg.is_unsent) {
        continue;
      }

      const ts = msg.timestamp_ms ? new Date(msg.timestamp_ms) : undefined;
      if (!timeframeContains(params.timeframe, ts)) {
        continue;
      }

      const text = msg.content ?? msg.share?.link ?? '';
      const to = names.filter((n) => n !== msg.sender_name);
      params.pipeline.push({
        item: {
          classification: 'message',
          timestamp: ts,
          content: {
            filename: path.basename(fpath),
            mediaType: 'text/plain',
            data: async () => Buffer.from(text),
          },
          metadata: {
            Sender: msg.sender_name || undefined,
            To: to.length ? to.join(', ') : undefined,
            ...(owner ? { 'From Me': msg.sender_name === owner } : {}),
            Conversation: thread.title || undefined,
            Source: 'Instagram',
            Text: text || undefined,
          },
        },
      });
    }
  }

  private async processPosts(fpath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${path.basename(fpath)}`, { error: (e as Error).message });

      return;
    }

    let posts: IGPost[];
    try {
      posts = JSON.parse(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${path.basename(fpath)}`, { error: (e as Error).message });

      return;
    }

    if (!Array.isArray(posts)) {
      return;
    }

    for (const post of posts) {
      const tsRaw = post.creation_timestamp ?? post.media?.[0]?.creation_timestamp;
      const ts = tsRaw ? new Date(tsRaw * 1000) : undefined;
      if (!timeframeContains(params.timeframe, ts)) {
        continue;
      }

      const caption = post.title ?? post.media?.[0]?.title ?? '';
      params.pipeline.push({
        item: {
          classification: 'social',
          timestamp: ts,
          content: { filename: 'post.txt', mediaType: 'text/plain', data: async () => Buffer.from(caption) },
          metadata: {
            Text: caption || undefined,
            Title: caption || undefined,
            Caption: caption || undefined,
            Source: 'Instagram',
          },
        },
      });
    }
  }

  // ---------- HTML path ----------

  private async importHtml(actRoot: string, params: ImportParams): Promise<void> {
    // 1) DMs: messages/inbox/<thread>/message_*.html and message_requests/<thread>/message_*.html
    for (const sub of ['inbox', 'message_requests']) {
      const dir = path.join(actRoot, 'messages', sub);
      if (!fs.existsSync(dir)) {
        continue;
      }

      const files: string[] = [];
      walkFiles(dir, (n) => /^message_\d+\.html$/i.test(n), files, 0);
      for (const f of files.sort()) {
        await this.processHtmlMessages(f, actRoot, params);
      }
    }

    // 2) Likes -> 'like'
    await this.processHtmlActivity(
      path.join(actRoot, 'likes', 'liked_posts.html'),
      'like',
      'Instagram like',
      params,
      { postUri: true },
    );
    await this.processHtmlActivity(
      path.join(actRoot, 'likes', 'liked_comments.html'),
      'like',
      'Instagram like',
      params,
    );

    // 3) Comments -> 'comment'
    const commentsDir = path.join(actRoot, 'comments');
    if (fs.existsSync(commentsDir)) {
      const cfiles: string[] = [];
      walkFiles(commentsDir, (n) => /\.html$/i.test(n), cfiles, 0);
      for (const f of cfiles.sort()) {
        await this.processHtmlActivity(f, 'comment', 'Instagram comment', params);
      }
    }

    // 4) Saved -> 'interaction'
    await this.processHtmlActivity(
      path.join(actRoot, 'saved', 'saved_posts.html'),
      'interaction',
      'Instagram saved',
      params,
      { postUri: true },
    );
    await this.processHtmlActivity(
      path.join(actRoot, 'saved', 'saved_collections.html'),
      'interaction',
      'Instagram saved collection',
      params,
    );

    // 5) Media -> profile photos, reposts, other content
    await this.processHtmlActivity(
      path.join(actRoot, 'media', 'profile_photos.html'),
      'photo',
      'Instagram profile photo',
      params,
    );
    await this.processHtmlActivity(
      path.join(actRoot, 'media', 'reposts.html'),
      'social',
      'Instagram repost',
      params,
      { postUri: true },
    );
    await this.processHtmlActivity(
      path.join(actRoot, 'media', 'other_content.html'),
      'media',
      'Instagram media',
      params,
    );

    // 6) Shopping -> checkout/payment info, recently viewed items
    await this.processHtmlActivity(
      path.join(actRoot, 'shopping', 'checkout_payment_information.html'),
      'purchase',
      'Instagram checkout',
      params,
    );
    await this.processHtmlActivity(
      path.join(actRoot, 'shopping', 'recently_viewed_items.html'),
      'page_view',
      'Instagram recently viewed',
      params,
    );

    // 7) Story interactions -> stories viewed
    await this.processHtmlActivity(
      path.join(actRoot, 'story_interactions', 'stories_viewed.html'),
      'interaction',
      'Instagram story viewed',
      params,
      { postUri: true },
    );

    // 8) Connections -> followers & following. Meta ships one or more numbered
    // followers_<n>.html files (split when the list is large) plus a single
    // following.html; both live under connections/followers_and_following/.
    const connectionsDir = path.join(actRoot, 'connections', 'followers_and_following');
    if (fs.existsSync(connectionsDir)) {
      const followerFiles: string[] = [];
      walkFiles(connectionsDir, (n) => /^followers(_\d+)?\.html$/i.test(n), followerFiles, 0);
      for (const f of followerFiles.sort()) {
        await this.processHtmlActivity(f, 'interaction', 'Instagram follower', params);
      }

      const followingFiles: string[] = [];
      walkFiles(connectionsDir, (n) => /^following(_\d+)?\.html$/i.test(n), followingFiles, 0);
      for (const f of followingFiles.sort()) {
        await this.processHtmlActivity(f, 'interaction', 'Instagram following', params);
      }
    }
  }

  private async processHtmlMessages(fpath: string, actRoot: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${path.basename(fpath)}`, { error: (e as Error).message });

      return;
    }

    let entries: HtmlEntry[];
    let conversation: string | undefined;
    try {
      conversation = readTitle(raw);
      entries = parseHtmlEntries(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${path.basename(fpath)}`, { error: (e as Error).message });

      return;
    }

    const threadKey = path.relative(actRoot, fpath);
    for (const [i, ent] of entries.entries()) {
      if (!timeframeContains(params.timeframe, ent.ts)) {
        continue;
      }

      // Drop the sender line from the body text if it leads the chunk.
      let text = ent.text;
      if (ent.sender && text.startsWith(ent.sender)) {
        text = text.slice(ent.sender.length).trim();
      }

      if (!text) {
        continue;
      }

      params.pipeline.push({
        item: {
          id: `instagram:msg:${threadKey}#${i}`,
          classification: 'message',
          timestamp: ent.ts,
          content: {
            filename: path.basename(fpath),
            mediaType: 'text/plain',
            data: async () => Buffer.from(text),
          },
          metadata: {
            Sender: ent.sender || undefined,
            To: conversation && conversation !== ent.sender ? conversation : undefined,
            Conversation: conversation || undefined,
            Source: 'Instagram',
            Text: text || undefined,
          },
        },
      });
    }
  }

  private async processHtmlActivity(
    fpath: string,
    classification: string,
    label: string,
    params: ImportParams,
    opts: ActivityOptions = {},
  ): Promise<void> {
    if (!fs.existsSync(fpath)) {
      return;
    }

    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${path.basename(fpath)}`, { error: (e as Error).message });

      return;
    }

    let entries: HtmlEntry[];
    try {
      entries = parseHtmlEntries(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${path.basename(fpath)}`, { error: (e as Error).message });

      return;
    }

    const filename = path.basename(fpath);
    const baseDir = exportBaseDir(fpath, raw);
    // A file whose entries ARE media ("Profile photos you've added", "Other
    // content you've added"). Such an entry without bytes is not a photo, so it
    // is dropped rather than emitted as a text/plain capture.photo.
    const mediaLane = MEDIA_LANE_CLASSIFICATIONS.has(classification);

    for (const [i, ent] of entries.entries()) {
      if (!timeframeContains(params.timeframe, ent.ts)) {
        continue;
      }

      const id = `instagram:${filename}#${i}`;
      const html = ent.html;
      const url = firstWebLink(html);
      const shortcode = url ? instagramShortcode(url) : undefined;
      const mediaPath = localMediaPath(html, baseDir);
      const head = headFieldRows(html);
      const owner = ownerOf(html);
      const caption = valueOf(head, 'Caption');
      // What makes THIS entry distinguishable from the next one, best first:
      // the entry's own name (a saved collection's "Sales") beats anything
      // nested inside it; then the caption, which is the half that actually
      // varies — 22 of this export's likes are posts by the same account, so an
      // owner-titled timeline would read "Instagram like — Companion
      // Intelligence" twenty-two times. The owner is not lost: it rides in
      // metadata.Author/Handle either way, and titles the entry (a repost, a
      // follow) whose source gives no caption at all.
      const subject =
        valueOf(head, 'Name') ??
        (caption ? clipText(caption) : undefined) ??
        owner.name ??
        owner.handle ??
        firstLinkText(html);
      const text = ent.text;

      const metadata: Metadata = {
        // `Title` — every call site passes a real human label ("Instagram
        // like", "Instagram story viewed"). Without it the canonical mapper's
        // fallback is the raw filename (canonical.ts titleFor), so every one of
        // these landed on the timeline titled "liked_posts.html". The subject
        // suffix is what makes one like distinguishable from the next.
        Title: subject ? `${label} — ${subject}` : label,
        Description: text || undefined,
        Type: label,
        Source: 'Instagram',
        // The per-entry permalink. It is the ONLY identity these entries carry
        // and it lives in an href attribute, so the tag strip that produced
        // `text` never saw it — 2,010 like/save/repost rows reached ci.content
        // with a blank text AND a blank url because of that.
        URL: url,
        PostId: shortcode,
        // Owner identity, so a later enrichment pass has a name and a handle to
        // resolve a Person from instead of a caption blob.
        Author: owner.name,
        Handle: owner.handle,
        Caption: caption,
      };

      // `URI` REPLACES the content row's source_id (push/inputs.ts
      // toContentInput), which is what collapses a like, a save, a repost and a
      // story view of the SAME post onto one content row instead of four blank
      // ones. Only minted where the entry IS a single post — a saved
      // COLLECTION holds many posts and must not adopt the identity of the
      // first one, and a liked COMMENT is not the post it hangs under.
      if (opts.postUri && shortcode) {
        metadata.URI = `instagram:p:${shortcode}`;
      }

      if (!hasSubstance(html, url, mediaPath)) {
        params.pipeline.drop?.('empty_after_parse', id);
        continue;
      }

      if (mediaLane) {
        if (!mediaPath) {
          // profile_photos.html entries used to land as text/plain 'media'
          // rows with an empty external_id and no url, and kindFor read the
          // 'media' classification as capture.photo — a photo event with no
          // photo behind it. There is nothing to import here.
          params.pipeline.drop?.('missing_media', id);
          continue;
        }

        // mediaItemFromFile classifies by the file's real MIME and stamps
        // intermediateLocation, so MediaStage uploads the bytes and the push
        // stamps metadata.FileId onto the content row.
        const media = mediaItemFromFile(mediaPath);
        params.pipeline.push({
          item: {
            ...media,
            id,
            timestamp: ent.ts,
            metadata: { ...media.metadata, ...metadata },
          },
        });
        continue;
      }

      const body = text || url || (metadata.Title as string);
      params.pipeline.push({
        item: {
          id,
          classification,
          timestamp: ent.ts,
          content: { filename, mediaType: 'text/plain', data: async () => Buffer.from(body) },
          metadata,
        },
      });
    }
  }
}

registerDataSource({
  name: 'instagram',
  title: 'Instagram',
  icon: '',
  description: 'DMs, posts, stories, follows, likes — everything in an Instagram DYI export (JSON or HTML).',
  newFileImporter: () => new InstagramFileImporter(),
});
