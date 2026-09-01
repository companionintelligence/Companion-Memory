/* One Google "My Activity" cell, as YouTube activity.
 *
 * Google writes YouTube history in the same MDL markup in two places: the
 * YouTube Takeout's own `history/watch-history.html` / `search-history.html`,
 * and the account-wide My Activity export (`My Activity/YouTube/MyActivity.html`,
 * or a standalone `MyActivity.html` downloaded from myactivity.google.com). Both
 * importers feed cells through here so a watch lands identically — same
 * classification, same metadata, same `youtube:` id — whichever file it came
 * from, and a re-import from the other file dedups instead of doubling.
 *
 *   Watched <a href=…/watch?v=ID>Title</a><br><a href=…/channel/UC…>Channel</a><br>Jun 18, 2026, 7:30:56 PM PDT<br>
 *   Searched for <a href=…/results?search_query=q>q</a><br>Jun 14, 2026, 8:58:05 PM PDT<br>
 *   Liked <a href=…/watch?v=ID>Title</a><br>…
 *   Subscribed to <a href=…/channel/UC…>Channel</a><br>…
 */
import crypto from 'node:crypto';

import { youtubeLikeIdentity, youtubeSubscriptionIdentity, youtubeVideoIdFromUrl } from '@ci/domains/memory';

import type { Graph } from './timeline';

const ANCHOR_RE = /<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

/** `true` for the My Activity product headers that carry YouTube activity. */
export function isYouTubeProduct(product: string | undefined): boolean {
  const p = (product ?? '').trim().toLowerCase();

  return p === 'youtube' || p === 'youtube music';
}

export function sha1(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex');
}

// Minimal HTML-entity decode for the few entities MyActivity emits.
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&emsp;/g, ' ');
}

// Google writes the timestamp with a narrow no-break space (U+202F) and a
// trailing TZ abbreviation (e.g. "Jun 18, 2026, 7:30:56 PM PDT"). Normalise the
// exotic spaces; V8's Date parser understands the rest including the TZ.
export function parseActivityDate(raw: string | undefined): Date | undefined {
  if (!raw) {
    return undefined;
  }

  const norm = raw.replace(/[\u202F\u00A0]/g, ' ').trim();
  if (!norm) {
    return undefined;
  }

  const d = new Date(norm);

  return isNaN(d.getTime()) ? undefined : d;
}

// Removed/private videos carry no title (video.text === video.url in the HTML
// path, or a blank e.title in the JSON path). Leaving metadata.Title undefined
// there made the title-derivation fall back to content.filename — the literal,
// uninformative "watch.txt" for every such row. Fall back to something that
// actually identifies the video instead.
export function watchTitle(title: string, channel: string, url: string): string | undefined {
  return title || channel || url || undefined;
}

export interface ActivityCell {
  /** The action phrase before the first anchor: "Watched", "Searched for", "Liked". */
  verb: string;
  anchors: Array<{ url: string; text: string }>;
  /** The trailing timestamp line, when it parsed. */
  ts?: Date;
}

/** Splits one body cell's inner HTML into verb, anchors and timestamp. */
export function parseActivityCell(cell: string): ActivityCell {
  const verbMatch = /^([\s\S]*?)<a /.exec(cell);
  const verb = verbMatch
    ? decodeEntities(verbMatch[1].replace(/<[^>]*>/g, ''))
        .replace(/[\u202F\u00A0]/g, ' ')
        .trim()
    : '';

  const anchors: Array<{ url: string; text: string }> = [];
  ANCHOR_RE.lastIndex = 0;
  let a: RegExpExecArray | null;
  while ((a = ANCHOR_RE.exec(cell)) !== null) {
    anchors.push({
      url: decodeEntities(a[1]),
      text: decodeEntities(a[2].replace(/<[^>]*>/g, '')).trim(),
    });
  }

  // The timestamp is the trailing text node after the last <br>.
  const lines = cell
    .replace(/<[^>]*>/g, '\n')
    .split('\n')
    .map((l) =>
      decodeEntities(l)
        .replace(/[\u202F\u00A0]/g, ' ')
        .trim(),
    )
    .filter(Boolean);
  const ts = parseActivityDate(lines[lines.length - 1]);

  return { verb, anchors, ts };
}

/** `UC…` channel id from a /channel/ URL, for the same id subscriptions.csv mints. */
function channelIdFrom(url: string): string | undefined {
  const m = /youtube\.com\/channel\/([A-Za-z0-9_-]{10,})/.exec(url);

  return m?.[1];
}

function activityId(url: string, ts: Date | undefined, index: number, prefix = 'youtube:'): string {
  return prefix + (url || ts ? sha1(`${url} ${ts?.toISOString() ?? ''}`) : String(index));
}

export interface YouTubeActivityOptions {
  /** Per-file parse position; only used as the id of last resort. */
  index: number;
  /** The file is search history: every cell is a search even without a verb. */
  isSearch?: boolean;
  /** Set when the importer running the job is not `youtube` (My Activity). */
  dataSource?: string;
}

/**
 * The item graph for a YouTube activity cell, or `null` when the verb is one
 * this module does not model (Viewed a post, Dismissed a shelf, Visited a
 * channel page…) — the caller keeps its generic handling for those.
 */
export function youtubeActivityGraph(cell: ActivityCell, opts: YouTubeActivityOptions): Graph | null {
  const { verb, anchors, ts } = cell;
  if (!anchors.length) {
    return null;
  }

  const stamp = opts.dataSource ? { dataSource: opts.dataSource } : {};

  if (opts.isSearch || /^Searched/i.test(verb)) {
    const query = anchors[0].text;
    const url = anchors[0].url;

    return {
      item: {
        ...stamp,
        id: activityId(url, ts, opts.index),
        classification: 'search',
        timestamp: ts,
        content: { filename: 'search.txt', mediaType: 'text/plain', data: async () => Buffer.from(query) },
        metadata: {
          Title: query || undefined,
          Text: query || undefined,
          Query: query || undefined,
          URL: url || undefined,
          Kind: 'search',
          Source: 'YouTube',
        },
      },
    } as Graph;
  }

  if (/^Watched\b/i.test(verb) || /^Liked\b/i.test(verb)) {
    // First anchor is the video (title may equal the URL for removed/private
    // videos); a second anchor, when present, is the channel.
    const liked = /^Liked\b/i.test(verb);
    const video = anchors[0];
    const channel = anchors[1];
    const title = video.text && video.text !== video.url ? video.text : '';
    const url = video.url;

    // A like keys on the VIDEO id when the URL carries one — the identity the
    // YouTube Data API connection mints for the same liked video, so the two
    // pipelines converge on one row (docs/design/cross-pipeline-identity.md;
    // a real run duplicated 100% of the overlap on hashed URLs). Re-likes of
    // one video collapse deliberately: the API side is a liked-videos LIST,
    // one row per video. URL-less likes (removed/private videos) keep the
    // per-pipeline hash lane. Watches stay hash-keyed — the API exposes no
    // watch history, so there is nothing to converge with.
    const likedVideoId = liked ? youtubeVideoIdFromUrl(url) : null;

    return {
      item: {
        ...stamp,
        id: likedVideoId
          ? youtubeLikeIdentity(likedVideoId).id
          : activityId(url, ts, opts.index, liked ? 'youtube:like:' : 'youtube:'),
        classification: liked ? 'like' : 'watch',
        timestamp: ts,
        content: {
          filename: liked ? 'like.txt' : 'watch.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(url || title),
        },
        metadata: {
          Title: watchTitle(title, channel?.text ?? '', url),
          URL: url || undefined,
          Channel: channel?.text || undefined,
          ChannelUrl: channel?.url || undefined,
          Kind: liked ? 'like' : undefined,
          Source: 'YouTube',
        },
      },
    } as Graph;
  }

  if (/^Subscribed to\b/i.test(verb)) {
    const channel = anchors[0];
    const channelId = channelIdFrom(channel.url);
    const name = channel.text && channel.text !== channel.url ? channel.text : '';

    return {
      item: {
        ...stamp,
        // Same id subscriptions.csv mints, so the dated action and the
        // undated library row collapse onto one subscription.
        // Same identity subscriptions.csv (youtube.ts) and the connection's
        // subscriptions sync mint for this channel, so all three collapse.
        id: channelId ? youtubeSubscriptionIdentity(channelId).id : activityId(channel.url, ts, opts.index),
        classification: 'subscription',
        timestamp: ts,
        content: {
          filename: 'subscription.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(name || channel.url),
        },
        metadata: {
          Title: name || channel.url || undefined,
          Channel: name || undefined,
          ChannelId: channelId,
          URL: channel.url || undefined,
          Kind: 'subscription',
          Source: 'YouTube',
        },
      },
    } as Graph;
  }

  return null;
}
