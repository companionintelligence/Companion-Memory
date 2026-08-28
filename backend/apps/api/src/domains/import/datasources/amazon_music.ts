/* Amazon Music — library snapshot from an Amazon "All Data Categories" export
   (Your Music Library/Followed Artists and Accounts.csv, Playlists.csv,
   Saved Music.csv). Everything here is a LIBRARY ARTIFACT, not an occurrence:
   the only datetimes the files carry are bookkeeping (when a rating was set,
   when a row last changed), which is not "an event you performed" — so every
   record imports as classification 'saved_media' (kind media.saved → a content
   row alone in CI-Server, no timeline event).

   The three files describe overlapping slices of one library, so rows are
   MERGED before anything is emitted, keyed on the track/album ASIN (fallback:
   a title+artist hash for the ASIN-less Playlists rows):

   - Saved Music.csv is the rich source — per-track album/artist/genre/ASIN
     columns, plus the stored file's extension (mp3/m4a), which becomes the
     track's content mimetype — and seeds the merge. Tracks with no saved row
     to inherit an extension from default to Amazon's usual audio/mpeg;
     albums stay text/plain (there is no album file).
   - Followed Artists and Accounts.csv carries bare ASIN + Product Name rows
     (Entity Type TRACK/ALBUM/ARTIST, all Rating POSITIVE). Its TRACK/ALBUM
     rows contribute a Followed flag and inherit whatever Saved Music knows
     about the same ASIN; its ARTIST rows become Person entities. A Product
     Name of "Not Available" (~40% of rows) names nothing to keep — skipped.
   - Playlists.csv rows contribute playlist membership; a row is matched onto
     a Saved Music track by normalized title+artist when possible so the
     membership lands on the ASIN-keyed record.

   Artists become Person entities and each item carries a 'by' edge to its
   artist; an album's Primary Genre becomes a 'music_genre'-typed entity (the
   graph-sync maps any unregistered type to a CI-Server Concept node, carrying
   the importer type in its properties) linked from the item via a 'genre'
   edge. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { amazonMusicAlbumUrl, amazonMusicTrackUrl } from './_amazon_urls';
import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { Entity, ImportParams, Metadata, Relationship } from './timeline';
import { mimeForFile } from './timeline';

type MusicFileKind = 'followed' | 'playlists' | 'saved';

const FILENAME_RES: Record<MusicFileKind, RegExp> = {
  followed: /^Followed Artists and Accounts\.csv$/i,
  playlists: /^Playlists\.csv$/i,
  saved: /^Saved Music\.csv$/i,
};

/**
 * Header sniffs, each on a column pair no other export CSV carries together.
 * "Entity Type" keeps the followed sniff off Retail.OrderHistory (which also
 * has ASIN + Product Name); "Track Name" keeps the playlists sniff off the
 * sibling Playlist Metadata.csv (playlist-level rows, no tracks).
 */
function headerKind(text: string): MusicFileKind | null {
  let header = text;
  if (header.charCodeAt(0) === 0xfeff) {
    header = header.slice(1);
  }

  const nl = header.indexOf('\n');
  if (nl !== -1) {
    header = header.slice(0, nl);
  }

  if (/album\s*asin/i.test(header) && /artist\s*asin/i.test(header)) {
    return 'saved';
  }

  if (/entity\s*type/i.test(header) && /product\s*name/i.test(header)) {
    return 'followed';
  }

  if (/playlist\s*title/i.test(header) && /track\s*name/i.test(header)) {
    return 'playlists';
  }

  return null;
}

async function sniffKind(fpath: string): Promise<MusicFileKind | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(fpath, 'r');
    const buf = Buffer.alloc(4096);
    const { bytesRead: n } = await handle.read(buf, 0, 4096, 0);

    return headerKind(buf.toString('utf8', 0, n));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** A field's value, with Amazon's "Not Available" filler read as no value. */
function val(row: Record<string, string>, name: string): string {
  const raw = (row[name] ?? '').trim();

  return /^not available$/i.test(raw) ? '' : raw;
}

function num(raw: string): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) {
    return undefined;
  }

  return Number(raw);
}

/** Identity fallback for an ASIN-less track: hash of normalized title+artist. */
function trackHash(title: string, artist: string): string {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

  return (
    't:' +
    crypto
      .createHash('sha1')
      .update(`${norm(title)}|${norm(artist)}`)
      .digest('hex')
      .slice(0, 16)
  );
}

/** One merged library track, accumulated across the three files. */
interface TrackAgg {
  ident: string; // ASIN, or the trackHash fallback
  /**
   * Whether the track itself gets emitted. False for Saved Music rows read
   * ONLY as enrichment for a bare-file drop of one of the other CSVs — those
   * rows lend their columns to the dropped file's records but must not smuggle
   * the whole saved library into the import.
   */
  include: boolean;
  asin?: string;
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  albumAsin?: string;
  artistAsin?: string;
  genre?: string; // Album Primary Genre, falling back to the track's Primary Genre
  albumGenre?: string; // Album Primary Genre alone — the genre-entity source
  ext?: string; // Saved Music's File Extension (mp3/m4a) — the mimetype source
  duration?: number;
  trackNumber?: number;
  discNumber?: number;
  purchased?: boolean;
  followed?: boolean;
  playlists: string[];
}

/** One followed album, enriched from Saved Music by its Album ASIN. */
interface AlbumAgg {
  asin: string;
  title: string;
  artist?: string;
  genre?: string;
}

export class AmazonMusicFileImporter implements FileImporter {
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
      const base = path.basename(root);
      if (path.extname(base).toLowerCase() !== '.csv') {
        return { confidence: 0 };
      }

      const kind = await sniffKind(root);
      if (!kind) {
        return { confidence: 0 };
      }

      return { confidence: FILENAME_RES[kind].test(base) ? 0.95 : 0.85 };
    }

    if (st.isDirectory()) {
      if ((await this.findFiles(root)).size) {
        return { confidence: 0.95 };
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  // The export nests the files as "Your Music Library"/…, and a drag-and-drop
  // staging adds an "All Data Categories" wrapper above that — recurse deep
  // enough to survive a couple of wrapper directories. First file of each kind
  // wins; a real export carries exactly one of each.
  private async findFiles(
    dir: string,
    depth = 0,
    out = new Map<MusicFileKind, string>(),
  ): Promise<Map<MusicFileKind, string>> {
    let names: fs.Dirent[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }

    for (const dirent of names) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (depth < 4) {
          await this.findFiles(full, depth + 1, out);
        }
      } else if (dirent.isFile() && path.extname(dirent.name).toLowerCase() === '.csv') {
        const kind = await sniffKind(full);
        if (kind && !out.has(kind)) {
          out.set(kind, full);
        }
      }
    }

    return out;
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

    // A directory drop imports every music-library file it holds. A bare-file
    // drop imports that one file — but still reads its siblings into the merge,
    // so a dropped Followed CSV is enriched by the Saved Music beside it.
    let files: Map<MusicFileKind, string>;
    let emitKinds: MusicFileKind[];
    if (stat.isFile()) {
      const kind = await sniffKind(root);
      if (!kind) {
        return;
      }

      files = await this.findFiles(path.dirname(root));
      files.set(kind, root);
      emitKinds = [kind];
    } else if (stat.isDirectory()) {
      files = await this.findFiles(root);
      emitKinds = [...files.keys()];
    } else {
      return;
    }

    if (!emitKinds.length) {
      return;
    }

    const parse = (kind: MusicFileKind): Record<string, string>[] => {
      const fpath = files.get(kind);
      if (!fpath) {
        return [];
      }

      try {
        return parseCSV(fs.readFileSync(fpath, 'utf8'));
      } catch (e) {
        params.log?.('error', `Failed to read ${path.basename(fpath)}`, { error: (e as Error).message });

        return [];
      }
    };

    const emit = new Set(emitKinds);
    const tracks = new Map<string, TrackAgg>();
    const albums = new Map<string, AlbumAgg>();
    const artists = new Map<string, string>(); // name → artist ASIN ('' when unknown)
    // Saved Music album columns, keyed by Album ASIN — what enriches a
    // followed ALBUM row beyond its bare Product Name.
    const savedAlbums = new Map<string, { artist?: string; genre?: string }>();
    const byTitleArtist = new Map<string, TrackAgg>();

    // ── Saved Music: the rich per-track rows seed the merge ──
    for (const row of parse('saved')) {
      const title = val(row, 'Title');
      if (!title) {
        if (emit.has('saved')) {
          params.pipeline.drop?.('unnamed_track', val(row, 'ASIN') || undefined);
        }

        continue;
      }

      const asin = val(row, 'ASIN');
      const artist = val(row, 'Artist Name');
      const albumGenre = val(row, 'Album Primary Genre');
      const ident = asin || trackHash(title, artist);
      const agg: TrackAgg = tracks.get(ident) ?? { ident, include: emit.has('saved'), playlists: [] };
      agg.asin = asin || agg.asin;
      agg.title = title;
      agg.artist = artist || agg.artist;
      agg.album = val(row, 'Album Name') || agg.album;
      agg.albumArtist = val(row, 'Album Artist Name') || agg.albumArtist;
      agg.albumAsin = val(row, 'Album ASIN') || agg.albumAsin;
      agg.artistAsin = val(row, 'Artist ASIN') || agg.artistAsin;
      agg.albumGenre = albumGenre || agg.albumGenre;
      agg.genre = albumGenre || val(row, 'Primary Genre') || agg.genre;
      agg.ext = val(row, 'File Extension') || agg.ext;
      agg.duration = num(val(row, 'Duration')) ?? agg.duration;
      agg.trackNumber = num(val(row, 'Track Number')) ?? agg.trackNumber;
      agg.discNumber = num(val(row, 'Disc Number')) ?? agg.discNumber;
      if (/^yes$/i.test(val(row, 'Purchased'))) {
        agg.purchased = true;
      }

      tracks.set(ident, agg);
      if (artist) {
        byTitleArtist.set(trackHash(title, artist), agg);
      }

      if (agg.albumAsin && !savedAlbums.has(agg.albumAsin)) {
        savedAlbums.set(agg.albumAsin, { artist: agg.albumArtist, genre: agg.albumGenre });
      }
    }

    // ── Followed Artists and Accounts: TRACK/ALBUM flags + ARTIST entities.
    // Unlike Saved Music this file is never an enrichment source, so it is
    // only read when it is itself being imported. ──
    for (const row of emit.has('followed') ? parse('followed') : []) {
      const entityType = (val(row, 'Entity Type') || '').toUpperCase();
      const name = val(row, 'Product Name');
      const asin = val(row, 'ASIN');
      if (!name) {
        // "Not Available" names nothing — no real track/album/artist is
        // assumed to carry that literal title.
        params.pipeline.drop?.('unnamed_product', asin || entityType || undefined);
        continue;
      }

      if (entityType === 'ARTIST') {
        if (!artists.has(name)) {
          artists.set(name, asin);
        }
      } else if (entityType === 'ALBUM') {
        if (asin && !albums.has(asin)) {
          const saved = savedAlbums.get(asin);
          albums.set(asin, { asin, title: name, artist: saved?.artist, genre: saved?.genre });
        }
      } else if (entityType === 'TRACK') {
        const ident = asin || trackHash(name, '');
        const agg: TrackAgg = tracks.get(ident) ?? { ident, include: true, playlists: [] };
        agg.asin = agg.asin || asin;
        agg.title = agg.title || name;
        agg.followed = true;
        agg.include = true;
        tracks.set(ident, agg);
      } else {
        params.pipeline.drop?.('unsupported_entity_type', entityType || undefined);
      }
    }

    // ── Playlists: membership rows, matched onto saved tracks where possible ──
    for (const row of emit.has('playlists') ? parse('playlists') : []) {
      const title = val(row, 'Track Name');
      const playlist = val(row, 'Playlist Title');
      if (!title) {
        params.pipeline.drop?.('unnamed_track', playlist || undefined);
        continue;
      }

      const artist = val(row, 'Track Artist Name');
      const key = trackHash(title, artist);
      const agg: TrackAgg = byTitleArtist.get(key) ??
        tracks.get(key) ?? { ident: key, include: true, playlists: [] };
      agg.title = agg.title || title;
      agg.artist = agg.artist || artist || undefined;
      agg.album = agg.album || val(row, 'Track Album Name') || undefined;
      if (playlist && !agg.playlists.includes(playlist)) {
        agg.playlists.push(playlist);
      }

      agg.include = true;
      tracks.set(agg.ident, agg);
    }

    // ── Emit: artists first so their ASIN-bearing entity row wins the
    // (type, name) dedup over the bare 'by'-edge copies items carry ──
    for (const [name, asin] of artists) {
      params.pipeline.push({
        entity: {
          type: 'person',
          name,
          metadata: { Source: 'Amazon Music', ASIN: asin || undefined },
        },
      });
    }

    for (const agg of tracks.values()) {
      if (agg.include) {
        this.pushTrack(agg, params);
      }
    }

    for (const album of albums.values()) {
      this.pushAlbum(album, params);
    }
  }

  /** 'by' + 'genre' edges shared by track and album items. */
  private edgesFor(artist: string | undefined, genre: string | undefined): Relationship[] {
    const edges: Relationship[] = [];
    if (artist) {
      edges.push({
        relation: 'by',
        to: { entity: { type: 'person', name: artist, metadata: { Source: 'Amazon Music' } } as Entity },
      });
    }

    if (genre) {
      // The graph-sync maps this unregistered type to a CI-Server Concept
      // node whose properties carry importerType: 'music_genre'.
      edges.push({
        relation: 'genre',
        to: { entity: { type: 'music_genre', name: genre, metadata: { Source: 'Amazon Music' } } as Entity },
      });
    }

    return edges;
  }

  private pushTrack(agg: TrackAgg, params: ImportParams): void {
    const title = agg.title ?? '';
    const text = [agg.artist, title].filter(Boolean).join(' — ');
    const metadata: Metadata = {
      Title: title || undefined,
      Artist: agg.artist,
      Album: agg.album,
      'Album Artist': agg.albumArtist !== agg.artist ? agg.albumArtist : undefined,
      Genre: agg.genre,
      Duration: agg.duration,
      'Track Number': agg.trackNumber,
      'Disc Number': agg.discNumber,
      ASIN: agg.asin,
      'Album ASIN': agg.albumAsin,
      'Artist ASIN': agg.artistAsin,
      URL: amazonMusicTrackUrl(agg.asin, agg.albumAsin),
      Purchased: agg.purchased,
      Followed: agg.followed,
      Playlists: agg.playlists.length ? agg.playlists : undefined,
      // The content row's identity (mapping.toContentInput): re-exports and
      // overlapping files collapse onto one row per track.
      URI: `amazonmusic:track:${agg.ident}`,
      Source: 'Amazon Music',
    };
    // The AUDIO's type, not the text stub's: Saved Music records the file
    // extension (mp3/m4a), and a Followed/Playlists row cross-referenced onto
    // a saved track inherits it through the merge. Tracks the library never
    // stored a file for default to Amazon's usual mp3. The item carries no
    // file path, so this only ever describes the track on the content row —
    // nothing tries to upload the stub as audio bytes.
    const ext = (agg.ext ?? '').replace(/^\./, '').toLowerCase();
    const mediaType = (ext ? mimeForFile(`track.${ext}`) : undefined) ?? 'audio/mpeg';
    params.pipeline.push({
      item: {
        id: `amazonmusic:track:${agg.ident}`,
        classification: 'saved_media',
        content: { filename: 'track.txt', mediaType, data: async () => Buffer.from(text) },
        metadata,
      },
      edges: this.edgesFor(agg.artist, agg.albumGenre),
    });
  }

  private pushAlbum(album: AlbumAgg, params: ImportParams): void {
    const text = [album.artist, album.title].filter(Boolean).join(' — ');
    params.pipeline.push({
      item: {
        id: `amazonmusic:album:${album.asin}`,
        classification: 'saved_media',
        content: { filename: 'album.txt', mediaType: 'text/plain', data: async () => Buffer.from(text) },
        metadata: {
          Title: album.title,
          Artist: album.artist,
          Genre: album.genre,
          ASIN: album.asin,
          URL: amazonMusicAlbumUrl(album.asin),
          Followed: true,
          URI: `amazonmusic:album:${album.asin}`,
          Source: 'Amazon Music',
        },
      },
      edges: this.edgesFor(album.artist, album.genre),
    });
  }
}

registerDataSource({
  name: 'amazon_music',
  title: 'Amazon Music',
  icon: '',
  description:
    'Music library from an Amazon data export ("Your Music Library" CSVs): saved, followed, and ' +
    'playlisted tracks and albums as searchable content, with artist and genre entities — no timeline events.',
  newFileImporter: () => new AmazonMusicFileImporter(),
});
