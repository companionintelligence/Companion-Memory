/* Twitter (X) archive datasource.

   What the account SAID is a COMMUNICATION, not a timeline event: tweets and
   replies are outbound posts, DMs are chat messages whose direction follows
   senderId vs the archive owner's accountId.

   A retweet is different — it is an ACT of sharing someone else's post, so it
   lands as an EVENT titled after the post it shared, and only when the archive
   dates it. Likes are not imported at all.

   A long-form post is truncated in tweets.js and whole in note-tweet.js, with
   no id linking the two; noteTweetTexts joins them on snowflake proximity so
   the post imports with its full body.

   Grok conversation history also ships in this archive; it imports here as well
   as from the standalone Grok card (_x_archive.ts, grok.ts).

   Media rides on its message as an attachment descriptor (metadata
   .MediaAttachments). The push uploads the bytes as a file, creates a content
   row typed image/video and pointed at the media's URL on X — only when X still
   serves that URL (durableMediaUrl) — and stamps both ids into the
   communication's `attachments` column. The content row's body is the owning
   message's text; see graphql.ts withCommunicationMedia, media.ts
   contentLabels, and mapping.ts toCommunicationInput.

   Geotagged tweets carry their coordinates on the item, so the push also
   donates a position row (mapping.ts destinationsFor).
*/
import fs from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { readStore, readManifest, importGrokChats } from './_x_archive';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Graph, Item, MediaAttachment } from './timeline';
import { timeframeContains, mimeForFile } from './timeline';

interface TwitterOptions {
  includeRetweets?: boolean;
  includeReplies?: boolean;
}

interface TweetEntityURL {
  url: string;
  expanded_url?: string;
  unwound_url?: string;
}
interface TweetUserMention {
  screen_name?: string;
  id_str?: string;
}
interface TweetMediaVariant {
  bitrate?: string;
  content_type?: string;
  url?: string;
}
interface TweetMedia {
  type?: string;
  media_url_https?: string;
  media_url?: string;
  expanded_url?: string;
  url?: string;
  video_info?: { variants?: TweetMediaVariant[] };
}
interface TweetEntities {
  urls?: TweetEntityURL[];
  user_mentions?: TweetUserMention[];
  media?: TweetMedia[];
}
interface GeoPoint {
  type?: string;
  coordinates?: Array<string | number>;
}
interface Tweet {
  id?: string;
  id_str?: string;
  created_at: string;
  full_text?: string;
  favorite_count?: string;
  retweet_count?: string;
  lang?: string;
  source?: string;
  in_reply_to_status_id_str?: string;
  in_reply_to_screen_name?: string;
  in_reply_to_user_id_str?: string;
  entities?: TweetEntities;
  extended_entities?: TweetEntities;
  geo?: GeoPoint;
  coordinates?: GeoPoint;
}
/** A long-form post's full body — see {@link noteTweetTexts}. */
interface NoteTweetUrl {
  shortUrl?: string;
  expandedUrl?: string;
}
interface NoteTweet {
  noteTweetId?: string;
  createdAt?: string;
  updatedAt?: string;
  core?: { text?: string; urls?: NoteTweetUrl[] };
}
interface DirectMessage {
  id?: string;
  senderId?: string;
  recipientId?: string;
  createdAt?: string;
  text?: string;
  mediaUrls?: string[];
  urls?: Array<{ url?: string; expanded?: string }>;
}
/**
 * One entry in a conversation's `messages`. Only `messageCreate` is something
 * somebody said; the rest are membership events, and they are the only record
 * of who a GROUP conversation's recipients are — group messages carry no
 * `recipientId` at all (see groupRecipients).
 */
interface DmEvent {
  messageCreate?: DirectMessage;
  /** Point-in-time roster, written when the conversation is first seen. */
  joinConversation?: { initiatingUserId?: string; participantsSnapshot?: string[]; createdAt?: string };
  participantsJoin?: { initiatingUserId?: string; userIds?: string[]; createdAt?: string };
  participantsLeave?: { userIds?: string[]; createdAt?: string };
}
interface DmConversation {
  conversationId?: string;
  messages?: DmEvent[];
}
/**
 * The archive owner. `accountDisplayName` is what account.js actually calls the
 * display name — a plain `displayName` never populates, which is why this
 * carries both (see ownerIdentity).
 */
interface Owner {
  accountId?: string;
  username?: string;
  displayName?: string;
  accountDisplayName?: string;
}

/** filename → full path for one of the archive's `*_media` folders. */
function mediaIndex(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }

  for (const n of names) {
    out.set(n, path.join(dir, n));
  }

  return out;
}

/** Last path segment of a media URL, minus any query string (`…mp4?tag=1`). */
function urlBasename(u: string | undefined): string | undefined {
  if (!u) {
    return undefined;
  }

  const clean = u.split('?')[0].split('#')[0];
  const base = clean.slice(clean.lastIndexOf('/') + 1);

  return base || undefined;
}

/**
 * The archive stores each attachment as `<message id>-<media basename>` inside
 * the store's `*_media` folder. WHICH basename it uses has moved across export
 * versions — a video is filed under one of its `video_info` variant names, not
 * under the thumbnail in `media_url_https` — so try every URL the entry
 * carries, then fall back to any unclaimed file filed under this message id
 * with a matching extension. `claimed` keeps two media entries on one message
 * from resolving to the same file.
 */
function findMediaFile(
  index: Map<string, string>,
  messageId: string,
  urls: Array<string | undefined>,
  claimed: Set<string>,
): string | undefined {
  const bases = urls.map(urlBasename).filter((b): b is string => !!b);
  for (const base of bases) {
    const hit = index.get(`${messageId}-${base}`);
    if (hit && !claimed.has(hit)) {
      claimed.add(hit);

      return hit;
    }
  }

  const exts = new Set(bases.map((b) => path.extname(b).toLowerCase()).filter(Boolean));
  for (const [name, full] of index) {
    if (claimed.has(full) || !name.startsWith(`${messageId}-`)) {
      continue;
    }

    if (exts.size && !exts.has(path.extname(name).toLowerCase())) {
      continue;
    }

    claimed.add(full);

    return full;
  }

  return undefined;
}

/**
 * Copy (hardlink where possible) an archive attachment into the durable media
 * store, returning the retained path.
 *
 * The unpacked inbox tree is DELETED once the import job finishes (jobs.ts
 * reclaims it) but the push that uploads these bytes runs later, so an
 * attachment referenced at its archive path would be gone before it could be
 * uploaded. Same choice sms_backup_restore makes for its MMS parts — and the
 * store is also what makes the local copy purge-eligible once the upload lands
 * (media.ts isPurgeCandidate). Best-effort: on any I/O failure the attachment
 * keeps its archive path, which still works for a same-run push.
 */
function retainAttachment(src: string, params: ImportParams): string {
  const dir = params.mediaStoreDir;
  if (!dir) {
    return src;
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    // Archive media names are already `<message id>-<hash>.<ext>`; the source
    // prefix keeps them from colliding with another importer's stored bytes.
    const dest = path.join(dir, `twitter-${path.basename(src)}`);
    if (fs.existsSync(dest)) {
      return dest;
    }

    try {
      fs.linkSync(src, dest);
    } catch {
      fs.copyFileSync(src, dest);
    }

    return dest;
  } catch {
    return src;
  }
}

/** Content type bucket for a stored file, from its MIME. */
function attachmentType(mimetype: string | undefined): MediaAttachment['type'] {
  if (mimetype?.startsWith('image/')) {
    return 'image';
  }

  if (mimetype?.startsWith('video/')) {
    return 'video';
  }

  if (mimetype?.startsWith('audio/')) {
    return 'audio';
  }

  return 'media';
}

/**
 * A tweet's attachments. `extended_entities` carries every one (up to 4);
 * `entities.media` holds only the first, and is the sole source on older
 * archives.
 */
function mediaEntriesOf(t: Tweet): TweetMedia[] {
  return t.extended_entities?.media ?? t.entities?.media ?? [];
}

/**
 * The media's URL ON X, for the content row: a photo's own URL, or a
 * video/GIF's highest-bitrate MP4 variant — `media_url_https` on a video is
 * the THUMBNAIL, not the media. Falls back to the entry's expanded permalink.
 */
function mediaUrlOnX(m: TweetMedia): string | undefined {
  if (m.type === 'video' || m.type === 'animated_gif') {
    const mp4s = (m.video_info?.variants ?? [])
      .filter((v) => v.url && v.content_type === 'video/mp4')
      .sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0));
    if (mp4s[0]?.url) {
      return mp4s[0].url;
    }
  }

  return m.media_url_https || m.media_url || m.expanded_url;
}

/**
 * The media's address for the CONTENT row, or undefined when X no longer
 * serves it.
 *
 * `ton.twitter.com` was the legacy DM attachment CDN and is retired; the
 * `dm_video`/`dm_gif` lanes on video.twimg.com are auth-gated. An address on
 * either is a broken link in the UI, which is worse than no address: dropping
 * it lets the uploaded copy's signed URL win instead (media.ts
 * MediaSyncTask.url), and the bytes are in the archive either way. Public tweet
 * media (pbs.twimg.com, `ext_tw_video`) is durable and passes through.
 */
function durableMediaUrl(u: string | undefined): string | undefined {
  if (!u) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return undefined;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'ton.twitter.com' || host === 'ton.x.com') {
    return undefined;
  }

  if (host === 'video.twimg.com' && /^\/dm_(video|gif)\//.test(parsed.pathname)) {
    return undefined;
  }

  return u;
}

// The self-link X appends to a DM that carries media expands to a permalink for
// the attachment itself, not to anywhere the author chose to point.
const DM_MEDIA_LINK = /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/messages\/media\//i;

/** Replace t.co shorteners with the destination they point at. */
function expandUrls(text: string, entities: TweetEntities | undefined): string {
  let out = text;
  for (const u of entities?.urls ?? []) {
    if (u.unwound_url) {
      out = out.replace(u.url, u.unwound_url);
    } else if (u.expanded_url) {
      out = out.replace(u.url, u.expanded_url);
    }
  }

  return out;
}

/**
 * Drop the t.co self-link X appends to the text of any message carrying media.
 *
 * It points at the attachment this row already carries — as
 * `pic.twitter.com/…` on a tweet, or a `/messages/media/…` permalink on a DM —
 * so it describes nothing. Left in, an image-only DM's entire text is that one
 * link, which reads as a URL rather than as the empty message it is, and
 * becomes the content row's body under contentLabels. Links the author actually
 * wrote are untouched; only the shorteners the media entries claim are removed.
 */
function stripMediaSelfLinks(text: string, selfLinks: Array<string | undefined>): string {
  let out = text;
  for (const url of selfLinks) {
    if (url) {
      out = out.split(url).join('');
    }
  }

  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/** `<a href="…">Twitter Web Client</a>` → `Twitter Web Client`. */
function clientName(source: string | undefined): string | undefined {
  if (!source) {
    return undefined;
  }

  const text = source.replace(/<[^>]*>/g, '').trim();

  return text || undefined;
}

/** A parsed date, or undefined when the archive's value isn't one. */
function parseDate(raw: string | undefined): Date | undefined {
  if (!raw) {
    return undefined;
  }

  const d = new Date(raw);

  return isNaN(d.getTime()) ? undefined : d;
}

// A retweet's text is the shared post verbatim behind an `RT @author:` marker;
// the archive stores no separate record of the original.
const RETWEET_PREFIX = /^RT @([A-Za-z0-9_]{1,15}):\s*/;

/**
 * One-line, length-capped snippet — the shape mapping.ts gives a title.
 *
 * Iterates by Unicode CODE POINT, not UTF-16 code unit, so an astral character
 * (almost every emoji — two UTF-16 units each) is never split. `String.prototype`
 * indexing is code-unit based, and a single-character lookback ("is the unit
 * right before the cut a high surrogate? back off by one more") only catches
 * ONE surrogate pair sitting at the boundary — two consecutive astral characters
 * there (e.g. 👽🪐) still stranded a lone high surrogate one position further in,
 * which the lookback never re-checked. `Array.from` splits on code points
 * correctly by construction, so there is no boundary math to get wrong.
 *
 * That stranded surrogate reached `ci_import.staged_items.metadata` as a bound
 * query parameter (StagedWriter.writeItem does `JSON.stringify(item.metadata)`
 * into a single ::jsonb column, not SQL-text interpolation) and Postgres's
 * jsonb parser rejects it outright ("invalid input syntax for type json") where
 * plain JS `JSON.stringify` does not — so this only ever surfaced at the
 * database, not in a unit test that stops at the JS boundary. Confirmed via a
 * real bound `pg` query against a live database, the same path StagedWriter
 * uses. Every flush batch runs in one transaction (StagedWriter.writeBatch),
 * so one such retweet silently rolled back the whole batch and every batch
 * after it — on a real X archive, this was 100% data loss for the whole run.
 */
function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  const codePoints = Array.from(one);

  if (codePoints.length <= n) {
    return one;
  }

  return codePoints.slice(0, n - 1).join('') + '…';
}

/** A geotagged tweet's coordinates, from either of the two shapes it carries. */
function tweetCoordinates(t: Tweet): { latitude: number; longitude: number } | undefined {
  // `geo` is [lat, lon]; `coordinates` is GeoJSON order [lon, lat]. Both arrive
  // as strings in the archive.
  const geo = t.geo?.coordinates;
  if (geo?.length === 2) {
    const lat = Number(geo[0]),
      lon = Number(geo[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { latitude: lat, longitude: lon };
    }
  }

  const pt = t.coordinates?.coordinates;
  if (pt?.length === 2) {
    const lon = Number(pt[0]),
      lat = Number(pt[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { latitude: lat, longitude: lon };
    }
  }

  return undefined;
}

// Matches the cap mapping.ts puts on a pushed description; keeps a pathological
// long-form post from riding through as an unbounded metadata string.
const TEXT_MAX = 4000;

/* -------------------------------------------------------------------------- *
 * Who the numeric ids are
 * -------------------------------------------------------------------------- */

/**
 * The archive owner, from account.js with manifest.js as a fallback.
 *
 * account.js spells the display name `accountDisplayName`; reading a plain
 * `displayName` off it — which this used to declare — silently yields undefined
 * forever. manifest.js records the same three fields under different names
 * again (`userName`, `displayName`), so it stands in when account.js is absent.
 */
function ownerIdentity(dataDir: string): Owner {
  const account = readStore<Owner>(dataDir, 'account', 'account')[0] ?? {};
  const info = readManifest(dataDir)?.userInfo;

  return {
    accountId: account.accountId || info?.accountId,
    username: account.username || info?.userName,
    displayName: account.accountDisplayName || account.displayName || info?.displayName,
  };
}

/**
 * Numeric account id → `@handle`, for the ids the export leaves bare.
 *
 * DMs identify everyone by account id and never by handle, so a conversation
 * imports as a row of meaningless numbers. tweets.js is the ONLY store that
 * pairs the two — `entities.user_mentions[]` carries `id_str` WITH
 * `screen_name`, and a reply carries `in_reply_to_user_id_str` with
 * `in_reply_to_screen_name`.
 *
 * This resolves whoever the account publicly @-mentioned or replied to, which
 * in a real archive was 20% of DM partners (37 of 183). The rest are
 * unresolvable from the archive alone: no other store pairs an id with a name.
 * follower/following/block/mute record `intent/user?user_id=` links — ids only —
 * and note-tweet mentions carry a screenName with no id.
 */
function handlesById(tweets: Tweet[], owner: Owner): Map<string, string> {
  const out = new Map<string, string>();
  if (owner.accountId && owner.username) {
    out.set(owner.accountId, `@${owner.username}`);
  }

  for (const t of tweets) {
    for (const u of t.entities?.user_mentions ?? []) {
      if (u.id_str && u.screen_name) {
        out.set(u.id_str, `@${u.screen_name}`);
      }
    }

    if (t.in_reply_to_user_id_str && t.in_reply_to_screen_name) {
      out.set(t.in_reply_to_user_id_str, `@${t.in_reply_to_screen_name}`);
    }
  }

  return out;
}

/**
 * The namespace an unresolvable Twitter account id is written under.
 *
 * `id:` says what the value IS. Without it the string is `twitter:<id>`, which
 * `PersonLinkStage.readHandle` reads as a platform-qualified HANDLE (its
 * `QUALIFIED_HANDLE` strips an optional `@`, so `twitter:6245902` and a real
 * `@6245902` land on the same key) — filing an account id in the handle
 * namespace, where a different kind of value lives, is the same class of
 * mistake as filing it in the phone one. The second colon takes it out of that
 * regex's reach: its value part is `[A-Za-z0-9._-]`, which no colon satisfies.
 */
const ACCOUNT_ID_NAMESPACE = 'twitter:id:';

/**
 * How a DM partner is named when the archive never says who they are.
 *
 * The bare numeric id used to ride out as the participant, and a numeric
 * participant is not inert. `classifyParticipant` types an all-digit string of
 * seven digits or more as `kind='phone'` — `PHONE_MIN_DIGITS` is 7 and there is
 * no upper bound, while a Twitter snowflake is 18-19 digits — and
 * `normalizePhone` then keeps its LAST TEN DIGITS. So an account id became a
 * Person named after itself holding a phone number that belongs to nobody:
 *
 *   223 digit-named `Person` rows on a fresh full-corpus import, 214 of them
 *   Twitter DM partners, carrying 213 fabricated `phone` identifiers. 119 are
 *   7-15 digits and therefore indistinguishable from a real number; of the 103
 *   snowflakes, 87 reduce to a last-ten that even starts with a valid NANP
 *   area-code digit.
 *
 * That is not only clutter. `PersonLinkStage` matches `phone_last10` at 0.85
 * confidence, so a fabricated number that happens to equal a real contact's
 * merges a stranger's DMs into a real person. No such collision exists on this
 * corpus — all 213 values were checked — which makes it latent, not realised,
 * and is the argument for closing it before a corpus arrives where it does.
 *
 * The namespaced form cannot be misread: `classifyParticipant` and
 * `PersonLinkStage.classifyIdentifier` both require PHONE-SHAPED (`+()-./`,
 * whitespace and digits, nothing else) before counting digits, and letters and
 * colons fail that outright. It stays keyable — no identity is lost, which
 * matters because a DM has a real correspondent and dropping the participant
 * would leave the message with none: both classifiers fall through to
 * `kind='name'`, whose `normalizeName` lower-cases a value that is already
 * lower-case and stable, and `isNonNameParticipant` refuses none of it (no
 * newline, no call-log heading, no export extension). `splitPersonName` reads
 * one token, so no first/last name is invented either.
 *
 * The id itself is NOT lost by this: `metadata.SenderId` / `RecipientIds`
 * carry the raw values, and always did.
 */
function accountRef(id: string): string {
  return `${ACCOUNT_ID_NAMESPACE}${id}`;
}

/* -------------------------------------------------------------------------- *
 * Group conversation membership
 * -------------------------------------------------------------------------- */

/** When an event happened, whichever kind it is. */
function dmEventTime(e: DmEvent): number {
  const raw =
    e.messageCreate?.createdAt ??
    e.joinConversation?.createdAt ??
    e.participantsJoin?.createdAt ??
    e.participantsLeave?.createdAt;
  const d = parseDate(raw);

  return d ? d.getTime() : 0;
}

/**
 * Recipients for every message in a GROUP conversation, keyed by message id.
 *
 * A group `messageCreate` has no `recipientId` — not one of 2116 in a real
 * archive — so without this a group DM imports with no recipients at all. Who
 * was in the conversation is recorded only in the membership events sitting
 * alongside the messages: a `joinConversation` roster snapshot, plus
 * `participantsJoin` / `participantsLeave`.
 *
 * The roster is everyone the archive shows in the conversation — snapshot
 * members, joiners, and anyone who spoke — minus those who had already left by
 * the time of each message. That last part needs the events in time order, and
 * they are NOT stored that way: the arrays are unsorted, and one conversation's
 * events are split across several `dmConversation` rows, so callers must merge
 * by conversationId before calling this.
 *
 * The approximation this leaves: the export records when people LEFT but rarely
 * when they joined, so someone who joined midway looks present from the start.
 * Over-reporting a member beats reporting none, and departures — the case the
 * archive does document — are handled exactly.
 */
function groupRecipients(events: DmEvent[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  // Seed with everyone known to belong, since join events are mostly absent.
  const live = new Set<string>();
  for (const e of events) {
    if (e.messageCreate?.senderId) {
      live.add(e.messageCreate.senderId);
    }

    for (const id of e.joinConversation?.participantsSnapshot ?? []) {
      live.add(id);
    }

    if (e.joinConversation?.initiatingUserId) {
      live.add(e.joinConversation.initiatingUserId);
    }

    for (const id of e.participantsJoin?.userIds ?? []) {
      live.add(id);
    }
  }

  for (const e of [...events].sort((a, b) => dmEventTime(a) - dmEventTime(b))) {
    // A departure applies from here on, so it is removed as the walk reaches it.
    for (const id of e.participantsLeave?.userIds ?? []) {
      live.delete(id);
    }

    const dm = e.messageCreate;
    if (!dm?.id) {
      continue;
    }

    out.set(
      dm.id,
      [...live].filter((id) => id !== dm.senderId),
    );
  }

  return out;
}

/* -------------------------------------------------------------------------- *
 * Long-form posts (note tweets)
 * -------------------------------------------------------------------------- */

/**
 * A snowflake id's mint time in epoch ms. Twitter ids are `timestamp << 22`
 * over a custom epoch; undefined for anything that isn't one.
 */
function snowflakeMs(id: string | undefined): number | undefined {
  if (!id || !/^\d+$/.test(id)) {
    return undefined;
  }

  try {
    return Number((BigInt(id) >> 22n) + 1288834974657n);
  } catch {
    return undefined;
  }
}

/**
 * How far after its note's id a tweet's id may be minted. Observed deltas in a
 * real archive were 10–84ms across 29 posts, and the nearest NON-matching tweet
 * was 454ms away — so this sits ~6x above every true match and just under the
 * closest false one. Widening it risks the one failure that matters (a 2400-char
 * body attached to the wrong post); a delta past it declines the join instead,
 * which only leaves the text as truncated as it is today.
 */
const NOTE_JOIN_WINDOW_MS = 500;

/** Enough of the note's opening to confirm a candidate is the post that shipped it. */
const NOTE_PREFIX_LEN = 30;

/**
 * Full bodies for the account's long-form posts, keyed by TWEET id.
 *
 * A post over ~280 characters is stored TWICE and neither copy is complete on
 * its own: `tweets.js` truncates the body mid-word and appends a bare "show
 * more" t.co, while `note-tweet.js` holds the whole text but records no tweet
 * id. Reading only tweets.js — which is what this importer did — silently
 * truncated every long-form post (one 2480-char post imported as 302).
 *
 * The join is the ids: a note and its tweet are snowflakes minted in the SAME
 * publish request, note first, tens of milliseconds apart. So the tweet is the
 * single id inside {@link NOTE_JOIN_WINDOW_MS} AFTER the note's, confirmed by
 * the note's opening still prefixing the truncated text.
 *
 * Why not the obvious keys: `created_at` misses posts whose note is stamped a
 * second off, and is ambiguous anyway (21 timestamps in one real archive are
 * shared by up to 4 tweets). The `truncated` flag is `false` on every row. A
 * trailing `…` mostly marks legacy 140-char retweet truncation, not long form.
 * Matching on text alone can't separate the same note posted twice.
 *
 * Every guard fails CLOSED — an unmatched note leaves its tweet exactly as it
 * imports today and reports a drop, because a wrong body on a real post is a
 * worse outcome than a short one.
 */
function noteTweetTexts(dataDir: string, tweets: Tweet[], params: ImportParams): Map<string, string> {
  const out = new Map<string, string>();
  const notes = readStore<NoteTweet>(dataDir, 'note-tweet', 'noteTweet');
  if (notes.length === 0) {
    return out;
  }

  // Tweets by mint time, so each note reads a window instead of the whole file.
  const timeline = tweets
    .map((t) => ({ id: t.id_str || t.id, ms: snowflakeMs(t.id_str || t.id), tweet: t }))
    .filter((e): e is { id: string; ms: number; tweet: Tweet } => !!e.id && e.ms !== undefined)
    .sort((a, b) => a.ms - b.ms);

  for (const note of notes) {
    const noteMs = snowflakeMs(note.noteTweetId);
    // `core.text` is the AUTHORED body: it omits the trailing card/quote link
    // that full_text carries, so it is not always the longer of the two.
    const raw = note.core?.text;
    const detail = note.noteTweetId ?? note.createdAt ?? 'unknown note';
    if (noteMs === undefined || !raw) {
      params.pipeline.drop?.('note_tweet_unmatched', detail);
      continue;
    }

    // First tweet minted at or after the note, then forward through the window.
    let lo = 0,
      hi = timeline.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (timeline[mid].ms < noteMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    const prefix = raw.slice(0, NOTE_PREFIX_LEN);
    const hits: Array<{ id: string; tweet: Tweet }> = [];
    for (let i = lo; i < timeline.length && timeline[i].ms - noteMs <= NOTE_JOIN_WINDOW_MS; i++) {
      // The retweet of a note opens `RT @author:`, so the prefix check also
      // keeps a shared post from claiming the original's body.
      if (!(timeline[i].tweet.full_text ?? '').startsWith(prefix)) {
        continue;
      }

      hits.push(timeline[i]);
    }

    // Two candidates means the window can't tell which post shipped this body.
    if (hits.length !== 1 || out.has(hits[0].id)) {
      params.pipeline.drop?.('note_tweet_unmatched', detail);
      continue;
    }

    const [{ id, tweet }] = hits;
    // The note's own t.co shorteners come with their destinations, in a shape
    // of their own (shortUrl/expandedUrl rather than url/expanded_url).
    const text = expandUrls(raw, {
      urls: (note.core?.urls ?? [])
        .filter((u): u is { shortUrl: string; expandedUrl?: string } => !!u.shortUrl)
        .map((u) => ({ url: u.shortUrl, expanded_url: u.expandedUrl })),
    });
    // Only a LONGER body is an improvement; on the short-note case above,
    // substituting would delete the link full_text appended.
    if (text.length <= (tweet.full_text ?? '').length) {
      continue;
    }

    out.set(id, text);
  }

  return out;
}

export class TwitterFileImporter implements FileImporter {
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
      const manifestPath = path.join(root, 'data', 'manifest.js');
      let text: string | undefined;
      try {
        text = await readFile(manifestPath, 'utf8');
      } catch {
        /* absent or unreadable — not an X archive */
      }

      if (text !== undefined) {
        // manifest starts with something like 'window.YTD.manifest.part0 = '\n{"archiveInfo":{...}}
        const idx = text.indexOf('=');
        if (idx !== -1) {
          try {
            const json = JSON.parse(text.slice(idx + 1).trim());
            const gen = json.archiveInfo?.generationDate;

            return { confidence: 0.95, snapshot_date: gen ? new Date(gen) : undefined };
          } catch {
            /* ignore */
          }
        }

        return { confidence: 0.9 };
      }
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return;
    }

    const dataDir = path.join(root, 'data');
    if (!fs.existsSync(dataDir)) {
      return;
    }

    // The archive owner: `senderId === accountId` is the only signal the export
    // gives for DM direction, and the username builds tweet permalinks.
    const owner = ownerIdentity(dataDir);
    const opts = (params.options ?? {}) as TwitterOptions;

    // `tweets.js` on current exports, `tweet.js` on older ones. Read here rather
    // than inside importTweets because the DM lane needs it too: it is the only
    // store that says which handle a numeric account id belongs to.
    const tweets = [
      ...readStore<Tweet>(dataDir, 'tweets', 'tweet'),
      ...readStore<Tweet>(dataDir, 'tweet', 'tweet'),
    ];
    const handles = handlesById(tweets, owner);

    this.importTweets(tweets, dataDir, owner, opts, params);
    this.importDirectMessages(dataDir, owner, handles, params);
    // Grok ships inside the X archive, so the Twitter card imports it too —
    // those rows keep `Source: 'Grok'` (see _x_archive.ts importGrokChats).
    importGrokChats(root, params);
  }

  /* ---------------------------------------------------------------------- *
   * Tweets — the account's own posts, always outbound.
   * ---------------------------------------------------------------------- */
  private importTweets(
    tweets: Tweet[],
    dataDir: string,
    owner: Owner,
    opts: TwitterOptions,
    params: ImportParams,
  ): void {
    if (tweets.length === 0) {
      return;
    }

    // How many rows tweets.js/tweet.js actually offered the parser — the
    // floor `reconciled` checks every produced/dropped tweet against. A tweet
    // whose media is missing ALSO drops (see collectTweetMedia/pushRetweet)
    // without removing the tweet itself, so those report their own extra
    // consumed() unit at the point they drop, additive to this one.
    params.pipeline.consumed?.(tweets.length);

    // Long-form bodies, which tweets.js only carries truncated.
    const noteTexts = noteTweetTexts(dataDir, tweets, params);
    const index = mediaIndex(path.join(dataDir, 'tweets_media'));
    const claimed = new Set<string>();
    const handle = owner.username ? `@${owner.username}` : undefined;

    for (const t of tweets) {
      const id = t.id_str || t.id;
      if (!id) {
        params.pipeline.drop?.('tweet_without_id');

        continue;
      }

      const created = parseDate(t.created_at);
      if (!timeframeContains(params.timeframe, created)) {
        params.pipeline.drop?.('outside_timeframe');

        continue;
      }

      const isRetweet = RETWEET_PREFIX.test(t.full_text ?? '');
      const isReply = !!t.in_reply_to_status_id_str;
      // Both default on (newOptions), so an ordinary import keeps everything.
      if (isRetweet && opts.includeRetweets === false) {
        params.pipeline.drop?.('excluded_retweet', id);
        continue;
      }

      if (isReply && opts.includeReplies === false) {
        params.pipeline.drop?.('excluded_reply', id);
        continue;
      }

      // A retweet isn't something the account said — it's an act of sharing,
      // and it lands as an event instead.
      if (isRetweet) {
        this.pushRetweet(t, id, created, owner, params);
        continue;
      }

      const entities = t.entities ?? {};
      // The media entries' `url` is the t.co self-link X appended to the text
      // for the attachments this row carries — noise once the media rides as an
      // attachment of its own.
      // A matched long-form body REPLACES the truncated one — it arrives with
      // its own links already expanded, and without the bare "show more" t.co
      // that tweets.js appends in place of the rest of the post.
      const text = stripMediaSelfLinks(
        noteTexts.get(id) ?? expandUrls(t.full_text ?? '', entities),
        mediaEntriesOf(t).map((m) => m.url),
      ).slice(0, TEXT_MAX);
      const media = this.collectTweetMedia(t, id, index, claimed, params);
      // A reply is addressed to the account it answers; a plain tweet is
      // addressed to whoever it mentions.
      const to = [
        t.in_reply_to_screen_name ? `@${t.in_reply_to_screen_name}` : undefined,
        ...(entities.user_mentions ?? []).map((u) => (u.screen_name ? `@${u.screen_name}` : undefined)),
      ].filter((v): v is string => !!v);
      const coords = tweetCoordinates(t);

      const item: Item = {
        // Prefixed so a bare snowflake can't collide with another source's id —
        // and so a tweet the account also LIKED stays a separate row.
        id: `twitter:tweet:${id}`,
        classification: 'message',
        timestamp: created,
        location: coords,
        content: {
          filename: `${id}.txt`,
          mediaType: 'text/plain',
          data: async () => Buffer.from(text),
        },
        metadata: {
          Text: text,
          CommunicationType: 'post',
          Direction: 'sent',
          Sender: handle,
          SenderName: owner.displayName,
          SenderId: owner.accountId,
          To: to.length ? [...new Set(to)] : undefined,
          // A reply belongs to the thread it answers; a standalone tweet opens
          // its own.
          ThreadId: t.in_reply_to_status_id_str || id,
          URL: owner.username
            ? `https://x.com/${owner.username}/status/${id}`
            : `https://x.com/i/web/status/${id}`,
          Retweets: parseInt(t.retweet_count ?? '0', 10) || 0,
          Likes: parseInt(t.favorite_count ?? '0', 10) || 0,
          Kind: isReply ? 'reply' : 'tweet',
          ReplyTo: t.in_reply_to_status_id_str,
          Lang: t.lang,
          Client: clientName(t.source),
          MediaAttachments: media.length ? media : undefined,
          Source: 'Twitter',
        },
      };
      const g: Graph = { item };
      params.pipeline.push(g);
    }
  }

  /**
   * A retweet as a timeline EVENT, titled after the post it shared.
   *
   * Only a DATED retweet is worth a row: `created_at` is when the account
   * shared the post, and without it the event could only be pinned to import
   * time — a false point on the timeline. An undated retweet produces nothing.
   */
  private pushRetweet(
    t: Tweet,
    id: string,
    created: Date | undefined,
    owner: Owner,
    params: ImportParams,
  ): void {
    if (!created) {
      params.pipeline.drop?.('undated_retweet', id);

      return;
    }

    const full = expandUrls(t.full_text ?? '', t.entities).slice(0, TEXT_MAX);
    const m = RETWEET_PREFIX.exec(full);
    const author = m?.[1] ? `@${m[1]}` : undefined;
    // The shared post's own text is the archive's only description of it, so
    // its inferred title is that text — the same snippet mapping.ts titles a
    // text-bearing row by.
    const shared = m ? full.slice(m[0].length) : full;
    const title = `Retweeted ${clip(shared, 80) || author || 'a post'}`;
    // The original's media rides in extended_entities, but an event carries no
    // attachment lane (that belongs to communications), so it isn't imported.
    const mediaCount = mediaEntriesOf(t).length;
    if (mediaCount) {
      // A second ledger event riding the same tweet: the retweet itself still
      // gets pushed below, so this drop is additive to the tweets.length unit
      // already reported for this row, not a replacement for it.
      params.pipeline.drop?.('retweet_media_not_imported', `${id} (${mediaCount})`);
      params.pipeline.consumed?.(1);
    }

    params.pipeline.push({
      item: {
        id: `twitter:retweet:${id}`,
        classification: 'social',
        timestamp: created,
        location: tweetCoordinates(t),
        content: {
          filename: `${id}.txt`,
          mediaType: 'text/plain',
          data: async () => Buffer.from(full),
        },
        metadata: {
          Title: title,
          Text: full,
          RetweetOf: author,
          URL: owner.username
            ? `https://x.com/${owner.username}/status/${id}`
            : `https://x.com/i/web/status/${id}`,
          Retweets: parseInt(t.retweet_count ?? '0', 10) || 0,
          Likes: parseInt(t.favorite_count ?? '0', 10) || 0,
          Kind: 'retweet',
          Lang: t.lang,
          Client: clientName(t.source),
          Source: 'Twitter',
        },
      },
    });
  }

  /** Attachment descriptors for one tweet, retained into the media store. */
  private collectTweetMedia(
    t: Tweet,
    id: string,
    index: Map<string, string>,
    claimed: Set<string>,
    params: ImportParams,
  ): MediaAttachment[] {
    const entries = mediaEntriesOf(t);
    const out: MediaAttachment[] = [];
    for (const m of entries) {
      const urlOnX = mediaUrlOnX(m);
      const candidates = [
        m.media_url_https,
        m.media_url,
        ...(m.video_info?.variants ?? []).map((v) => v.url),
      ];
      const file = findMediaFile(index, id, candidates, claimed);
      if (!file) {
        // The archive references media whose bytes it didn't ship — record the
        // loss instead of silently dropping the attachment. The tweet itself
        // still gets pushed, so this is an extra ledger unit riding the same
        // tweets.length row, not a substitute for it.
        params.pipeline.drop?.('media_file_missing', urlOnX ?? `${id} (${m.type ?? 'media'})`);
        params.pipeline.consumed?.(1);
        continue;
      }

      const retained = retainAttachment(file, params);
      const mimetype = mimeForFile(retained);
      out.push({
        path: retained,
        filename: path.basename(file),
        type: attachmentType(mimetype),
        mimetype,
        url: durableMediaUrl(urlOnX),
      });
    }

    return out;
  }

  /* ---------------------------------------------------------------------- *
   * Direct messages — one-to-one and group. Direction follows the sender.
   * ---------------------------------------------------------------------- */
  private importDirectMessages(
    dataDir: string,
    owner: Owner,
    handles: Map<string, string>,
    params: ImportParams,
  ): void {
    const lanes: Array<{ base: string; dir: string; group: boolean }> = [
      { base: 'direct-messages', dir: 'direct_messages_media', group: false },
      { base: 'direct-messages-group', dir: 'direct_messages_group_media', group: true },
    ];
    // A handle when the archive lets us name the account, a NAMESPACED account
    // id otherwise — see accountRef for why the bare id cannot ride out.
    const who = (id: string): string => handles.get(id) ?? accountRef(id);

    for (const lane of lanes) {
      const conversations = readStore<DmConversation>(dataDir, lane.base, 'dmConversation');
      if (conversations.length === 0) {
        continue;
      }

      // How many conversation events this lane's file actually offered the
      // parser. A join/leave/rename event (no messageCreate) is a real,
      // expected member of this count — see the `dm_non_message_event` drop
      // below — not a loss, so it still needs its own consumed() unit.
      const laneTotal = conversations.reduce((sum, c) => sum + (c.messages?.length ?? 0), 0);
      params.pipeline.consumed?.(laneTotal);

      const index = mediaIndex(path.join(dataDir, lane.dir));
      const claimed = new Set<string>();
      // Group recipients live in membership events, not on the messages — and
      // one conversation's events are split across several rows, so they are
      // merged by conversationId before the roster is walked.
      const rosters = new Map<string, Map<string, string[]>>();
      if (lane.group) {
        const merged = new Map<string, DmEvent[]>();
        for (const convo of conversations) {
          const key = convo.conversationId ?? '';
          merged.set(key, [...(merged.get(key) ?? []), ...(convo.messages ?? [])]);
        }

        for (const [key, events] of merged) {
          rosters.set(key, groupRecipients(events));
        }
      }

      for (const convo of conversations) {
        for (const entry of convo.messages ?? []) {
          const dm = entry.messageCreate;
          // Non-message conversation events (joins, leaves, renames) have no
          // messageCreate — nothing was communicated.
          if (!dm?.id) {
            params.pipeline.drop?.('non_message');

            continue;
          }

          const created = parseDate(dm.createdAt);
          if (!timeframeContains(params.timeframe, created)) {
            params.pipeline.drop?.('outside_timeframe');

            continue;
          }

          // A DM carrying media gets a self-link appended whose `expanded` is a
          // permalink to that attachment. Expanding it would leave an
          // image-only DM's text as a bare /messages/media/ URL, so it's
          // stripped instead; every other link still expands.
          const dmUrls = (dm.urls ?? []).filter((u): u is { url: string; expanded?: string } => !!u.url);
          const isSelfLink = (u: { expanded?: string }) => DM_MEDIA_LINK.test(u.expanded ?? '');
          const text = stripMediaSelfLinks(
            expandUrls(dm.text ?? '', {
              urls: dmUrls
                .filter((u) => !isSelfLink(u))
                .map((u) => ({ url: u.url, expanded_url: u.expanded })),
            }),
            dmUrls.filter(isSelfLink).map((u) => u.url),
          ).slice(0, TEXT_MAX);
          const media = this.collectDmMedia(dm, index, claimed, params);
          const outbound = !!owner.accountId && dm.senderId === owner.accountId;
          // A 1:1 message names its recipient; a group message names nobody, so
          // the roster stands in.
          const recipientIds = lane.group
            ? (rosters.get(convo.conversationId ?? '')?.get(dm.id) ?? [])
            : dm.recipientId
              ? [dm.recipientId]
              : [];

          const item: Item = {
            id: `twitter:dm:${dm.id}`,
            classification: 'message',
            timestamp: created,
            content: {
              filename: `${dm.id}.txt`,
              mediaType: 'text/plain',
              data: async () => Buffer.from(text),
            },
            metadata: {
              Text: text,
              CommunicationType: 'chat',
              Direction: outbound ? 'sent' : 'received',
              // Only the owner's name is in the archive; nobody else's is.
              SenderName: outbound ? owner.displayName : undefined,
              // The export identifies DM participants by numeric account id and
              // never by handle, so these are resolved against the id→handle
              // pairs tweets.js carries — falling back to a NAMESPACED account id
              // (see accountRef), which is all the archive knows for most
              // people. The raw ids ride along unchanged in SenderId /
              // RecipientIds: they are the durable key CI-Server resolves
              // against, and a handle can be reassigned to a different account.
              Sender: dm.senderId ? who(dm.senderId) : undefined,
              SenderId: dm.senderId,
              To: recipientIds.length ? recipientIds.map(who) : undefined,
              RecipientIds: recipientIds.length ? recipientIds : undefined,
              ThreadId: convo.conversationId,
              Kind: lane.group ? 'group_dm' : 'dm',
              MediaAttachments: media.length ? media : undefined,
              Source: 'Twitter',
            },
          };
          params.pipeline.push({ item });
        }
      }
    }
  }

  /** Attachment descriptors for one DM, retained into the media store. */
  private collectDmMedia(
    dm: DirectMessage,
    index: Map<string, string>,
    claimed: Set<string>,
    params: ImportParams,
  ): MediaAttachment[] {
    const out: MediaAttachment[] = [];
    for (const url of dm.mediaUrls ?? []) {
      const file = findMediaFile(index, dm.id!, [url], claimed);
      if (!file) {
        // The DM itself still gets pushed, so this is an extra ledger unit
        // riding the same laneTotal row, not a substitute for it.
        params.pipeline.drop?.('media_file_missing', url);
        params.pipeline.consumed?.(1);
        continue;
      }

      const retained = retainAttachment(file, params);
      const mimetype = mimeForFile(retained);
      out.push({
        path: retained,
        filename: path.basename(file),
        type: attachmentType(mimetype),
        mimetype,
        url: durableMediaUrl(url),
      });
    }

    return out;
  }
}

registerDataSource({
  name: 'twitter',
  title: 'Twitter',
  icon: 'twitter.svg',
  description: 'Twitter/X archive (tweets, retweets, DMs, media)',
  newOptions: () => ({ includeReplies: true, includeRetweets: true }) as TwitterOptions,
  newFileImporter: () => new TwitterFileImporter(),
});
