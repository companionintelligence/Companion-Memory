import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { allDataSources } from '../registry';
import type { ImportParams, Timeframe } from '../timeline';

import '../google_my_activity';
import type { EmittedGraph, TestPipeline } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'google_my_activity', 'My Activity');
const SEARCH_HTML = path.join(FIXTURES_DIR, 'Search', 'MyActivity.html');
const MAPS_HTML = path.join(FIXTURES_DIR, 'Maps', 'MyActivity.html');
const YOUTUBE_HTML = path.join(FIXTURES_DIR, 'YouTube', 'MyActivity.html');

function getImporter() {
  const ds = allDataSources().find((d) => d.name === 'google_my_activity');
  if (!ds?.newFileImporter) {
    throw new Error('missing importer');
  }

  return ds.newFileImporter();
}

async function runImport(fullPath: string, filename = 'MyActivity.html', timeframe: Timeframe = {}) {
  const importer = getImporter();
  const pipeline: EmittedGraph[] = [];
  await importer.fileImport({}, { filename, fullPath }, {
    pipeline,
    timeframe,
    log: () => {},
  } as unknown as ImportParams);

  return pipeline.filter((p) => p.item).map((p) => p.item);
}

async function runImportWithPipeline(pipeline: TestPipeline, fullPath: string, filename = 'MyActivity.html') {
  const importer = getImporter();
  await importer.fileImport({}, { filename, fullPath }, {
    pipeline,
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);
}

describe('Google My Activity datasource', () => {
  it('recognizes a MyActivity.html file', async () => {
    const importer = getImporter();
    const rec = await importer.recognize({}, { filename: 'MyActivity.html', fullPath: SEARCH_HTML }, {});
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('recognizes a My Activity directory', async () => {
    const importer = getImporter();
    const rec = await importer.recognize({}, { filename: 'My Activity', fullPath: FIXTURES_DIR }, {});
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('does not recognize unrelated HTML', async () => {
    const importer = getImporter();
    const rec = await importer.recognize({}, { filename: 'index.html', fullPath: '/nope/index.html' }, {});
    expect(rec.confidence).toBe(0);
  });

  it('produces one item per activity entry', async () => {
    const items = await runImport(SEARCH_HTML);
    expect(items.length).toBe(2);
  });

  it('classifies "Visited" as page_view with URL + Title', async () => {
    const items = await runImport(SEARCH_HTML);
    const visited = items[0];
    expect(visited.classification).toBe('page_view');
    expect(visited.metadata?.Title).toBe("Jaron Lanier's Homepage");
    expect(visited.metadata?.URL).toContain('jaronlanier.com');
    expect(visited.metadata?.Product).toBe('Search');
  });

  it('classifies "Searched for" as search with Query as Text + Title', async () => {
    const items = await runImport(SEARCH_HTML);
    const searched = items[1];
    expect(searched.classification).toBe('search');
    expect(searched.metadata?.Title).toBe('Lanier');
    expect(searched.metadata?.Text).toBe('Lanier');
    expect(searched.metadata?.Query).toBe('Lanier');
  });

  it('classifies a link-less action entry as page_view with the action text as Title', async () => {
    const items = await runImport(MAPS_HTML);
    expect(items.length).toBe(1);
    expect(items[0].classification).toBe('page_view');
    expect(items[0].metadata?.Title).toBe('Explored on Google Maps');
    expect(items[0].metadata?.Product).toBe('Maps');
    expect(items[0].metadata?.URL).toBeUndefined();
  });

  it('sets a meaningful Title (never a bare filename)', async () => {
    const items = await runImport(SEARCH_HTML);
    expect(
      items.every((i) => {
        const t = i.metadata?.Title as string | undefined;

        return !!t && !t.toLowerCase().includes('myactivity');
      }),
    ).toBe(true);
  });

  it('parses real timestamps', async () => {
    const items = await runImport(SEARCH_HTML);
    expect(items[0].timestamp instanceof Date).toBe(true);
    // "Jun 17, 2026, 9:30:52 PM PDT" → UTC
    expect(items[0].timestamp?.toISOString()).toBe('2026-06-18T04:30:52.000Z');
    expect(items.every((i) => i.timestamp && !isNaN(i.timestamp!.getTime()))).toBe(true);
  });

  it('assigns a truthy, distinct, stable id to every item (idempotent re-import)', async () => {
    const first = await runImport(SEARCH_HTML);
    const ids = first.map((i) => i.id!);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    const second = await runImport(SEARCH_HTML);
    expect(second.map((i) => i.id!)).toEqual(ids); // deterministic across runs
  });

  it('respects the timeframe filter', async () => {
    const items = await runImport(SEARCH_HTML, 'MyActivity.html', {
      since: new Date('2027-01-01T00:00:00Z'),
    });
    expect(items.length).toBe(0);
  });

  it('walks a directory and imports every product file', async () => {
    const items = await runImport(FIXTURES_DIR, 'My Activity');
    expect(items.length).toBe(7);
    const products = new Set(items.map((i) => i.metadata?.Product));
    expect(products.has('Search')).toBe(true);
    expect(products.has('Maps')).toBe(true);
    expect(products.has('YouTube')).toBe(true);
  });

  describe('YouTube product (real My Activity/YouTube/MyActivity.html shape)', () => {
    it('imports one item per entry, including link-less and multi-line ones', async () => {
      const items = await runImport(YOUTUBE_HTML);
      expect(items.length).toBe(4);
      expect(items.every((i) => i.metadata?.Product === 'YouTube')).toBe(true);
    });

    it('classifies "Watched" as page_view using the FIRST link (the video, not the channel)', async () => {
      const items = await runImport(YOUTUBE_HTML);
      const watched = items[0];
      expect(watched.classification).toBe('page_view');
      expect(watched.metadata?.Title).toBe(
        'UK & Makerfield Election: Last Week Tonight with John Oliver (HBO)',
      );
      expect(watched.metadata?.URL).toContain('watch?v=RZL_TctrNco');
      // The second <a> (the channel) is never captured as its own field.
      expect(watched.metadata?.URL).not.toContain('/channel/');
    });

    it('classifies "Searched for" as search, scoped to the YouTube product', async () => {
      const items = await runImport(YOUTUBE_HTML);
      const searched = items[1];
      expect(searched.classification).toBe('search');
      expect(searched.metadata?.Query).toBe('companion intelligence');
    });

    it('keeps a channel-only "Subscribed to" entry as page_view with the channel URL', async () => {
      const items = await runImport(YOUTUBE_HTML);
      const subscribed = items[2];
      expect(subscribed.classification).toBe('page_view');
      expect(subscribed.metadata?.URL).toContain('/channel/UCxTclqPDlFzC6yMVtWYm_DA');
    });

    it('parses the TRAILING timestamp, not an embedded date-only string earlier in the cell', async () => {
      const items = await runImport(YOUTUBE_HTML);
      // "Dismissed shelf<br>Expiration date: Dec 8, 2026<br>Jun 11, 2026, 8:16:38 PM PDT<br>"
      // must resolve to the real trailing timestamp, not "Dec 8, 2026" (which has
      // no time component and so cannot match TIMESTAMP_RE on its own).
      const dismissed = items[3];
      expect(dismissed.timestamp?.toISOString()).toBe('2026-06-12T03:16:38.000Z');
    });
  });

  describe('parser loss reporting (reconciliation)', () => {
    it('reports every body cell read via consumed(), matching the real file exactly', async () => {
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], { consumed: jest.fn() });
      await runImportWithPipeline(pipeline, YOUTUBE_HTML);
      expect(pipeline.consumed).toHaveBeenCalledTimes(1);
      expect(pipeline.consumed).toHaveBeenCalledWith(4);
    });

    it('drops entries excluded by the timeframe filter, not just omits them', async () => {
      const importer = getImporter();
      const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], { drop: jest.fn() });
      await importer.fileImport({}, { filename: 'MyActivity.html', fullPath: SEARCH_HTML }, {
        pipeline,
        timeframe: { since: new Date('2027-01-01T00:00:00Z') },
        log: () => {},
      } as unknown as ImportParams);

      expect(pipeline.length).toBe(0);
      expect(pipeline.drop).toHaveBeenCalledTimes(2);
      expect(pipeline.drop).toHaveBeenCalledWith('outside_timeframe');
    });

    it('reports an unreadable file via drop(), independent of consumed()', async () => {
      const fs = await import('node:fs');
      const readFileSpy = jest
        .spyOn(fs.promises, 'readFile')
        .mockRejectedValueOnce(new Error('EACCES: permission denied'));
      try {
        const importer = getImporter();
        const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
          drop: jest.fn(),
          consumed: jest.fn(),
        });
        await importer.fileImport({}, { filename: 'MyActivity.html', fullPath: SEARCH_HTML }, {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams);

        expect(pipeline.drop).toHaveBeenCalledWith('unreadable_file', 'MyActivity.html');
        expect(pipeline.consumed).not.toHaveBeenCalled();
      } finally {
        readFileSpy.mockRestore();
      }
    });
  });
});

// A MyActivity.html downloaded straight from myactivity.google.com: no product
// folder (it sits in a date folder), products mixed in one file, and the bulk
// of it is YouTube watch history that the YouTube Takeout no longer ships.
describe('Google My Activity — standalone file with YouTube entries', () => {
  const STANDALONE = path.join(__dirname, 'fixtures', 'google_my_activity', '2026-07-24', 'MyActivity.html');

  it('takes the product from each header cell, not the folder name', async () => {
    const items = await runImport(STANDALONE);
    const visited = items.find((i) => i.metadata.Action === 'Visited Example')!;
    expect(visited.metadata.Product).toBe('Search');
    expect(visited.id).toBe('gactivity:Search:7');
    expect(items.some((i) => String(i.metadata.Product).includes('2026-07-24'))).toBe(false);
  });

  it('imports YouTube watches as youtube watch items with the channel', async () => {
    const items = await runImport(STANDALONE);
    const watches = items.filter((i) => i.classification === 'watch');
    expect(watches).toHaveLength(2);
    const lwt = watches.find((i) => String(i.metadata.Title).startsWith('UK & Makerfield'))!;
    expect(lwt.dataSource).toBe('youtube');
    expect(lwt.id).toMatch(/^youtube:[0-9a-f]{40}$/);
    expect(lwt.timestamp?.toISOString()).toBe('2026-06-19T02:30:56.000Z');
    expect(lwt.metadata).toMatchObject({
      URL: 'https://www.youtube.com/watch?v=RZL_TctrNco',
      Channel: 'LastWeekTonight',
      ChannelUrl: 'https://www.youtube.com/channel/UC3XTzVzaHQEd30rQbuvCtTQ',
      Source: 'YouTube',
    });
    // YouTube Music is YouTube activity too.
    expect(watches.find((i) => i.metadata.Title === 'Some Song')?.dataSource).toBe('youtube');
  });

  it('imports searches, likes and subscriptions under their own classifications', async () => {
    const items = await runImport(STANDALONE);
    const search = items.find((i) => i.classification === 'search')!;
    expect(search.dataSource).toBe('youtube');
    expect(search.metadata).toMatchObject({ Query: 'companion intelligence', Kind: 'search' });

    const like = items.find((i) => i.classification === 'like')!;
    expect(like.id).toMatch(/^youtube:like:[0-9a-f]{40}$/);
    expect(like.metadata).toMatchObject({
      Title: 'Pompeii: Out of Time - Official Trailer (2026)',
      Channel: 'IGN',
      Kind: 'like',
    });

    // Same id subscriptions.csv mints for this channel, so the two collapse.
    const sub = items.find((i) => i.classification === 'subscription')!;
    expect(sub.id).toBe('youtube:sub:UC6IxnFzHofFJ5X2PycSMsww');
    expect(sub.metadata).toMatchObject({ Channel: 'Some Channel', ChannelId: 'UC6IxnFzHofFJ5X2PycSMsww' });
  });

  it('keeps the generic handling for verbs the YouTube shape does not model', async () => {
    const items = await runImport(STANDALONE);
    const dismissed = items.find((i) => i.metadata.Action === 'Dismissed shelf')!;
    expect(dismissed.classification).toBe('page_view');
    expect(dismissed.dataSource).toBeUndefined();
    expect(dismissed.metadata.Product).toBe('YouTube');
    const viewed = items.find((i) => String(i.metadata.Action).startsWith('Viewed'))!;
    expect(viewed.classification).toBe('page_view');
    expect(viewed.dataSource).toBeUndefined();
  });

  it('lands a My Activity watch under the same id as the YouTube Takeout would', async () => {
    const items = await runImport(STANDALONE);
    const lwt = items.find((i) => String(i.metadata.Title).startsWith('UK & Makerfield'))!;
    // youtube.ts: sha1(`${url} ${ts.toISOString()}`)
    const crypto = await import('node:crypto');
    const expected = crypto
      .createHash('sha1')
      .update('https://www.youtube.com/watch?v=RZL_TctrNco 2026-06-19T02:30:56.000Z')
      .digest('hex');
    expect(lwt.id).toBe(`youtube:${expected}`);
  });

  it('applies the timeframe to YouTube entries without leaking them to page_view', async () => {
    const items = await runImport(STANDALONE, 'MyActivity.html', { since: new Date('2026-06-18T00:00:00Z') });
    expect(items.filter((i) => i.classification === 'watch')).toHaveLength(1);
    expect(items.filter((i) => i.classification === 'page_view')).toHaveLength(0);
  });
});

describe('body cell extraction survives a nested div', () => {
  // The exact failure mode googlevoice.ts hit on real MMS attachments: a
  // non-greedy `[\s\S]*?<\/div>` stops at the FIRST `</div>`, which here would
  // close the thumbnail wrapper and drop the real action text and timestamp
  // that follow it — some Takeout product types (Maps, Photos) wrap a
  // thumbnail/icon in its own div INSIDE the body cell.
  function writeFixture(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-import-tests-gma-'));
    const file = path.join(dir, 'MyActivity.html');
    fs.writeFileSync(
      file,
      '<html><body>' +
        '<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">' +
        '<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Maps<br></p></div>' +
        '<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">' +
        '<div class="thumbnail"><img src="thumb.png"></div>' +
        'Explored on Google Maps<br>Jun 18, 2026, 6:59:05 PM PDT<br>' +
        '</div>' +
        '<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1 mdl-typography--text-right"></div>' +
        '</div></div>' +
        '</body></html>',
      'utf8',
    );

    return file;
  }

  it('reads the action text and timestamp AFTER a nested div, not just up to its close', async () => {
    const items = await runImport(writeFixture());
    expect(items).toHaveLength(1);
    const [entry] = items;
    // Truncated-at-the-nested-close would leave Action empty/undefined and
    // the timestamp unparsed (no ts within the (empty) timeframe check).
    expect(entry.metadata?.Action).toContain('Explored on Google Maps');
    expect(entry.timestamp).toBeInstanceOf(Date);
    expect(entry.metadata?.Product).toBe('Maps');
  });
});
