import path from 'path';

import { SpotifyFileImporter } from '../spotify';
import type { ImportParams } from '../timeline';

import type { EmittedGraph, TestPipeline } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Spotify datasource', () => {
  it('recognizes export directory by StreamingHistory file', async () => {
    const root = path.join(FIXTURES_DIR, 'spotify-export');
    const fi = new SpotifyFileImporter();
    const rec = await fi.recognize({}, { filename: 'spotify-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('recognizes single StreamingHistory file directly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'spotify-export', 'StreamingHistory0.json');
    const fi = new SpotifyFileImporter();
    const rec = await fi.recognize({}, { filename: 'StreamingHistory0.json', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('imports streaming history into play items', async () => {
    const root = path.join(FIXTURES_DIR, 'spotify-export');
    const fi = new SpotifyFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'spotify-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(3);
    expect(pipeline[0].item.classification).toBe('listen');
    expect(pipeline[0].item.metadata.Track).toBe('Karma Police');
    expect(pipeline[0].item.metadata.Artist).toBe('Radiohead');
    expect(pipeline[0].item.metadata['ms Played']).toBe(265000);
    // Spotify serves Ogg Vorbis; the content mimetype reflects the real format.
    expect(pipeline[0].item.content.mediaType).toBe('audio/ogg');
    // endTime "2021-01-01 12:00" is the STOP time; start walks back msPlayed
    // (265s), and the stop time becomes the span end.
    expect(pipeline[0].item.timestamp?.toISOString()).toBe('2021-01-01T11:55:35.000Z');
    expect(pipeline[0].item.timespanEnd?.toISOString()).toBe('2021-01-01T12:00:00.000Z');
  });

  it('keeps the stop time as the timestamp when msPlayed is absent, with no span end', async () => {
    const data = [{ endTime: '2021-01-01 12:00', artistName: 'Radiohead', trackName: 'Karma Police' }];
    const tmpFile = path.join(FIXTURES_DIR, 'spotify-export', 'StreamingHistory8.json');
    const fs = await import('node:fs');
    await fs.promises.writeFile(tmpFile, JSON.stringify(data));
    try {
      const fi = new SpotifyFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'StreamingHistory8.json', fullPath: tmpFile }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(1);
      expect(pipeline[0].item.timestamp?.toISOString()).toBe('2021-01-01T12:00:00.000Z');
      expect(pipeline[0].item.timespanEnd).toBeUndefined();
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => {});
    }
  });

  it('imports endsong format', async () => {
    const fi = new SpotifyFileImporter();
    const pipeline: EmittedGraph[] = [];
    const endsongData = [
      {
        ts: '2021-06-15T14:30:00Z',
        master_metadata_track_name: 'Motion Picture Soundtrack',
        master_metadata_album_artist_name: 'Radiohead',
        master_metadata_album_album_name: 'Kid A',
        ms_played: 293000,
        shuffle: false,
        skipped: false,
      },
    ];
    const tmpFile = path.join(FIXTURES_DIR, 'spotify-export', 'endsong_0.json');
    const fs = await import('node:fs');
    await fs.promises.writeFile(tmpFile, JSON.stringify(endsongData));
    try {
      await fi.fileImport({}, { filename: 'endsong_0.json', fullPath: tmpFile }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(1);
      expect(pipeline[0].item.classification).toBe('listen');
      expect(pipeline[0].item.metadata.Track).toBe('Motion Picture Soundtrack');
      expect(pipeline[0].item.metadata.Album).toBe('Kid A');
      // ts "14:30:00Z" is the stop time; start walks back ms_played (293s).
      expect(pipeline[0].item.timestamp?.toISOString()).toBe('2021-06-15T14:25:07.000Z');
      expect(pipeline[0].item.timespanEnd?.toISOString()).toBe('2021-06-15T14:30:00.000Z');
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => {});
    }
  });

  it('imports podcast episodes and audiobook chapters, skipping unresolvable stubs', async () => {
    const fi = new SpotifyFileImporter();
    const pipeline: EmittedGraph[] = [];
    const data = [
      {
        ts: '2021-04-17T14:48:05Z',
        episode_name: '#140 The Roman Mars Mazda Virus',
        episode_show_name: 'Reply All',
        spotify_episode_uri: 'spotify:episode:abc123',
        ms_played: 1800000,
      },
      {
        ts: '2025-06-07T05:46:31Z',
        audiobook_title: 'Speaker for the Dead',
        audiobook_chapter_title: 'Chapter 0',
        audiobook_uri: 'spotify:show:0o5XcWXvzqJIZaKrCsBcF8',
        audiobook_chapter_uri: 'spotify:episode:1sJ1gHD5YU5ihDesObiVvU',
        ms_played: 124814,
      },
      // Anonymous playback stub: no track, episode, or audiobook identity.
      { ts: '2025-10-20T00:58:07Z', ms_played: 6336, skipped: true },
    ];
    const tmpFile = path.join(FIXTURES_DIR, 'spotify-export', 'endsong_1.json');
    const fs = await import('node:fs');
    await fs.promises.writeFile(tmpFile, JSON.stringify(data));
    try {
      const testPipeline: TestPipeline = Object.assign(pipeline, { drop: jest.fn() });
      await fi.fileImport({}, { filename: 'endsong_1.json', fullPath: tmpFile }, {
        pipeline: testPipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(2);
      // The anonymous stub (no track/episode/audiobook identity) is reported,
      // not silently swallowed.
      expect(testPipeline.drop).toHaveBeenCalledWith('unresolvable_playback_stub');
      expect(testPipeline.drop).toHaveBeenCalledTimes(1);

      const podcast = pipeline[0].item;
      expect(podcast.classification).toBe('listen');
      expect(podcast.metadata.Type).toBe('podcast');
      expect(podcast.metadata.Episode).toBe('#140 The Roman Mars Mazda Virus');
      expect(podcast.metadata.Show).toBe('Reply All');
      expect(podcast.metadata.URI).toBe('spotify:episode:abc123');
      expect(podcast.metadata.URL).toBe('https://open.spotify.com/episode/abc123');
      // 30 min played, stopped 14:48:05 → started 14:18:05.
      expect(podcast.timestamp?.toISOString()).toBe('2021-04-17T14:18:05.000Z');
      expect(podcast.timespanEnd?.toISOString()).toBe('2021-04-17T14:48:05.000Z');

      const book = pipeline[1].item;
      expect(book.metadata.Type).toBe('audiobook');
      expect(book.metadata.Book).toBe('Speaker for the Dead');
      expect(book.metadata.Chapter).toBe('Chapter 0');
      expect(book.metadata.URI).toBe('spotify:episode:1sJ1gHD5YU5ihDesObiVvU');
      // Chapter URL: the chapter is an episode object; the book itself would
      // fall back to /show/<id> from audiobook_uri.
      expect(book.metadata.URL).toBe('https://open.spotify.com/episode/1sJ1gHD5YU5ihDesObiVvU');
      expect(new Set(pipeline.map((g) => g.item.id!)).size).toBe(2);
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => {});
    }
  });

  it('drops plays under one second in both formats, and reports them', async () => {
    const fi = new SpotifyFileImporter();
    const fs = await import('node:fs');
    // Extended format: 999 ms dropped, exactly 1000 ms kept.
    const endsong = [
      {
        ts: '2021-06-15T14:30:00Z',
        master_metadata_track_name: 'Skipped Song',
        master_metadata_album_artist_name: 'X',
        ms_played: 999,
      },
      {
        ts: '2021-06-15T14:31:00Z',
        master_metadata_track_name: 'Kept Song',
        master_metadata_album_artist_name: 'X',
        ms_played: 1000,
      },
    ];
    const endsongFile = path.join(FIXTURES_DIR, 'spotify-export', 'endsong_2.json');
    await fs.promises.writeFile(endsongFile, JSON.stringify(endsong));
    // Compact format too.
    const compact = [
      { endTime: '2021-01-01 12:00', artistName: 'X', trackName: 'Blip', msPlayed: 500 },
      { endTime: '2021-01-01 12:05', artistName: 'X', trackName: 'Real Play', msPlayed: 200000 },
    ];
    const compactFile = path.join(FIXTURES_DIR, 'spotify-export', 'StreamingHistory7.json');
    await fs.promises.writeFile(compactFile, JSON.stringify(compact));
    try {
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
        drop: jest.fn(),
        consumed: jest.fn(),
      });
      await fi.fileImport({}, { filename: 'endsong_2.json', fullPath: endsongFile }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      await fi.fileImport({}, { filename: 'StreamingHistory7.json', fullPath: compactFile }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.map((g) => g.item.metadata.Track)).toEqual(['Kept Song', 'Real Play']);
      expect(pipeline.drop).toHaveBeenCalledTimes(2);
      expect(pipeline.drop).toHaveBeenCalledWith('sub_second_play');
      // One call per file, each with the file's own record count — not a
      // per-row counter, since the array's own `.length` is cheap and exact.
      expect(pipeline.consumed).toHaveBeenCalledWith(2);
      expect(pipeline.consumed).toHaveBeenCalledTimes(2);
    } finally {
      await fs.promises.unlink(endsongFile).catch(() => {});
      await fs.promises.unlink(compactFile).catch(() => {});
    }
  });

  it('gives same-minute plays distinct, stable, idempotent ids', async () => {
    // Compact StreamingHistory uses minute-precision endTime. Two different tracks
    // finishing in the same clock minute would collapse without a per-row id.
    const data = [
      { endTime: '2021-01-01 12:00', artistName: 'Radiohead', trackName: 'Karma Police', msPlayed: 265000 },
      { endTime: '2021-01-01 12:00', artistName: 'Radiohead', trackName: 'No Surprises', msPlayed: 229000 },
      { endTime: '2021-01-01 12:00', artistName: 'Radiohead', trackName: 'Karma Police', msPlayed: 265000 },
    ];
    const tmpFile = path.join(FIXTURES_DIR, 'spotify-export', 'StreamingHistory9.json');
    const fs = await import('node:fs');
    await fs.promises.writeFile(tmpFile, JSON.stringify(data));
    try {
      const fi = new SpotifyFileImporter();
      const run = async () => {
        const pipeline: EmittedGraph[] = [];
        await fi.fileImport({}, { filename: 'StreamingHistory9.json', fullPath: tmpFile }, {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams);

        return pipeline;
      };

      const pipeline = await run();
      expect(pipeline.length).toBe(3);
      const ids = pipeline.map((g) => g.item.id!);
      expect(ids.every((id) => !!id)).toBe(true);
      expect(new Set(ids).size).toBe(3);
      // Re-import yields identical ids (idempotent / deterministic).
      const again = await run();
      expect(again.map((g) => g.item.id!)).toEqual(ids);
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => {});
    }
  });

  it('imports Streaming_History_Video files as watch items', async () => {
    const fi = new SpotifyFileImporter();
    const data = [
      {
        ts: '2017-07-18T15:07:09Z',
        episode_name: 'Wale Breaks Down "Fashion Week"',
        episode_show_name: 'Verified',
        spotify_episode_uri: 'spotify:episode:7g0xa1EUzSso5bTZnJf7wU',
        ms_played: 47771,
      },
      {
        ts: '2024-03-01T20:00:00Z',
        master_metadata_track_name: 'Houdini',
        master_metadata_album_artist_name: 'Dua Lipa',
        spotify_track_uri: 'spotify:track:4OMJGnvZfDvsePyCwRGO7X',
        ms_played: 185000,
      },
    ];
    const tmpFile = path.join(FIXTURES_DIR, 'spotify-export', 'Streaming_History_Video_2024.json');
    const fs = await import('node:fs');
    await fs.promises.writeFile(tmpFile, JSON.stringify(data));
    try {
      const rec = await fi.recognize(
        {},
        { filename: 'Streaming_History_Video_2024.json', fullPath: tmpFile },
      );
      expect(rec.confidence).toBeGreaterThan(0.9);

      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'Streaming_History_Video_2024.json', fullPath: tmpFile }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(2);
      // Video rows are watched, not listened to — both shapes.
      expect(pipeline.every((g) => g.item.classification === 'watch')).toBe(true);
      // Spotify serves video as MP4, unlike the audio items' audio/ogg.
      expect(pipeline.every((g) => g.item.content.mediaType === 'video/mp4')).toBe(true);
      expect(pipeline[0].item.metadata.Type).toBe('podcast');
      expect(pipeline[0].item.metadata.Show).toBe('Verified');
      expect(pipeline[0].item.metadata.URL).toBe('https://open.spotify.com/episode/7g0xa1EUzSso5bTZnJf7wU');
      expect(pipeline[1].item.metadata.Track).toBe('Houdini');
      expect(pipeline[1].item.metadata.URL).toBe('https://open.spotify.com/track/4OMJGnvZfDvsePyCwRGO7X');
      expect(pipeline[1].item.timespanEnd?.toISOString()).toBe('2024-03-01T20:00:00.000Z');
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => {});
    }
  });

  it('imports the current Extended Streaming History format from a nested subfolder', async () => {
    // Current Spotify export: Streaming_History_Audio_*.json inside a
    // "Spotify Extended Streaming History/" subfolder — must be found by recursion.
    const root = path.join(FIXTURES_DIR, 'spotify-extended');
    const fi = new SpotifyFileImporter();

    const rec = await fi.recognize({}, { filename: 'spotify-extended', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.9);

    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'spotify-extended', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(1);
    expect(pipeline[0].item.classification).toBe('listen');
    expect(pipeline[0].item.metadata.Track).toBe('Weird Fishes');
    expect(pipeline[0].item.metadata.Artist).toBe('Radiohead');
    expect(pipeline[0].item.metadata.Album).toBe('In Rainbows');
  });

  it('drops plays outside the requested timeframe, in both formats', async () => {
    const fi = new SpotifyFileImporter();
    const fs = await import('node:fs');
    const endsong = [
      {
        ts: '2019-06-15T14:30:00Z',
        master_metadata_track_name: 'Too Early',
        master_metadata_album_artist_name: 'X',
        ms_played: 200000,
      },
    ];
    const endsongFile = path.join(FIXTURES_DIR, 'spotify-export', 'endsong_3.json');
    await fs.promises.writeFile(endsongFile, JSON.stringify(endsong));
    const compact = [
      { endTime: '2019-01-01 12:00', artistName: 'X', trackName: 'Too Early', msPlayed: 200000 },
    ];
    const compactFile = path.join(FIXTURES_DIR, 'spotify-export', 'StreamingHistory10.json');
    await fs.promises.writeFile(compactFile, JSON.stringify(compact));
    try {
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], { drop: jest.fn() });
      const timeframe = { since: new Date('2021-01-01T00:00:00Z') };
      await fi.fileImport({}, { filename: 'endsong_3.json', fullPath: endsongFile }, {
        pipeline,
        timeframe,
        log: () => {},
      } as unknown as ImportParams);
      await fi.fileImport({}, { filename: 'StreamingHistory10.json', fullPath: compactFile }, {
        pipeline,
        timeframe,
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(0);
      expect(pipeline.drop).toHaveBeenCalledTimes(2);
      expect(pipeline.drop).toHaveBeenCalledWith('outside_timeframe');
    } finally {
      await fs.promises.unlink(endsongFile).catch(() => {});
      await fs.promises.unlink(compactFile).catch(() => {});
    }
  });

  it('reports an unreadable file once rather than silently reading nothing', async () => {
    const fi = new SpotifyFileImporter();
    const fs = await import('node:fs');
    const malformedFile = path.join(FIXTURES_DIR, 'spotify-export', 'endsong_4.json');
    await fs.promises.writeFile(malformedFile, '{not valid json');
    const nonArrayFile = path.join(FIXTURES_DIR, 'spotify-export', 'endsong_5.json');
    await fs.promises.writeFile(nonArrayFile, JSON.stringify({ not: 'an array' }));
    try {
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], { drop: jest.fn() });
      await fi.fileImport({}, { filename: 'endsong_4.json', fullPath: malformedFile }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      await fi.fileImport({}, { filename: 'endsong_5.json', fullPath: nonArrayFile }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(0);
      expect(pipeline.drop).toHaveBeenCalledTimes(2);
      expect(pipeline.drop).toHaveBeenCalledWith('unreadable_file', 'endsong_4.json');
      expect(pipeline.drop).toHaveBeenCalledWith('unreadable_file', 'endsong_5.json');
    } finally {
      await fs.promises.unlink(malformedFile).catch(() => {});
      await fs.promises.unlink(nonArrayFile).catch(() => {});
    }
  });

  it('reports how many records a file offered the parser, via consumed()', async () => {
    const fi = new SpotifyFileImporter();
    const fs = await import('node:fs');
    const data = [
      { endTime: '2021-01-01 12:00', artistName: 'X', trackName: 'One', msPlayed: 200000 },
      { endTime: '2021-01-01 12:05', artistName: 'X', trackName: 'Two', msPlayed: 200000 },
      { endTime: '2021-01-01 12:10', artistName: 'X', trackName: 'Three', msPlayed: 200000 },
    ];
    const tmpFile = path.join(FIXTURES_DIR, 'spotify-export', 'StreamingHistory11.json');
    await fs.promises.writeFile(tmpFile, JSON.stringify(data));
    try {
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], { consumed: jest.fn() });
      await fi.fileImport({}, { filename: 'StreamingHistory11.json', fullPath: tmpFile }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(3);
      expect(pipeline.consumed).toHaveBeenCalledTimes(1);
      expect(pipeline.consumed).toHaveBeenCalledWith(3);
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => {});
    }
  });
});
