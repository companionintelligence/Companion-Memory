import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppleContactsFileImporter } from '../applecontacts';
import { GeoJSONFileImporter } from '../geojson';
import type { DirEntry } from '../registry';
import type { Graph, ImportParams } from '../timeline';
import { VCardFileImporter } from '../vcard';

import type { EmittedGraph } from './support/emitted';

function makeParams() {
  const collected: EmittedGraph[] = [];

  return { params: { pipeline: { push: (g: Graph) => collected.push(g as EmittedGraph) } }, collected };
}

describe('New datasources: geojson, vcard, applecontacts', () => {
  it('imports simple GeoJSON Point', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-geojson-'));
    const file = path.join(tmp, 'pts.geojson');
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [10, 20] },
            properties: { time: '2024-01-02T03:04:05Z', label: 'A' },
          },
        ],
      }),
      'utf8',
    );
    const imp = new GeoJSONFileImporter();
    const rec = await imp.recognize(undefined, { fullPath: file } as DirEntry);
    expect(rec.confidence).toBeGreaterThan(0.5);
    const { params, collected } = makeParams();
    await imp.fileImport(undefined, { fullPath: file } as DirEntry, params as unknown as ImportParams);
    expect(collected.length).toBe(1);
    expect(collected[0].item.location!.latitude).toBe(20);
    expect(collected[0].item.metadata.label).toBe('A');
  });

  it('imports simple vCard file', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-vcard-'));
    const file = path.join(tmp, 'contact.vcf');
    fs.writeFileSync(
      file,
      'BEGIN:VCARD\nFN:Jane Doe\nTEL:+1234567\nEMAIL:jane@example.com\nEND:VCARD\n',
      'utf8',
    );
    const imp = new VCardFileImporter();
    const rec = await imp.recognize(undefined, { fullPath: file } as DirEntry);
    expect(rec.confidence).toBeGreaterThan(0.7);
    const { params, collected } = makeParams();
    await imp.fileImport(undefined, { fullPath: file } as DirEntry, params as unknown as ImportParams);
    expect(collected.length).toBe(1);
    // A contact is an ITEM carrying a `contact` edge to its entity — the item is
    // what gives the card a stable id to dedup a re-import against. Asserting a
    // bare entity was asserting the shape that made contacts import as zero
    // items.
    expect(collected[0].item).toBeDefined();
    expect(collected[0].edges![0].relation).toBe('contact');
    expect(collected[0].edges![0].to!.entity!.name).toBe('Jane Doe');
  });

  it('recognizes Apple Contacts DB (simulated empty)', async () => {
    // The OS temp dir, not process.cwd(): this ran from `backend/` in the
    // standalone importer and left its scratch dirs there — hundreds of them
    // accumulated in that repo. Cleaned up here so a test run leaves no trace.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-applecontacts-'));
    try {
      const dbPath = path.join(tmp, 'AddressBook-v22.abcddb');
      fs.writeFileSync(dbPath, 'SQLite format 3\0', 'utf8'); // fake header just for existence
      const imp = new AppleContactsFileImporter();
      const rec = await imp.recognize(undefined, { fullPath: dbPath } as DirEntry);
      expect(rec.confidence).toBeGreaterThan(0.5);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
