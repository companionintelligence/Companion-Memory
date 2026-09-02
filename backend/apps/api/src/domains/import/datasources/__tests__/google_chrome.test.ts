import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { allDataSources } from '../registry';
import type { DirEntry } from '../registry';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

import '../google_chrome';

function importer() {
  const ds = allDataSources().find((d) => d.name === 'google_chrome');
  if (!ds?.newFileImporter) {
    throw new Error('google_chrome not registered');
  }

  return ds.newFileImporter();
}

/** A Takeout "Chrome/" folder with a History.json and a Bookmarks.html. */
async function chromeExport(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'gchrome-'));
  const chrome = path.join(dir, 'Chrome');
  await fs.promises.mkdir(chrome, { recursive: true });
  // 2026-06-10T12:00:00.000Z and 2026-06-09T12:00:00.000Z in microseconds.
  await fs.promises.writeFile(
    path.join(chrome, 'History.json'),
    JSON.stringify({
      'Browser History': [
        {
          url: 'https://example.com/a',
          title: 'Page A',
          time_usec: Date.UTC(2026, 5, 10, 12, 0, 0) * 1000,
          page_transition_qualifier: 'LINK',
        },
        {
          url: 'https://example.com/b',
          title: 'Page B',
          time_usec: Date.UTC(2026, 5, 9, 12, 0, 0) * 1000,
        },
      ],
    }),
  );
  await fs.promises.writeFile(
    path.join(chrome, 'Bookmarks.html'),
    `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
       <DT><H3>Bar</H3>
       <DL><p><DT><A HREF="https://example.org/x" ADD_DATE="1749556800">Example X</A></DL><p>
     </DL>`,
  );

  return dir;
}

async function runImport(root: string, timeframe: Record<string, unknown> = {}) {
  const pipeline: EmittedGraph[] = [];
  await importer().fileImport(
    {},
    { filename: path.basename(root), fullPath: root } as DirEntry,
    {
      pipeline,
      timeframe,
      log: () => {},
    } as unknown as ImportParams,
  );

  return pipeline.map((g) => g.item);
}

describe('google_chrome (Takeout export)', () => {
  it('recognizes a History.json file with high confidence', async () => {
    const dir = await chromeExport();
    const rec = await importer().recognize(
      {},
      {
        filename: 'History.json',
        fullPath: path.join(dir, 'Chrome', 'History.json'),
      } as DirEntry,
      {},
    );
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('recognizes a Chrome directory (walks for the export files)', async () => {
    const dir = await chromeExport();
    const rec = await importer().recognize(
      {},
      {
        filename: 'Chrome',
        fullPath: path.join(dir, 'Chrome'),
      } as DirEntry,
      {},
    );
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('imports Browser History as page_view items with a host-independent timestamp', async () => {
    const items = await runImport(await chromeExport());
    const visits = items.filter((i) => i.classification === 'page_view');
    expect(visits.length).toBe(2);
    const a = visits.find((i) => i.metadata.URL === 'https://example.com/a');
    expect(a).toBeTruthy();
    expect(a!.metadata.Title).toBe('Page A');
    // time_usec (microseconds) → the same absolute instant.
    expect(a!.timestamp!.toISOString()).toBe('2026-06-10T12:00:00.000Z');
    // Distinct visits keep distinct ids.
    expect(new Set(visits.map((i) => i.id!)).size).toBe(2);
    // The cross-producer contract (identity/browser.ts): `visit:<unix ms>:<url>`
    // is what chromium.ts mints from the profile's History SQLite and what the
    // browser extension sends live, so all three arrivals of this visit are
    // one ci.browser_activity row.
    expect(a!.id).toBe(`visit:${Date.UTC(2026, 5, 10, 12, 0, 0)}:https://example.com/a`);
    // Takeout is Chrome Sync: the brand is known and rides in the properties
    // bag under the key the extension uses, off the identity.
    expect(a!.metadata.browser).toBe('chrome');
  });

  it('imports Bookmarks.html as bookmark items', async () => {
    const items = await runImport(await chromeExport());
    const bookmarks = items.filter((i) => i.classification === 'bookmark');
    expect(bookmarks.length).toBe(1);
    expect(bookmarks[0].metadata.URL).toBe('https://example.org/x');
  });

  it('honors the timeframe filter (drops the older visit)', async () => {
    const items = await runImport(await chromeExport(), { since: new Date('2026-06-10T00:00:00Z') });
    const visits = items.filter((i) => i.classification === 'page_view');
    expect(visits.length).toBe(1);
    expect(visits[0].metadata.URL).toBe('https://example.com/a');
  });
});
