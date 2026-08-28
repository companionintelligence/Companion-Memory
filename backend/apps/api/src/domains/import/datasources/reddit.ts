/* Reddit — GDPR CSV export (posts.csv, comments.csv, saved_*, votes, subs, purchases). */
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import { csvHeaderHas } from './sniff';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

// "2021-01-01 12:00:00 UTC" → Date
function parseRedditDate(s: string): Date | undefined {
  if (!s) {
    return undefined;
  }

  const d = new Date(s.replace(' UTC', 'Z').replace(' ', 'T'));

  return isNaN(d.getTime()) ? undefined : d;
}

// Reddit permalinks embed the post's title slug:
//   /r/ecommerce/comments/xfkamy/made_a_shopping_district_experience/ → "Made a shopping district experience"
// saved_posts/saved_comments carry ONLY a permalink, so this is the sole title
// signal for them — otherwise they fall back to the content filename ("post.txt").
function slugTitle(permalink: string | undefined): string | undefined {
  if (!permalink) {
    return undefined;
  }

  const segments = permalink.replace(/\/+$/, '').split('/').filter(Boolean);
  const ci = segments.indexOf('comments'); // …/comments/<id>/<slug>[/comment/<cid>]
  const slug = ci >= 0 ? segments[ci + 2] : segments[segments.length - 1];
  // Skip bare ids (e.g. "xfkamy") — only underscored slugs are real titles.
  if (!slug || !slug.includes('_')) {
    return undefined;
  }

  const words = slug.replace(/[_-]+/g, ' ').trim();
  if (!words) {
    return undefined;
  }

  return words.charAt(0).toUpperCase() + words.slice(1);
}

function subredditFromPermalink(permalink: string | undefined): string | undefined {
  if (!permalink) {
    return undefined;
  }

  const m = permalink.match(/\/r\/([^/]+)/);

  return m ? m[1] : undefined;
}

// The `ip` column on posts.csv/comments.csv is the address the item was
// submitted from. Reddit retains IP logs only briefly (~100 days), so expect it
// populated on recent rows and blank on everything older.
//
// Recorded as metadata ONLY — deliberately not turned into a position. An IP
// resolves to a city/ISP centroid (MaxMind publishes an accuracy radius of
// 5-200 KM, and mobile CGNAT or a VPN puts it in the wrong region entirely),
// which is far too coarse to donate to the location estimator next to real GPS
// fixes. Geo databases also describe CURRENT allocations, so an old row would
// geolocate against a block that has since been reassigned.
function clientIP(row: Record<string, string>): string | undefined {
  return (row.ip || row.ip_address || '').trim() || undefined;
}

function snippet(s: string | undefined, n = 80): string | undefined {
  if (!s) {
    return undefined;
  }

  const one = s.replace(/\s+/g, ' ').trim();
  if (!one) {
    return undefined;
  }

  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

// Files we read. Recognition keys off the export's signature CSVs.
const POST_FILES = ['posts.csv', 'saved_posts.csv'];
const COMMENT_FILES = ['comments.csv', 'saved_comments.csv'];
const SUB_FILES = ['moderated_subreddits.csv'];
// Recognized but NOT imported. Subscriptions and votes carry no usable date:
// the export records no time for either action, so the rows could only ever be
// events pinned to import time — functionally useless on a timeline. (The
// *_headers.csv dates cover only the account's OWN posts/comments, so the only
// datable votes are Reddit's automatic self-upvotes — noise, not engagement.)
// Kept in the recognition signature so a drop containing these CSVs still
// identifies as reddit.
const RECOGNITION_ONLY_FILES = ['subscribed_subreddits.csv', 'post_votes.csv', 'comment_votes.csv'];
const PURCHASE_FILES = ['purchases.csv'];
// Private messages (old-style PMs) + Reddit Chat — real communications with
// participants, so they route to CI-Server communications and feed people-linking.
// announcements.csv rides along too: per Reddit's own export docs it's "the
// official communication about your account from Reddit in your inbox" — same
// subject/body/sender/timestamp shape as a PM, just sent by a Reddit admin
// account instead of another user (mirrors the admin-sourced system messages
// that already show up in messages_archive.csv, e.g. "Welcome to Moderating!").
const MESSAGE_FILES = ['messages_archive.csv', 'chat_history.csv', 'announcements.csv'];
const REDDIT_FILES = [
  ...POST_FILES,
  ...COMMENT_FILES,
  ...SUB_FILES,
  ...RECOGNITION_ONLY_FILES,
  ...PURCHASE_FILES,
  ...MESSAGE_FILES,
];

/**
 * Per-file REQUIRED CSV columns — the ones the parser below actually reads.
 *
 * The signature names are too generic to claim on their own: Google Takeout
 * exports a YouTube comment history as `comments.csv`, and one inside a
 * Takeout zip was staged as a Reddit comment on the strength of its filename.
 * A Reddit export's headers are distinctive (`permalink` above all — YouTube's
 * file has none), so requiring the parsed columns kills the false positive
 * while accepting every file the importer could parse anyway.
 */
const REQUIRED_HEADERS: Record<string, readonly string[]> = {
  'posts.csv': ['id', 'permalink', 'title'],
  'comments.csv': ['id', 'permalink', 'body'],
  'saved_posts.csv': ['id', 'permalink'],
  'saved_comments.csv': ['id', 'permalink'],
  'post_votes.csv': ['id', 'permalink'],
  'comment_votes.csv': ['id', 'permalink'],
  'subscribed_subreddits.csv': ['subreddit'],
  'moderated_subreddits.csv': ['subreddit'],
  'purchases.csv': ['processor', 'transaction_id'],
  'messages_archive.csv': ['thread_id', 'subject'],
  'chat_history.csv': ['message_id', 'username'],
  'announcements.csv': ['sent_at', 'subject'],
};

/** Name on the signature list AND header carrying the parsed columns. */
async function isRedditFile(fpath: string): Promise<boolean> {
  const required = REQUIRED_HEADERS[path.basename(fpath).toLowerCase()];

  return required != null && (await csvHeaderHas(fpath, required));
}

export class RedditFileImporter implements FileImporter {
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
      return (await isRedditFile(root)) ? { confidence: 0.9 } : { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        // Count only files whose HEADER passes, not whose name does — a
        // directory holding someone else's comments.csv + posts.csv would
        // otherwise clear the two-hit bar on names alone.
        const names = await readdir(root);
        let hits = 0;
        for (const name of names) {
          if (REDDIT_FILES.includes(name.toLowerCase()) && (await isRedditFile(path.join(root, name)))) {
            hits++;
          }
        }

        if (hits >= 2) {
          return { confidence: 0.95 };
        }

        if (hits === 1) {
          return { confidence: 0.8 };
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

    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      return;
    }

    if (stat.isFile()) {
      await this.processFile(root, params);
    } else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(root)) {
        if (REDDIT_FILES.includes(name.toLowerCase())) {
          await this.processFile(path.join(root, name), params);
        }
      }
    }
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath).toLowerCase();
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${base}`, {
        error: (e as Error).message,
      });

      return;
    }

    const rows = parseCSV(raw);
    for (const row of rows) {
      if (POST_FILES.includes(base)) {
        this.pushPost(row, base, params);
      } else if (COMMENT_FILES.includes(base)) {
        this.pushComment(row, base, params);
      } else if (SUB_FILES.includes(base)) {
        this.pushSubreddit(row, base, params);
      } else if (PURCHASE_FILES.includes(base)) {
        this.pushPurchase(row, params);
      } else if (MESSAGE_FILES.includes(base)) {
        this.pushMessage(row, base, params);
      }
    }
  }

  private pushPost(row: Record<string, string>, source: string, params: ImportParams): void {
    const ts = parseRedditDate(row.date);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const saved = source === 'saved_posts.csv';
    const subreddit = row.subreddit || subredditFromPermalink(row.permalink);
    // Title precedence: post title → permalink slug (the only signal saved posts
    // have) → subreddit-scoped fallback. Never the bare filename.
    const title =
      row.title?.trim() || slugTitle(row.permalink) || (subreddit ? `Post in r/${subreddit}` : 'Reddit post');
    // Content carries the self-post BODY (the searchable text); fall back to the
    // title for link posts / saved posts with no body.
    const text = row.body?.trim() || title;
    // Stable id keeps the dedup hash distinct: posts share the `post.txt`
    // filename, and saved posts have no timestamp, so without a natural key they
    // would collapse to a single row (see hashItem in persistence.ts).
    const kind = saved ? 'saved_post' : 'post';
    const key = row.id?.trim() || row.permalink?.trim();
    params.pipeline.push({
      item: {
        id: key ? `reddit:${kind}:${key}` : undefined,
        classification: 'social',
        timestamp: ts,
        content: {
          filename: 'post.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(text),
        },
        metadata: {
          Title: title,
          Body: snippet(row.body, 4000),
          URL: row.url || undefined, // external link target (link posts)
          Permalink: row.permalink || undefined,
          Subreddit: subreddit || undefined,
          IP: clientIP(row),
          Kind: kind,
          Source: 'Reddit',
        },
      },
    });
  }

  private pushComment(row: Record<string, string>, source: string, params: ImportParams): void {
    const ts = parseRedditDate(row.date);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const saved = source === 'saved_comments.csv';
    const subreddit = row.subreddit || subredditFromPermalink(row.permalink || row.link);
    // Comments have no title, and we deliberately don't invent one: any label
    // we could derive would be a snippet of the body, which the content/text
    // already carries verbatim (see mapping.ts — the communication subject and
    // the media content row's title are both left blank for comments).
    const fallback =
      slugTitle(row.permalink || row.link) || (subreddit ? `Comment in r/${subreddit}` : 'Reddit comment');
    const text = row.body?.trim() || fallback;
    // Reddit's GDPR comments.csv carries award/gilding counts, not a vote score;
    // prefer an explicit `score` column when present, else sum the gildings.
    const score =
      (row.score ? parseInt(row.score, 10) : undefined) ??
      ([row.gildings, row.gildings_silver, row.gildings_supergold]
        .map((v) => (v ? parseInt(v, 10) : 0))
        .reduce((a, b) => a + (isNaN(b) ? 0 : b), 0) ||
        undefined);
    const kind = saved ? 'saved_comment' : 'comment';
    const key = row.id?.trim() || row.permalink?.trim() || row.link?.trim();
    params.pipeline.push({
      item: {
        id: key ? `reddit:${kind}:${key}` : undefined,
        classification: 'social',
        timestamp: ts,
        content: {
          filename: 'comment.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(text),
        },
        metadata: {
          Body: snippet(row.body, 4000),
          URL: row.permalink || undefined,
          Link: row.link || undefined, // the post the comment is on
          Parent: row.parent || undefined,
          Subreddit: subreddit || undefined,
          Score: score,
          IP: clientIP(row),
          Kind: kind,
          Source: 'Reddit',
        },
      },
    });
  }

  // Subscribed / moderated subreddits — interest signals (current state, no date).
  private pushSubreddit(row: Record<string, string>, source: string, params: ImportParams): void {
    const sub = (row.subreddit || row.name || '').trim();
    if (!sub) {
      return;
    }

    const kind = source === 'moderated_subreddits.csv' ? 'moderated_subreddit' : 'subscribed_subreddit';
    // These have no timestamp and share the `subreddit.txt` filename, so a
    // natural key (the subreddit name) is required to keep them distinct.
    params.pipeline.push({
      item: {
        id: `reddit:${kind}:${sub.toLowerCase()}`,
        classification: 'social',
        timestamp: undefined,
        content: {
          filename: 'subreddit.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(`r/${sub}`),
        },
        metadata: {
          Title: `r/${sub}`,
          Subreddit: sub,
          Kind: kind,
          Source: 'Reddit',
        },
      },
    });
  }

  // Reddit purchases (coins, awards, Premium) — a dated commerce record.
  private pushPurchase(row: Record<string, string>, params: ImportParams): void {
    const ts = parseRedditDate(row.date);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const product = (row.product || 'Reddit purchase').trim();
    const key = row.transaction_id?.trim() || `${row.processor || ''}:${row.date || ''}:${product}`;
    params.pipeline.push({
      item: {
        id: `reddit:purchase:${key}`,
        classification: 'purchase',
        timestamp: ts,
        content: {
          filename: 'purchase.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(product),
        },
        metadata: {
          Product: product,
          // CANONICAL key (push/commerceKeys.ts). This used to be `Cost`, which
          // NO price chain read — the things lane reads 'Unit Price' then 'Total' —
          // so every Reddit purchase reached ci.* priceless.
          Total: row.cost || undefined,
          Currency: row.currency || undefined,
          Status: row.status || undefined,
          Merchant: 'Reddit',
          // The PAYMENT processor (Stripe/PayPal), deliberately kept out of the
          // MERCHANT chain: it is neither who issued the receipt nor the brand
          // of the thing bought.
          Processor: row.processor || undefined,
          // Reddit sells Coins, Awards and Premium: there is no physical good
          // in this file, ever. Stating it keeps the purchase out of physical
          // the things lane without relying on the product-name heuristic (which
          // matches "Premium" but not "1,000 Coins").
          IsDigital: true,
          Kind: 'purchase',
          Source: 'Reddit',
        },
      },
    });
  }

  // Private messages (messages_archive.csv), Reddit Chat (chat_history.csv),
  // and account announcements (announcements.csv — Reddit's own admin-to-user
  // notifications, e.g. "Welcome to Moderating!"). All three are real
  // communications, so they're emitted as `message` communications — From/To
  // ride in metadata for the server to resolve into people (the body must live
  // in metadata.Body, which is what the communication content is mapped from;
  // content.data is not read at push time).
  private pushMessage(row: Record<string, string>, source: string, params: ImportParams): void {
    const chat = source === 'chat_history.csv';
    const announcement = source === 'announcements.csv';
    // announcements.csv uses `sent_at` rather than the `date`/`created_at`
    // columns the PM/chat exports use.
    const ts = parseRedditDate(row.date || row.created_at || row.sent_at);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const from = (row.from || row.username || (announcement ? 'Reddit' : '')).trim();
    const to = (row.to || '').trim();
    const subject = (row.subject || '').trim();
    const body = (row.body || row.message || '').trim();
    if (!body && !subject) {
      return;
    } // nothing to record

    const subreddit = row.subreddit || subredditFromPermalink(row.permalink);
    const title = subject || snippet(body, 80) || (from ? `Message from ${from}` : 'Reddit message');
    // Thread/channel identity keeps a conversation's messages grouped server-side.
    const thread =
      row.thread_id || row.thread_parent_message_id || row.channel_url || row.channel_name || undefined;
    const key =
      row.id?.trim() ||
      row.message_id?.trim() ||
      row.permalink?.trim() ||
      `${thread || ''}:${row.date || row.created_at || row.sent_at || ''}:${snippet(body, 24) || ''}`;
    params.pipeline.push({
      item: {
        id: `reddit:message:${key}`,
        classification: 'message',
        timestamp: ts,
        content: {
          filename: 'message.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(body || title),
        },
        metadata: {
          Title: title,
          Subject: subject || undefined,
          Body: body || undefined, // full body — the communication content maps from here
          From: from || undefined,
          To: to || undefined,
          ThreadId: thread,
          Permalink: row.permalink || undefined,
          Subreddit: subreddit || undefined,
          ConversationType:
            row.conversation_type || (announcement ? 'announcement' : chat ? 'chat' : 'private_message'),
          Kind: 'message',
          Source: 'Reddit',
        },
      },
    });
  }
}

registerDataSource({
  name: 'reddit',
  title: 'Reddit',
  icon: '',
  description:
    'Posts, comments, saved items, votes, subscribed/moderated subreddits, and purchases from a Reddit GDPR request.',
  newFileImporter: () => new RedditFileImporter(),
});
