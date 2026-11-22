import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import '..';
import { dataSourcesRecognize } from '../registry';
import type { ImportParams } from '../timeline';
import { YouTubeFileImporter } from '../youtube';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('YouTube datasource', () => {
  it('recognizes directory containing watch-history.json', async () => {
    const root = path.join(FIXTURES_DIR, 'youtube-export');
    const fi = new YouTubeFileImporter();
    const rec = await fi.recognize({}, { filename: 'youtube-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('recognizes watch-history.json file directly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'youtube-export', 'watch-history.json');
    const fi = new YouTubeFileImporter();
    const rec = await fi.recognize({}, { filename: 'watch-history.json', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('imports watch items (only YouTube/YouTube Music headers)', async () => {
    const root = path.join(FIXTURES_DIR, 'youtube-export');
    const fi = new YouTubeFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'youtube-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    // 2 YouTube + 1 YouTube Music = 3; Google Search excluded
    expect(pipeline.length).toBe(3);
    expect(pipeline.every((p) => p.item.classification === 'watch')).toBe(true);
  });

  it('strips "Watched " prefix from title', async () => {
    const root = path.join(FIXTURES_DIR, 'youtube-export');
    const fi = new YouTubeFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'youtube-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const item = pipeline[0].item;
    expect(item.metadata.Title).toBe('How to Code in Python - Full Course');
    expect(item.metadata.Channel).toBe('freeCodeCamp.org');
    expect(item.metadata.URL).toContain('youtube.com');
    expect(item.timestamp).toBeDefined();
  });

  it('sets a stable, distinct id on every JSON item', async () => {
    const root = path.join(FIXTURES_DIR, 'youtube-export');
    const fi = new YouTubeFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'youtube-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const ids = pipeline.map((p) => p.item.id!);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id: string) => id.startsWith('youtube:'))).toBe(true);
  });

  describe('HTML (modern Google MyActivity export)', () => {
    const HTML_ROOT = path.join(FIXTURES_DIR, 'youtube-html-export');

    it('recognizes a dir whose history/ subfolder holds watch-history.html', async () => {
      const fi = new YouTubeFileImporter();
      const rec = await fi.recognize({}, { filename: 'YouTube and YouTube Music', fullPath: HTML_ROOT });
      expect(rec.confidence).toBeGreaterThan(0.8);
    });

    it('recognizes watch-history.html directly', async () => {
      const fpath = path.join(HTML_ROOT, 'history', 'watch-history.html');
      const fi = new YouTubeFileImporter();
      const rec = await fi.recognize({}, { filename: 'watch-history.html', fullPath: fpath });
      expect(rec.confidence).toBeGreaterThan(0.8);
    });

    it('imports watch + search items with the right classifications', async () => {
      const fi = new YouTubeFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'YouTube and YouTube Music', fullPath: HTML_ROOT }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      const watches = pipeline.filter((p) => p.item.classification === 'watch');
      const searches = pipeline.filter((p) => p.item.classification === 'search');
      expect(watches.length).toBe(3);
      expect(searches.length).toBe(2);
      // every pushed item is watch or search
      expect(pipeline.length).toBe(5);
    });

    it('parses watch title/channel/url, decodes entities, and timestamps', async () => {
      const fpath = path.join(HTML_ROOT, 'history', 'watch-history.html');
      const fi = new YouTubeFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'watch-history.html', fullPath: fpath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      const first = pipeline[0].item;
      expect(first.classification).toBe('watch');
      expect(first.metadata.Title).toBe('UK & Election: Last Week Tonight'); // &amp; decoded
      expect(first.metadata.Channel).toBe('LastWeekTonight');
      expect(first.metadata.URL).toBe('https://www.youtube.com/watch?v=RZL_TctrNco');
      expect(first.timestamp).toBeInstanceOf(Date);
      expect(isNaN(first.timestamp!.getTime())).toBe(false);
      expect(first.timestamp!.getUTCFullYear()).toBe(2026);

      // Removed video: title equals the URL upstream and there's no channel anchor
      // either, so Title falls back to the URL rather than the uninformative
      // literal "watch.txt" content filename.
      const removed = pipeline[2].item;
      expect(removed.metadata.Title).toBe('https://www.youtube.com/watch?v=7dN39_6Ls6Q');
      expect(removed.metadata.URL).toBe('https://www.youtube.com/watch?v=7dN39_6Ls6Q');
    });

    it('parses search query into Title/Text and decodes entities', async () => {
      const fpath = path.join(HTML_ROOT, 'history', 'search-history.html');
      const fi = new YouTubeFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'search-history.html', fullPath: fpath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      expect(pipeline.length).toBe(2);
      const s0 = pipeline[0].item;
      expect(s0.classification).toBe('search');
      expect(s0.metadata.Title).toBe('companion intelligence');
      expect(s0.metadata.Text).toBe('companion intelligence');
      expect(s0.metadata.Query).toBe('companion intelligence');
      expect(s0.timestamp).toBeInstanceOf(Date);
      expect(pipeline[1].item.metadata.Text).toBe('rust & wasm'); // &amp; decoded
    });

    it('every HTML item has a truthy, distinct id and a non-filename Title/Text', async () => {
      const fi = new YouTubeFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'YouTube and YouTube Music', fullPath: HTML_ROOT }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      const ids = pipeline.map((p) => p.item.id!);
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id: string) => id.startsWith('youtube:'))).toBe(true);
      // Title/Text is real content, never the bare filename.
      for (const p of pipeline) {
        const label = p.item.metadata.Title || p.item.metadata.Text || p.item.metadata.URL;
        expect(label).toBeTruthy();
        expect(label).not.toMatch(/\.html$/);
      }
    });
  });

  describe('hybrid JSON+HTML export (findHistoryFiles dedup)', () => {
    // Newer Takeouts can carry BOTH watch-history.json and watch-history.html
    // for the same underlying history. findHistoryFiles deliberately drops
    // the HTML file when both exist so the same history isn't imported twice.
    const WATCH_JSON = JSON.stringify([
      {
        header: 'YouTube',
        title: 'Watched How to Code in Python - Full Course',
        titleUrl: 'https://www.youtube.com/watch?v=abc123',
        time: '2021-01-01T20:00:00.000Z',
      },
      {
        header: 'YouTube',
        title: 'Watched TypeScript Tutorial for Beginners',
        titleUrl: 'https://www.youtube.com/watch?v=def456',
        time: '2021-01-02T14:30:00.000Z',
      },
    ]);
    const WATCH_HTML =
      '<html><body>' +
      '<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Watched ' +
      '<a href="https://www.youtube.com/watch?v=abc123">How to Code in Python - Full Course</a><br>' +
      'Jan 1, 2021, 8:00:00 PM UTC<br></div>' +
      '</body></html>';

    async function makeHybridDir(): Promise<string> {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-hybrid-'));
      fs.writeFileSync(path.join(dir, 'watch-history.json'), WATCH_JSON);
      fs.writeFileSync(path.join(dir, 'watch-history.html'), WATCH_HTML);

      return dir;
    }

    it('imports only the JSON watch history when both JSON and HTML are present, not both', async () => {
      const fs = await import('node:fs');
      const dir = await makeHybridDir();
      try {
        const fi = new YouTubeFileImporter();
        const pipeline: EmittedGraph[] = [];
        await fi.fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams);

        const watches = pipeline.filter((p) => p.item.classification === 'watch');
        // 2 JSON entries, NOT 2 JSON + 1 HTML (which would double-count the
        // shared video and add 1 more from the HTML-only side).
        expect(watches.length).toBe(2);
        expect(watches.every((p) => p.item.metadata.URL !== undefined)).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('still imports the HTML file when there is no sibling JSON watch history', async () => {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-html-only-'));
      fs.writeFileSync(path.join(dir, 'watch-history.html'), WATCH_HTML);
      try {
        const fi = new YouTubeFileImporter();
        const pipeline: EmittedGraph[] = [];
        await fi.fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams);

        const watches = pipeline.filter((p) => p.item.classification === 'watch');
        expect(watches.length).toBe(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('subscriptions.csv', () => {
    const root = path.join(FIXTURES_DIR, 'youtube-subscriptions-export');

    it('recognizes a Takeout export containing only subscriptions.csv', async () => {
      const fi = new YouTubeFileImporter();
      const rec = await fi.recognize({}, { filename: 'youtube-subscriptions-export', fullPath: root });
      expect(rec.confidence).toBeGreaterThan(0.6);
    });

    it('recognizes subscriptions.csv directly by file', async () => {
      const fpath = path.join(root, 'YouTube and YouTube Music', 'subscriptions', 'subscriptions.csv');
      const fi = new YouTubeFileImporter();
      const rec = await fi.recognize({}, { filename: 'subscriptions.csv', fullPath: fpath });
      expect(rec.confidence).toBeGreaterThan(0.6);
    });

    it('does not recognize a same-named CSV with an unrelated header as subscriptions.csv', async () => {
      // Named subscriptions.csv but with a completely different (e.g. a
      // streaming-service billing export) header shape — confirms the
      // recognizer checks column headers, not just the filename.
      const fi = new YouTubeFileImporter();
      const rec = await fi.recognize(
        {},
        {
          filename: 'subscriptions.csv',
          fullPath: path.join(FIXTURES_DIR, 'unrelated-subscriptions-csv', 'subscriptions.csv'),
        },
      );
      expect(rec.confidence).toBe(0);
    });

    it('imports one item per subscribed channel', async () => {
      const fi = new YouTubeFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'youtube-subscriptions-export', fullPath: root }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      expect(pipeline.length).toBe(2);
      expect(pipeline.every((p) => p.item.classification === 'subscription')).toBe(true);
      expect(pipeline[0].item.metadata.Channel).toBe('freeCodeCamp.org');
      expect(pipeline[0].item.metadata.URL).toContain('youtube.com');
      expect(pipeline[0].item.metadata.ChannelId).toBe('UC7Q-BJs-7izPsRN907IOuBw');
      // Takeout's subscriptions export carries no per-row timestamp.
      expect(pipeline[0].item.timestamp).toBeUndefined();
    });

    it('gives each channel a stable, distinct id derived from the channel id', async () => {
      const fi = new YouTubeFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'youtube-subscriptions-export', fullPath: root }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      const ids = pipeline.map((p) => p.item.id!);
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      // Channel-id rows carry the canonical `subscription:<channelId>` —
      // the identity the connection's subscriptions sync mints, so the two
      // pipelines converge (docs/design/cross-pipeline-identity.md); only a
      // row with no Channel Id keeps the per-pipeline hash lane.
      expect(ids.every((id: string) => id.startsWith('subscription:') || id.startsWith('youtube:sub:'))).toBe(
        true,
      );
      expect(ids.some((id: string) => id.startsWith('subscription:'))).toBe(true);
    });
  });

  describe('HTML entry extraction survives a nested div', () => {
    // Same cell shape and history as google_my_activity.ts: a non-greedy
    // `[\s\S]*?<\/div>` stops at the FIRST `</div>`, which here would close a
    // thumbnail wrapper and drop the real link/timestamp that follow it.
    const NESTED_DIV_HTML =
      '<html><body>' +
      '<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">' +
      '<div class="thumbnail"><img src="thumb.png"></div>' +
      'Watched <a href="https://www.youtube.com/watch?v=abc123">How to Code in Python</a><br>' +
      'Jan 1, 2021, 8:00:00 PM UTC<br></div>' +
      '</body></html>';

    it('reads the link and timestamp AFTER a nested div, not just up to its close', async () => {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-nested-div-'));
      fs.writeFileSync(path.join(dir, 'watch-history.html'), NESTED_DIV_HTML);
      try {
        const fi = new YouTubeFileImporter();
        const pipeline: EmittedGraph[] = [];
        await fi.fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams);

        // Truncated-at-the-nested-close would have no anchor to read the
        // video URL/title from, and the whole entry would be dropped.
        expect(pipeline).toHaveLength(1);
        expect(pipeline[0].item.classification).toBe('watch');
        expect(pipeline[0].item.metadata.URL).toContain('abc123');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('YouTube datasource — playlists', () => {
  let root: string;
  const YT = 'Takeout/YouTube and YouTube Music';

  const write = (rel: string, body: string): void => {
    const fpath = path.join(root, rel);
    fs.mkdirSync(path.dirname(fpath), { recursive: true });
    fs.writeFileSync(fpath, body);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-playlists-'));
    write(
      `${YT}/history/watch-history.json`,
      JSON.stringify([
        {
          header: 'YouTube',
          title: 'Watched Blowing a brass lantern globe',
          titleUrl: 'https://www.youtube.com/watch?v=Qx81LmP0ra1',
          time: '2026-09-01T19:42:11.512Z',
        },
      ]),
    );
    write(
      `${YT}/subscriptions/subscriptions.csv`,
      'Channel Id,Channel Url,Channel Title\nUCq7Fh3Zr2LmXbWkKp9VtYzA,http://www.youtube.com/channel/UCq7Fh3Zr2LmXbWkKp9VtYzA,Glassworks\n',
    );
    write(
      `${YT}/playlists/playlists.csv`,
      'Playlist ID,Add new videos to top,Playlist Title (Original),Playlist Title (Original) Language,' +
        'Playlist Create Timestamp,Playlist Update Timestamp,Playlist Video Order,Playlist Visibility\n' +
        'PLz4Qm8Rt2Kda,False,Lantern references,,2026-09-02T10:00:00+00:00,2026-09-10T10:00:00+00:00,Manual,Private\n',
    );
    write(
      `${YT}/playlists/Lantern references-videos.csv`,
      'Video ID,Playlist Video Creation Timestamp\nQx81LmP0ra1,2026-09-02T10:01:00+00:00\nTm9Rv2KcLa3,2026-09-10T10:02:00+00:00\n',
    );
    write(
      `${YT}/playlists/Watch later-videos.csv`,
      'Video ID,Playlist Video Creation Timestamp\nWc3sNt7Uba2,2026-09-03T06:00:00+00:00\n',
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const importFrom = async (dir: string): Promise<EmittedGraph[]> => {
    const pipeline: EmittedGraph[] = [];
    await new YouTubeFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline;
  };

  it('keeps playlists/ as a match of its own and leaves the rest of the Takeout folder to the catch-all', async () => {
    // Without subscriptions.csv nothing claims the folders above the Takeout
    // folder, so which matches survive does not depend on readdir order.
    fs.rmSync(path.join(root, YT, 'subscriptions'), { recursive: true });
    write(`${YT}/videos/Glassblowing at dawn.mp4`, 'not really a video');
    const matches = await dataSourcesRecognize(
      undefined,
      { filename: path.basename(root), fullPath: root, fsRoot: root },
      {},
      { descend: true },
    );
    const youtube = matches.filter((m) => m.data_source.name === 'youtube').map((m) => m.matchedPath!);
    expect(youtube.sort()).toEqual([path.join(root, YT, 'history'), path.join(root, YT, 'playlists')]);
    // The uploaded videos stay with the catch-all importer: no YouTube match covers them.
    const videos = path.join(root, YT, 'videos');
    expect(youtube.some((m) => videos === m || videos.startsWith(m + path.sep))).toBe(false);

    const pipeline = (await Promise.all(youtube.map((m) => importFrom(m)))).flat();
    expect(pipeline.map((g) => g.item.classification).sort()).toEqual([
      'saved_media',
      'saved_media',
      'watch',
    ]);
  });

  it('reads history, subscriptions and playlists when handed the whole Takeout folder', async () => {
    const pipeline = await importFrom(path.join(root, YT));
    expect(pipeline.map((g) => g.item.classification).sort()).toEqual([
      'saved_media',
      'saved_media',
      'subscription',
      'watch',
    ]);
  });

  it('imports each playlist with its videos, keyed on the playlist id', async () => {
    const playlists = (await importFrom(path.join(root, YT)))
      .filter((g) => g.item.classification === 'saved_media')
      .map((g) => g.item);
    const lantern = playlists.find((p) => p.metadata.Title === 'Lantern references')!;
    expect(lantern.id).toBe('playlist:PLz4Qm8Rt2Kda');
    expect(lantern.timestamp).toEqual(new Date('2026-09-02T10:00:00Z'));
    expect(lantern.metadata).toMatchObject({
      URL: 'https://www.youtube.com/playlist?list=PLz4Qm8Rt2Kda',
      PlaylistId: 'PLz4Qm8Rt2Kda',
      Visibility: 'Private',
      Source: 'YouTube',
      Videos: [
        {
          VideoId: 'Qx81LmP0ra1',
          URL: 'https://www.youtube.com/watch?v=Qx81LmP0ra1',
          Added: '2026-09-02T10:01:00.000Z',
        },
        {
          VideoId: 'Tm9Rv2KcLa3',
          URL: 'https://www.youtube.com/watch?v=Tm9Rv2KcLa3',
          Added: '2026-09-10T10:02:00.000Z',
        },
      ],
    });
    expect(lantern.metadata.Text).toBe(
      'https://www.youtube.com/watch?v=Qx81LmP0ra1 (added 2026-09-02)\nhttps://www.youtube.com/watch?v=Tm9Rv2KcLa3 (added 2026-09-10)',
    );

    // Watch later is not in playlists.csv: no id to key on, so its title is.
    const later = playlists.find((p) => p.metadata.Title === 'Watch later')!;
    expect(later.id).toMatch(/^youtube:playlist-title:[0-9a-f]{40}$/);
    expect(later.metadata.URL).toBeUndefined();
    expect(later.metadata.Videos).toEqual([
      {
        VideoId: 'Wc3sNt7Uba2',
        URL: 'https://www.youtube.com/watch?v=Wc3sNt7Uba2',
        Added: '2026-09-03T06:00:00.000Z',
      },
    ]);
  });

  it('recognizes and imports a playlists folder uploaded on its own', async () => {
    const dir = path.join(root, YT, 'playlists');
    const rec = await new YouTubeFileImporter().recognize({}, { filename: 'playlists', fullPath: dir });
    expect(rec.confidence).toBe(0.9);
    expect((await importFrom(dir)).map((g) => g.item.metadata.Title).sort()).toEqual([
      'Lantern references',
      'Watch later',
    ]);
  });

  it('keys a playlist on its id when its file name lost the punctuation of its title', async () => {
    write(
      `${YT}/playlists/playlists.csv`,
      'Playlist ID,Playlist Title (Original),Playlist Create Timestamp\n' +
        'PLk2Rt7Uc9Mz,Lanterns: brass/copper,2026-09-04T10:00:00+00:00\n',
    );
    fs.rmSync(path.join(root, YT, 'playlists', 'Lantern references-videos.csv'));
    write(
      `${YT}/playlists/Lanterns_ brass_copper-videos.csv`,
      'Video ID,Playlist Video Creation Timestamp\nQx81LmP0ra1,2026-09-04T10:01:00+00:00\n',
    );

    const playlist = (await importFrom(path.join(root, YT, 'playlists'))).find(
      (g) => g.item.metadata.Title === 'Lanterns: brass/copper',
    )!.item;
    expect(playlist.id).toBe('playlist:PLk2Rt7Uc9Mz');
    expect(playlist.timestamp).toEqual(new Date('2026-09-04T10:00:00Z'));
  });

  it('still reads the video lists when playlists.csv has a header it does not know', async () => {
    write(`${YT}/playlists/playlists.csv`, 'Something else entirely\n');
    const dir = path.join(root, YT, 'playlists');
    const rec = await new YouTubeFileImporter().recognize({}, { filename: 'playlists', fullPath: dir });
    expect(rec.confidence).toBe(0.9);
    expect((await importFrom(dir)).map((g) => g.item.metadata.Title).sort()).toEqual([
      'Lantern references',
      'Watch later',
    ]);
  });
});
