import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DirEntry } from '../registry';
import { allDataSources, dataSourcesRecognize } from '../registry';
// Pull in the barrel — the server uses the same path. If a new importer is
// added but not wired into the barrel, this test catches it.
import '../index';

// Sources that ship as registered TypeScript importers. Keep this list in sync
// with backend/src/datasources/index.ts.
const EXPECTED_DATASOURCES = [
  'apple_photos',
  'apple_contacts',
  'apple_health',
  'calendar',
  'chatgpt',
  'chromium',
  'claude',
  'contact_list',
  'discord',
  'disney_plus',
  'email',
  'facebook',
  'firefox',
  'flighty',
  'gemini',
  'generic',
  'geojson',
  'github',
  'gmail',
  'google_location',
  'google_photos',
  'google_voice',
  'gpx',
  'hulu',
  'imessage',
  'instagram',
  'kindle',
  'kmlgx',
  'linkedin',
  'microsoft_account',
  'netflix',
  'nmea',
  'reddit',
  'roblox',
  'sms_backup_restore',
  'spotify',
  'strava',
  'telegram',
  'tiktok',
  'twitter',
  'vcard',
  'whatsapp',
  'youtube',
  // Added imports — financial/reading/travel (prior batch)
  'coinbase',
  'goodreads',
  'last_fm',
  'letterboxd',
  'paypal',
  'uber',
  // Added imports — music/social/wearable/finance/productivity (stub fill-in batch)
  'amazon',
  'apple_music',
  'evernote',
  'fitbit',
  'garmin',
  'grok',
  'lyft',
  'mastodon',
  'myfitnesspal',
  'notion',
  'oura',
  'snapchat',
  'venmo',
  'withings',
];

describe('datasource registration', () => {
  it('registers every shipped importer', () => {
    const names = allDataSources().map((d) => d.name);
    for (const expected of EXPECTED_DATASOURCES) {
      expect(names).toContain(expected);
    }
  });

  it('every registered importer has a non-empty title and description', () => {
    for (const ds of allDataSources()) {
      expect(ds.title.length).toBeGreaterThan(0);
      expect(ds.description.length).toBeGreaterThan(0);
    }
  });

  it('recognition results are sorted descending by confidence', async () => {
    // Build a tiny .gpx file — gpx, generic, and possibly others recognize it
    // at different confidence levels. The test only cares that the returned
    // ordering is highest-first.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-reco-'));
    const file = path.join(dir, 'sample.gpx');
    fs.writeFileSync(
      file,
      '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="0"/></trkseg></trk></gpx>',
    );
    try {
      const entry: DirEntry = { filename: 'sample.gpx', fsRoot: dir, fullPath: file };
      const results = await dataSourcesRecognize({}, entry, {});
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].recognition.confidence).toBeGreaterThanOrEqual(
          results[i].recognition.confidence,
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT descend by default: a folder holding a loose .gpx matches nothing specific', async () => {
    // This is the pre-fix behavior, preserved for the cheap CLI/MCP path: when
    // the dropped path is a *folder* and we don't descend, a single-file
    // importer like gpx can't see the file inside.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-reco-'));
    fs.writeFileSync(path.join(dir, 'walk.gpx'), '<gpx version="1.1"><trk><trkseg/></trk></gpx>');
    try {
      const entry: DirEntry = { filename: path.basename(dir), fsRoot: path.dirname(dir), fullPath: dir };
      const results = await dataSourcesRecognize({}, entry, {});
      expect(results.find((r) => r.data_source.name === 'gpx')).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('descends into a dropped folder and attributes the match to the file path', async () => {
    // The drag-and-drop case: a loose .gpx is staged inside a folder. With
    // descent on, recognition finds gpx and points the import at the file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-reco-'));
    const nested = path.join(dir, 'sub');
    fs.mkdirSync(nested);
    const file = path.join(nested, 'walk.gpx');
    fs.writeFileSync(
      file,
      '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>',
    );
    try {
      const entry: DirEntry = { filename: path.basename(dir), fsRoot: path.dirname(dir), fullPath: dir };
      const results = await dataSourcesRecognize({}, entry, {}, { descend: true });
      const gpx = results.find((r) => r.data_source.name === 'gpx');
      expect(gpx).toBeTruthy();
      expect(gpx!.recognition.confidence).toBeGreaterThan(0);
      // The match points at the actual .gpx file (or its folder), not the
      // queried root — so the import runs where the data really is.
      expect(gpx!.matchedPath).toBeTruthy();
      expect(gpx!.matchedPath).not.toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('attributes AI-assistant export dirs to the right vendor with ALL importers registered', async () => {
    // The unit tests exercise chatgpt/claude/gemini in isolation; this runs the
    // real registry so a new importer weakly claiming memories.json (or the
    // conversations.json collision regressing) shows up here.
    const fixtures = path.join(__dirname, 'fixtures');
    const cases: Array<{ fixture: string; winner: string; loser?: string }> = [
      { fixture: 'chatgpt-export', winner: 'chatgpt', loser: 'claude' },
      { fixture: 'claude-export', winner: 'claude', loser: 'chatgpt' },
      { fixture: 'chatgpt-memory-export', winner: 'chatgpt', loser: 'claude' },
      { fixture: 'claude-memory-export', winner: 'claude', loser: 'chatgpt' },
      { fixture: 'gemini-takeout-memory', winner: 'gemini' },
    ];
    for (const c of cases) {
      const dir = path.join(fixtures, c.fixture);
      const entry: DirEntry = { filename: c.fixture, fsRoot: fixtures, fullPath: dir };
      const results = await dataSourcesRecognize({}, entry, {});
      // The fixture name rides along in the asserted value: this loop runs every
      // case inside one test, so without it a failure names no fixture.
      expect({ fixture: c.fixture, topHit: results[0]?.data_source.name }).toEqual({
        fixture: c.fixture,
        topHit: c.winner,
      });
      if (c.loser) {
        expect({
          fixture: c.fixture,
          claimedBy: results.find((r) => r.data_source.name === c.loser)?.data_source.name,
        }).toEqual({ fixture: c.fixture, claimedBy: undefined });
      }
    }
  });

  it('descends to a memories.json staged inside a wrapper folder', async () => {
    // Drag-and-drop: upload extraction stages the export inside a folder named
    // after the archive. Descent must still find and attribute the memory file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-reco-mem-'));
    const nested = path.join(dir, 'chatgpt-export-2026');
    fs.mkdirSync(nested);
    fs.writeFileSync(
      path.join(nested, 'memories.json'),
      JSON.stringify({ memories: [{ id: 'm1', content: 'likes tea', created_at: 1740787200 }] }),
    );
    try {
      const entry: DirEntry = { filename: path.basename(dir), fsRoot: path.dirname(dir), fullPath: dir };
      const results = await dataSourcesRecognize({}, entry, {}, { descend: true });
      const hit = results.find((r) => r.data_source.name === 'chatgpt');
      expect(hit).toBeTruthy();
      expect(results.find((r) => r.data_source.name === 'claude')).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('descent respects the depth bound', async () => {
    // A .gpx buried deeper than maxDepth should not be found, proving the bound
    // is real (and that a giant tree can't trigger an unbounded crawl).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-reco-'));
    const deep = path.join(dir, 'a', 'b', 'c', 'd');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'walk.gpx'), '<gpx version="1.1"><trk><trkseg/></trk></gpx>');
    try {
      const entry: DirEntry = { filename: path.basename(dir), fsRoot: path.dirname(dir), fullPath: dir };
      const results = await dataSourcesRecognize({}, entry, {}, { descend: true, maxDepth: 2 });
      expect(results.find((r) => r.data_source.name === 'gpx')).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
