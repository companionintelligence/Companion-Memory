/* TikTok — "Download your data" JSON export (user_data_tiktok.json). */
import fs from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { asArray, asRecord, asString, dig, type JsonRecord } from './json';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

const TIKTOK_FILES = ['user_data_tiktok.json', 'user_data.json', 'tiktok.json'];

// "YYYY-MM-DD HH:MM:SS" (UTC, optional trailing " UTC") → Date
function parseTikTokDate(s: string | undefined): Date | undefined {
  if (!s) {
    return undefined;
  }

  const d = new Date(s.replace(/ UTC$/i, '').replace(' ', 'T') + 'Z');

  return isNaN(d.getTime()) ? undefined : d;
}

function looksLikeTikTok(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return false;
  }

  const o = obj as Record<string, unknown>;

  return 'Activity' in o || 'Direct Messages' in o;
}

async function parseFile(fpath: string): Promise<JsonRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(fpath, 'utf8');
  } catch {
    return undefined;
  }

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }

  return looksLikeTikTok(obj) ? (obj as JsonRecord) : undefined;
}

export class TikTokFileImporter implements FileImporter {
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
      if (!TIKTOK_FILES.includes(path.basename(root).toLowerCase())) {
        return { confidence: 0 };
      }

      return (await parseFile(root)) ? { confidence: 0.95 } : { confidence: 0 };
    }

    if (st.isDirectory()) {
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        return { confidence: 0, dir_threshold: 0.7 };
      }

      for (const name of names) {
        if (TIKTOK_FILES.includes(name.toLowerCase()) && (await parseFile(path.join(root, name)))) {
          return { confidence: 0.9 };
        }
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

    let filePath: string | undefined;
    try {
      const stat = fs.statSync(root);
      if (stat.isFile()) {
        filePath = root;
      } else if (stat.isDirectory()) {
        for (const name of fs.readdirSync(root)) {
          if (TIKTOK_FILES.includes(name.toLowerCase())) {
            filePath = path.join(root, name);
            break;
          }
        }
      }
    } catch {
      return;
    }

    if (!filePath) {
      params.log?.('warn', 'TikTok: data file not found');

      return;
    }

    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Failed to read TikTok export', { error: (e as Error).message });

      return;
    }

    let obj: JsonRecord;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;
    }

    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return;
    }

    this.importWatch(obj, params);
    this.importLikes(obj, params);
    this.importFavorites(obj, params);
    this.importSearch(obj, params);
    this.importComments(obj, params);
    this.importDirectMessages(obj, params);
  }

  private importWatch(obj: JsonRecord, params: ImportParams): void {
    const list = asArray(dig(obj, 'Activity', 'Video Browsing History', 'VideoList'));
    if (!list) {
      return;
    }

    list.forEach((rawEntry, index) => {
      const e = asRecord(rawEntry);
      if (!e) {
        params.pipeline.drop?.('malformed_entry');

        return;
      }

      const ts = parseTikTokDate(asString(e.Date));
      if (!timeframeContains(params.timeframe, ts)) {
        params.pipeline.drop?.('outside_timeframe');

        return;
      }

      const link = asString(e.Link) || asString(e.VideoLink) || '';
      const id = link.match(/video\/(\d+)/)?.[1];
      // TikTok's own Date is second-precision and repeats within a rapid
      // watch/like session, so classification+filename+timestamp alone
      // (hashItem's fallback) collapses distinct videos watched in the same
      // second into one row. The video id (or link) plus the list index makes
      // every row distinct and stable across re-imports of the same export.
      const iso = ts ? ts.toISOString() : 'no-ts';
      params.pipeline.push({
        item: {
          id: `tiktok:watch:${id || link || 'unknown'}:${iso}:${index}`,
          classification: 'watch',
          timestamp: ts,
          content: { filename: 'watch.txt', mediaType: 'text/plain', data: async () => Buffer.from(link) },
          metadata: {
            Title: id ? `TikTok video ${id}` : 'TikTok video',
            URL: link || undefined,
            Kind: 'browse',
            Source: 'TikTok',
          },
        },
      });
    });
  }

  private importLikes(obj: JsonRecord, params: ImportParams): void {
    const list = asArray(dig(obj, 'Activity', 'Like List', 'ItemFavoriteList'));
    if (!list) {
      return;
    }

    list.forEach((rawEntry, index) => {
      const e = asRecord(rawEntry);
      if (!e) {
        params.pipeline.drop?.('malformed_entry');

        return;
      }

      const ts = parseTikTokDate(asString(e.Date));
      if (!timeframeContains(params.timeframe, ts)) {
        params.pipeline.drop?.('outside_timeframe');

        return;
      }

      const link = asString(e.Link) || asString(e.VideoLink) || '';
      const id = link.match(/video\/(\d+)/)?.[1];
      // See importWatch: rapid-fire likes in one session share the same
      // second-precision Date, so the video id/link + index disambiguates.
      const iso = ts ? ts.toISOString() : 'no-ts';
      params.pipeline.push({
        item: {
          id: `tiktok:like:${id || link || 'unknown'}:${iso}:${index}`,
          classification: 'social',
          timestamp: ts,
          content: { filename: 'like.txt', mediaType: 'text/plain', data: async () => Buffer.from(link) },
          metadata: {
            Title: id ? `TikTok video ${id}` : 'TikTok video',
            URL: link || undefined,
            Kind: 'like',
            Source: 'TikTok',
          },
        },
      });
    });
  }

  private importFavorites(obj: JsonRecord, params: ImportParams): void {
    const list = asArray(dig(obj, 'Activity', 'Favorite Videos', 'FavoriteVideoList'));
    if (!list) {
      return;
    }

    list.forEach((rawEntry, index) => {
      const e = asRecord(rawEntry);
      if (!e) {
        params.pipeline.drop?.('malformed_entry');

        return;
      }

      const ts = parseTikTokDate(asString(e.Date));
      if (!timeframeContains(params.timeframe, ts)) {
        params.pipeline.drop?.('outside_timeframe');

        return;
      }

      const link = asString(e.Link) || '';
      const id = link.match(/video\/(\d+)/)?.[1];
      // See importWatch: several videos favorited in the same second must
      // not collapse into one row.
      const iso = ts ? ts.toISOString() : 'no-ts';
      params.pipeline.push({
        item: {
          id: `tiktok:favorite:${id || link || 'unknown'}:${iso}:${index}`,
          classification: 'social',
          timestamp: ts,
          content: { filename: 'favorite.txt', mediaType: 'text/plain', data: async () => Buffer.from(link) },
          metadata: {
            Title: id ? `TikTok video ${id}` : 'TikTok video',
            URL: link || undefined,
            Kind: 'favorite',
            Source: 'TikTok',
          },
        },
      });
    });
  }

  private importSearch(obj: JsonRecord, params: ImportParams): void {
    const list = asArray(dig(obj, 'Activity', 'Search History', 'SearchList'));
    if (!list) {
      return;
    }

    list.forEach((rawEntry, index) => {
      const e = asRecord(rawEntry);
      if (!e) {
        params.pipeline.drop?.('malformed_entry');

        return;
      }

      const ts = parseTikTokDate(asString(e.Date));
      if (!timeframeContains(params.timeframe, ts)) {
        params.pipeline.drop?.('outside_timeframe');

        return;
      }

      const term = asString(e.SearchTerm) || '';
      // See importWatch: repeated searches within the same second (or the
      // same term searched twice) must not collapse into one row.
      const iso = ts ? ts.toISOString() : 'no-ts';
      params.pipeline.push({
        item: {
          id: `tiktok:search:${term || 'unknown'}:${iso}:${index}`,
          classification: 'social',
          timestamp: ts,
          content: { filename: 'search.txt', mediaType: 'text/plain', data: async () => Buffer.from(term) },
          metadata: { Text: term || undefined, Query: term || undefined, Kind: 'search', Source: 'TikTok' },
        },
      });
    });
  }

  private importComments(obj: JsonRecord, params: ImportParams): void {
    const list = asArray(dig(obj, 'Comment', 'Comments', 'CommentsList'));
    if (!list) {
      return;
    }

    list.forEach((rawEntry, index) => {
      const e = asRecord(rawEntry);
      if (!e) {
        params.pipeline.drop?.('malformed_entry');

        return;
      }

      const ts = parseTikTokDate(asString(e.Date));
      if (!timeframeContains(params.timeframe, ts)) {
        params.pipeline.drop?.('outside_timeframe');

        return;
      }

      const comment = asString(e.Comment) || '';
      // See importWatch: two comments posted within the same second must not
      // collapse into one row (comment.txt is a constant filename).
      const iso = ts ? ts.toISOString() : 'no-ts';
      params.pipeline.push({
        item: {
          id: `tiktok:comment:${iso}:${index}`,
          classification: 'social',
          timestamp: ts,
          content: {
            filename: 'comment.txt',
            mediaType: 'text/plain',
            data: async () => Buffer.from(comment),
          },
          metadata: {
            Text: comment || undefined,
            Comment: comment || undefined,
            Kind: 'comment',
            Source: 'TikTok',
          },
        },
      });
    });
  }

  private importDirectMessages(obj: JsonRecord, params: ImportParams): void {
    const chats = asRecord(dig(obj, 'Direct Messages', 'Chat History', 'ChatHistory'));
    if (!chats) {
      return;
    }

    for (const [key, arr] of Object.entries(chats)) {
      if (!Array.isArray(arr)) {
        continue;
      }

      const conversation = key.replace(/^Chat History with /, '').replace(/:$/, '');
      arr.forEach((rawMsg, index) => {
        const msg = asRecord(rawMsg);
        if (!msg) {
          params.pipeline.drop?.('malformed_entry');

          return;
        }

        const ts = parseTikTokDate(asString(msg.Date));
        if (!timeframeContains(params.timeframe, ts)) {
          params.pipeline.drop?.('outside_timeframe');

          return;
        }

        const content = asString(msg.Content) || '';
        const sender = asString(msg.From) || undefined;
        // 1:1 export: the conversation key IS the partner; a message whose From
        // equals it is inbound (partner -> me), otherwise outbound (me -> partner).
        const isInbound = sender !== undefined && sender === conversation;
        const to = isInbound ? undefined : conversation || undefined;
        // See importWatch: rapid back-and-forth messages within the same
        // second (constant 'dm.txt' filename) must not collapse; index is
        // scoped per-conversation, matched by the conversation in the key.
        const iso = ts ? ts.toISOString() : 'no-ts';
        params.pipeline.push({
          item: {
            id: `tiktok:dm:${conversation}:${iso}:${index}`,
            classification: 'message',
            timestamp: ts,
            content: { filename: 'dm.txt', mediaType: 'text/plain', data: async () => Buffer.from(content) },
            metadata: {
              Sender: sender,
              To: to,
              Direction: sender ? (isInbound ? 'received' : 'sent') : undefined,
              ThreadId: conversation || undefined,
              Conversation: conversation || undefined,
              Kind: 'dm',
              Source: 'TikTok',
              Text: content || undefined,
            },
          },
        });
      });
    }
  }
}

registerDataSource({
  name: 'tiktok',
  title: 'TikTok',
  icon: '',
  description: 'Watch history, likes, favorites, searches, comments, and DMs from a TikTok data export.',
  newFileImporter: () => new TikTokFileImporter(),
});
