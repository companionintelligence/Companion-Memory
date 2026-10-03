/* YouTube — watch + search history from Google Takeout.
 * Supports both the legacy JSON export (watch-history.json) and the modern
 * Google MyActivity HTML export (watch-history.html / search-history.html). */
import fs from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { youtubeSubscriptionIdentity } from '@ci/domains/memory';

import { parseActivityCell, sha1, watchTitle, youtubeActivityGraph } from './_youtube_activity';
import { parseCSV } from './csv';
import { matchingDivCloseIndex } from './htmlBlocks';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Graph } from './timeline';
import { timeframeContains } from './timeline';

interface WatchEntry {
  header?: string;
  title?: string;
  titleUrl?: string;
  subtitles?: Array<{ name?: string; url?: string }>;
  time?: string;
}

const HISTORY_FILES = new Set([
  'watch-history.json',
  'search-history.json',
  'watch-history.html',
  'search-history.html',
]);

const SUBSCRIPTIONS_FILENAME = 'subscriptions.csv';

// Takeout's subscriptions.csv is a generic filename other exports could reuse
// (e.g. a streaming-service billing export), so confirm the header shape too.
function subscriptionsHeaderMatches(text: string): boolean {
  const nl = text.indexOf('\n');
  const header = nl === -1 ? text : text.slice(0, nl);

  return header.includes('Channel Id') && header.includes('Channel Url') && header.includes('Channel Title');
}

// Google MyActivity exports separate each entry with this cell container,
// matched by its OPENING tag only — the close comes from
// matchingDivCloseIndex (./htmlBlocks), not a non-greedy `[\s\S]*?<\/div>`:
// some product types nest a thumbnail/icon div inside the cell, and a
// non-greedy match stops at THAT close and truncates the entry (see
// google_my_activity.ts, which shares this exact cell shape and history).
const ENTRY_OPEN_RE = /<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">/g;

export class YouTubeFileImporter implements FileImporter {
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
      if (HISTORY_FILES.has(base)) {
        return { confidence: 0.9 };
      }

      if (base === SUBSCRIPTIONS_FILENAME) {
        try {
          if (subscriptionsHeaderMatches(await readFile(root, 'utf8'))) {
            return { confidence: 0.85 };
          }
        } catch {
          /* ignore */
        }
      }

      return { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        const names = (await readdir(root)).map((n) => n.toLowerCase());
        if (names.includes('watch-history.json') || names.includes('watch-history.html')) {
          return { confidence: 0.9 };
        }

        // "YouTube and YouTube Music" Takeout folder
        const dirName = path.basename(root).toLowerCase();
        if (dirName.includes('youtube') && names.some((n) => n === 'history')) {
          return { confidence: 0.85 };
        }

        if (names.some((n) => n === 'history')) {
          const histPath = path.join(
            root,
            names.find((n) => n === 'history')!,
          );
          const histNames = (await readdir(histPath)).map((f) => f.toLowerCase());
          if (histNames.includes('watch-history.json') || histNames.includes('watch-history.html')) {
            return { confidence: 0.9 };
          }
        }

        if (await this.findSubscriptionsCsv(root)) {
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

    let files: string[] = [];
    let subsFile: string | undefined;
    try {
      const stat = fs.statSync(root);
      if (stat.isFile()) {
        if (path.basename(root).toLowerCase() === SUBSCRIPTIONS_FILENAME) {
          subsFile = root;
        } else {
          files = [root];
        }
      } else if (stat.isDirectory()) {
        files = this.findHistoryFiles(root);
        subsFile = await this.findSubscriptionsCsv(root);
      }
    } catch {
      return;
    }

    if (!files.length && !subsFile) {
      params.log?.('warn', 'YouTube: no watch/search history or subscriptions.csv found');

      return;
    }

    for (const f of files) {
      const base = path.basename(f).toLowerCase();
      let raw: string;
      try {
        raw = await fs.promises.readFile(f, 'utf8');
      } catch (e) {
        params.log?.('error', 'Failed to read YouTube history', { file: f, error: (e as Error).message });
        continue;
      }

      if (base.endsWith('.html')) {
        this.importHtml(raw, base, params);
      } else {
        this.importJson(raw, base, params);
      }
    }

    if (subsFile) {
      await this.importSubscriptions(subsFile, params);
    }
  }

  private importJson(raw: string, base: string, params: ImportParams): void {
    let arr: WatchEntry[];
    try {
      arr = JSON.parse(raw);
    } catch {
      return;
    }

    if (!Array.isArray(arr)) {
      return;
    }

    // search-history.json shares this exact {header,time,title,titleUrl}
    // shape with watch-history.json -- with no filename passed in, every
    // entry was unconditionally classified 'watch' regardless of which file
    // it actually came from. importHtml already branches on base for the
    // equivalent HTML export; this mirrors it for JSON.
    const isSearch = base.startsWith('search');
    let index = 0;
    for (const e of arr) {
      if (e.header !== 'YouTube' && e.header !== 'YouTube Music') {
        continue;
      }

      const i = index++;
      const ts = e.time ? new Date(e.time) : undefined;
      if (!timeframeContains(params.timeframe, ts)) {
        continue;
      }

      const title = (e.title ?? '').replace(/^(Watched|Searched for) /, '');
      const url = e.titleUrl ?? '';
      const channel = e.subtitles?.[0]?.name ?? '';
      const id = 'youtube:' + (url || ts ? sha1(`${url} ${ts?.toISOString() ?? ''}`) : String(i));
      params.pipeline.push({
        item: {
          id,
          classification: isSearch ? 'search' : 'watch',
          timestamp: ts,
          content: {
            filename: isSearch ? 'search.txt' : 'watch.txt',
            // A watched video is delivered over MPEG-DASH; a search is text.
            mediaType: isSearch ? 'text/plain' : 'application/dash+xml',
            data: async () => Buffer.from(url || title),
          },
          metadata: isSearch
            ? {
                Title: title || undefined,
                Text: title || undefined,
                Query: title || undefined,
                URL: url || undefined,
                Kind: 'search',
                Source: 'YouTube',
              }
            : {
                Title: watchTitle(title, channel, url),
                URL: url || undefined,
                Channel: channel || undefined,
                Source: 'YouTube',
              },
        },
      } as Graph);
    }
  }

  private importHtml(raw: string, base: string, params: ImportParams): void {
    const isSearch = base.startsWith('search');
    let index = 0;
    let m: RegExpExecArray | null;
    ENTRY_OPEN_RE.lastIndex = 0;
    while ((m = ENTRY_OPEN_RE.exec(raw)) !== null) {
      const start = m.index + m[0].length;
      const end = matchingDivCloseIndex(raw, start);
      // Resume scanning AFTER the cell, not from the regex's own default
      // (right after the opening tag): a cell that nests another div must not
      // be re-entered and its content double-counted.
      ENTRY_OPEN_RE.lastIndex = end;
      const cell = parseActivityCell(raw.slice(start, end));
      if (!cell.anchors.length || !timeframeContains(params.timeframe, cell.ts)) {
        continue;
      }

      const g = youtubeActivityGraph(cell, { index: index++, isSearch });
      if (g) {
        params.pipeline.push(g);
      }
    }
  }

  private async importSubscriptions(subsPath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(subsPath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Failed to read YouTube subscriptions', { error: (e as Error).message });

      return;
    }

    let rows: Record<string, string>[];
    try {
      rows = parseCSV(raw);
    } catch (e) {
      params.log?.('error', 'Failed to parse YouTube subscriptions', { error: (e as Error).message });

      return;
    }

    // Subscriptions have no per-row timestamp in the Takeout export, so
    // `timeframeContains` always accepts them (undefined ts short-circuits).
    for (const row of rows) {
      const channelTitle = row['Channel Title'] || '';
      const channelUrl = row['Channel Url'] || '';
      const channelId = row['Channel Id'] || '';
      if (!channelTitle && !channelUrl && !channelId) {
        continue;
      }

      // Key on the channel id — the same identity the connection mints for
      // this subscription (docs/design/cross-pipeline-identity.md); rows
      // without one keep the per-pipeline hash lane.
      const id = channelId
        ? youtubeSubscriptionIdentity(channelId).id
        : 'youtube:sub:' + sha1(channelUrl || channelTitle);
      params.pipeline.push({
        item: {
          id,
          classification: 'subscription',
          timestamp: undefined,
          content: {
            filename: 'subscription.txt',
            mediaType: 'text/plain',
            data: async () => Buffer.from(channelUrl || channelTitle),
          },
          metadata: {
            Channel: channelTitle || undefined,
            ChannelId: channelId || undefined,
            URL: channelUrl || undefined,
            Source: 'YouTube',
          },
        },
      } as Graph);
    }
  }

  private async findSubscriptionsCsv(dir: string): Promise<string | undefined> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return undefined;
    }

    for (const name of entries) {
      const full = path.join(dir, name);
      if (name.toLowerCase() === SUBSCRIPTIONS_FILENAME) {
        try {
          if (subscriptionsHeaderMatches(await readFile(full, 'utf8'))) {
            return full;
          }
        } catch {
          /* ignore */
        }

        continue;
      }

      try {
        if ((await stat(full)).isDirectory()) {
          const sub = await this.findSubscriptionsCsv(full);
          if (sub) {
            return sub;
          }
        }
      } catch {
        /* ignore */
      }
    }

    return undefined;
  }

  private findHistoryFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      let entries: string[];
      try {
        entries = fs.readdirSync(d);
      } catch {
        return;
      }

      for (const name of entries) {
        const full = path.join(d, name);
        let st: fs.Stats;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }

        if (st.isDirectory()) {
          walk(full);
          continue;
        }

        if (HISTORY_FILES.has(name.toLowerCase())) {
          out.push(full);
        }
      }
    };

    walk(dir);
    // Prefer JSON over HTML when both exist for the same data, so a hybrid
    // export isn't double-counted; otherwise import everything found. Applies
    // to both the watch-history and search-history pairs.
    let filtered = out;
    for (const stem of ['watch-history', 'search-history']) {
      const hasJson = filtered.some((f) => path.basename(f).toLowerCase() === `${stem}.json`);
      const hasHtml = filtered.some((f) => path.basename(f).toLowerCase() === `${stem}.html`);
      if (hasJson && hasHtml) {
        filtered = filtered.filter((f) => path.basename(f).toLowerCase() !== `${stem}.html`);
      }
    }

    return filtered;
  }
}

registerDataSource({
  name: 'youtube',
  title: 'YouTube (Google Takeout)',
  icon: '',
  description: 'Watch history, search history, likes, subscriptions, playlists from a YouTube Takeout.',
  newFileImporter: () => new YouTubeFileImporter(),
});
