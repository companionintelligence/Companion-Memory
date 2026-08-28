/* Spotify — streaming history from a Spotify privacy export.
   Handles both compact StreamingHistory*.json and extended endsong_*.json formats.
*/
import fs from 'node:fs';
import { readdir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Graph, Metadata } from './timeline';
import { timeframeContains } from './timeline';

interface StreamingEntry {
  endTime?: string; // "YYYY-MM-DD HH:MM"
  artistName?: string;
  trackName?: string;
  msPlayed?: number;
}

interface EndsongEntry {
  ts?: string; // ISO 8601
  master_metadata_track_name?: string;
  master_metadata_album_artist_name?: string;
  master_metadata_album_album_name?: string;
  spotify_track_uri?: string;
  // Podcast episodes ride in the same Audio files with their own fields.
  episode_name?: string;
  episode_show_name?: string;
  spotify_episode_uri?: string;
  // As do audiobook chapters (newest exports; audiobook_uri is a spotify:show:).
  audiobook_title?: string;
  audiobook_chapter_title?: string;
  audiobook_uri?: string;
  audiobook_chapter_uri?: string;
  ms_played?: number;
  shuffle?: boolean;
  skipped?: boolean | null;
}

// Streaming-history filenames across Spotify's export variants:
//   compact account export:  StreamingHistory0.json, StreamingHistory_music_0.json
//   older "extended":         endsong_0.json
//   current "Extended Streaming History":  Streaming_History_Audio_2024_0.json,
//     plus Streaming_History_Video_2024.json (video podcasts + music videos,
//     same row schema as the audio files).
// The current extended export nests these under a "Spotify Extended Streaming
// History/" folder, so recognition + import walk subdirectories.
const STREAM_FILE =
  /^(streaminghist(?:ory)?[\w-]*|endsong_\d+|streaming_history_(?:audio|video)_[\w-]*)\.json$/i;

// spotify:<type>:<id> → https://open.spotify.com/<type>/<id>. Covers track,
// episode, and show URIs. Audiobooks have no dedicated path in the export's
// URIs: the book is a spotify:show: and each chapter a spotify:episode:, so
// they map to /show/ and /episode/ URLs like podcasts do.
function spotifyUrl(uri: string | undefined): string | undefined {
  if (!uri) {
    return undefined;
  }

  const m = /^spotify:([a-z]+):([A-Za-z0-9]+)$/.exec(uri);

  return m ? `https://open.spotify.com/${m[1]}/${m[2]}` : undefined;
}

async function* walkStreamFiles(root: string, depth = 0): AsyncGenerator<string> {
  if (depth > 4) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      yield* walkStreamFiles(p, depth + 1);
    } else if (e.isFile() && STREAM_FILE.test(e.name)) {
      yield p;
    }
  }
}

export class SpotifyFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return { confidence: 0 };
    }

    let stat: fs.Stats;
    try {
      stat = await fsStat(root);
    } catch {
      return { confidence: 0 };
    }

    if (stat.isFile()) {
      return STREAM_FILE.test(path.basename(root)) ? { confidence: 0.95 } : { confidence: 0 };
    }

    if (stat.isDirectory()) {
      // Any streaming-history file at any depth → strong match.
      for await (const _ of walkStreamFiles(root)) {
        return { confidence: 0.95 };
      }

      try {
        const names = (await readdir(root)).map((e) => e.toLowerCase());
        if (names.some((n) => n === 'yourlibrary.json' || /^playlist\d+\.json$/.test(n))) {
          return { confidence: 0.75 };
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
      for await (const f of walkStreamFiles(root)) {
        await this.processFile(f, params);
      }
    }
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Failed to read Spotify file', {
        file: path.basename(fpath),
        error: (e as Error).message,
      });

      return;
    }

    let arr: unknown[];
    try {
      arr = JSON.parse(raw);
    } catch {
      params.pipeline.drop?.('unreadable_file', path.basename(fpath));

      return;
    }

    if (!Array.isArray(arr)) {
      params.pipeline.drop?.('unreadable_file', path.basename(fpath));

      return;
    }

    // How many records this file actually offered the parser — the floor
    // `reconciled` checks every produced/dropped row against.
    params.pipeline.consumed?.(arr.length);

    const base = path.basename(fpath).toLowerCase();
    // endsong_* and the current Streaming_History_Audio_*/_Video_* share the
    // rich schema (ts + master_metadata_* / episode_* / audiobook_*); the
    // compact StreamingHistory* uses endTime/trackName. Video rows (video
    // podcasts, music videos) are watched rather than listened to.
    if (base.startsWith('streaming_history_video')) {
      arr.forEach((e, i) => this.pushEndPlay(e as EndsongEntry, params, i, base, 'watch'));
    } else if (base.startsWith('endsong') || base.startsWith('streaming_history_audio')) {
      arr.forEach((e, i) => this.pushEndPlay(e as EndsongEntry, params, i, base, 'listen'));
    } else {
      arr.forEach((e, i) => this.pushStreaming(e as StreamingEntry, params, i, base));
    }
  }

  private pushEndPlay(
    e: EndsongEntry,
    params: ImportParams,
    idx: number,
    file: string,
    classification: 'listen' | 'watch',
  ): void {
    // `ts` is when playback STOPPED. Walk back ms_played for the true start;
    // the stop time itself becomes the item's end.
    let end = e.ts ? new Date(e.ts) : undefined;
    if (end && isNaN(end.getTime())) {
      end = undefined;
    }

    const played = typeof e.ms_played === 'number' && e.ms_played >= 0 ? e.ms_played : undefined;
    // Sub-second plays are skip-throughs, not listening — drop the row.
    if (played !== undefined && played < 1000) {
      params.pipeline.drop?.('sub_second_play');

      return;
    }

    const ts = end && played !== undefined ? new Date(end.getTime() - played) : end;
    if (!timeframeContains(params.timeframe, ts)) {
      params.pipeline.drop?.('outside_timeframe');

      return;
    }

    // One Audio file carries three content shapes — music tracks, podcast
    // episodes, and audiobook chapters — each with its own name/URI fields.
    // Rows with none of the three are unresolvable playback stubs; skip them.
    // `key` feeds the item id: for tracks it must stay the bare track name so
    // ids of previously imported music don't churn.
    let key: string;
    let filename: string;
    let line: string;
    let metadata: Metadata;
    if (e.master_metadata_track_name) {
      const track = e.master_metadata_track_name;
      const artist = e.master_metadata_album_artist_name ?? '';
      key = track;
      filename = 'track.txt';
      line = `${artist} — ${track}`;
      metadata = {
        Track: track,
        Artist: artist || undefined,
        Album: e.master_metadata_album_album_name || undefined,
        URI: e.spotify_track_uri || undefined,
        URL: spotifyUrl(e.spotify_track_uri),
        'ms Played': e.ms_played,
        Shuffle: e.shuffle,
        Skipped: e.skipped ?? undefined,
      };
    } else if (e.episode_name || e.spotify_episode_uri) {
      const episode = e.episode_name ?? '';
      const show = e.episode_show_name ?? '';
      key = episode || e.spotify_episode_uri || '';
      filename = 'episode.txt';
      line = show && episode ? `${show} — ${episode}` : show || episode;
      metadata = {
        Type: 'podcast',
        Episode: episode || undefined,
        Show: show || undefined,
        URI: e.spotify_episode_uri || undefined,
        URL: spotifyUrl(e.spotify_episode_uri),
        'ms Played': e.ms_played,
        Skipped: e.skipped ?? undefined,
      };
    } else if (e.audiobook_title || e.audiobook_chapter_uri) {
      const book = e.audiobook_title ?? '';
      const chapter = e.audiobook_chapter_title ?? '';
      key = `${book}:${chapter || e.audiobook_chapter_uri || ''}`;
      filename = 'chapter.txt';
      line = chapter && chapter !== book ? `${book} — ${chapter}` : book;
      metadata = {
        Type: 'audiobook',
        Book: book || undefined,
        Chapter: chapter || undefined,
        URI: e.audiobook_chapter_uri || e.audiobook_uri || undefined,
        URL: spotifyUrl(e.audiobook_chapter_uri) ?? spotifyUrl(e.audiobook_uri),
        'ms Played': e.ms_played,
        Skipped: e.skipped ?? undefined,
      };
    } else {
      params.pipeline.drop?.('unresolvable_playback_stub');

      return;
    }

    const g: Graph = {
      item: {
        id: `spotify:${file}:${idx}:${e.ts ?? ''}:${key}:${e.ms_played ?? ''}`,
        classification,
        timestamp: ts,
        timespanEnd: played !== undefined ? end : undefined,
        // The content row carries the real format's mimetype rather than the
        // placeholder text's: Spotify serves audio as Ogg Vorbis (audio/ogg,
        // RFC 5334) and video as MP4/H.264 streams (video/mp4).
        content: {
          filename,
          mediaType: classification === 'watch' ? 'video/mp4' : 'audio/ogg',
          data: async () => Buffer.from(line),
        },
        metadata,
      },
    };
    params.pipeline.push(g);
  }

  private pushStreaming(e: StreamingEntry, params: ImportParams, idx: number, file: string): void {
    // endTime is when playback STOPPED (minute precision). Walk back msPlayed
    // for the true start; the stop time itself becomes the item's end.
    let end: Date | undefined;
    if (e.endTime) {
      end = new Date(e.endTime.replace(' ', 'T') + ':00Z');
      if (isNaN(end.getTime())) {
        end = undefined;
      }
    }

    const played = typeof e.msPlayed === 'number' && e.msPlayed >= 0 ? e.msPlayed : undefined;
    // Sub-second plays are skip-throughs, not listening — drop the row.
    if (played !== undefined && played < 1000) {
      params.pipeline.drop?.('sub_second_play');

      return;
    }

    const ts = end && played !== undefined ? new Date(end.getTime() - played) : end;
    if (!timeframeContains(params.timeframe, ts)) {
      params.pipeline.drop?.('outside_timeframe');

      return;
    }

    const track = e.trackName ?? '';
    const artist = e.artistName ?? '';
    const g: Graph = {
      item: {
        id: `spotify:${file}:${idx}:${e.endTime ?? ''}:${track}:${e.msPlayed ?? ''}`,
        classification: 'listen',
        timestamp: ts,
        timespanEnd: played !== undefined ? end : undefined,
        content: {
          filename: 'track.txt',
          mediaType: 'audio/ogg',
          data: async () => Buffer.from(`${artist} — ${track}`),
        },
        metadata: {
          Track: track || undefined,
          Artist: artist || undefined,
          'ms Played': e.msPlayed,
        },
      },
    };
    params.pipeline.push(g);
  }
}

registerDataSource({
  name: 'spotify',
  title: 'Spotify',
  icon: '',
  description: 'Streaming history, playlists, and library from a Spotify privacy export.',
  newFileImporter: () => new SpotifyFileImporter(),
});
