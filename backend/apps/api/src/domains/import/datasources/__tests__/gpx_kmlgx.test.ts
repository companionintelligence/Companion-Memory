import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GPXFileImporter } from '../gpx';
import { KMLGXFileImporter } from '../kmlgx';
import type { DirEntry } from '../registry';
import type { ImportParams, Graph } from '../timeline';

import type { EmittedGraph } from './support/emitted';

// minimal mock pipeline
function makeParams(): { params: ImportParams; collected: EmittedGraph[] } {
  const collected: EmittedGraph[] = [];
  const params: ImportParams = {
    pipeline: { push: (g: Graph) => collected.push(g as EmittedGraph) },
    timeframe: undefined,
  };

  return { params, collected };
}

describe('GPX & KMLGX datasources', () => {
  it('recognizes and imports a simple GPX file', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gpx-'));
    const gpxPath = path.join(tmp, 'track.gpx');
    const gpxContent = `<?xml version="1.0"?><gpx><trk><trkseg><trkpt lat="12.34" lon="56.78"><time>2024-01-02T03:04:05Z</time><ele>10.5</ele></trkpt></trkseg></trk></gpx>`;
    fs.writeFileSync(gpxPath, gpxContent, 'utf8');
    const fileImporter = new GPXFileImporter();
    const rec = await fileImporter.recognize(undefined, { fullPath: gpxPath } as DirEntry);
    expect(rec.confidence).toBeGreaterThan(0.5);
    const { params, collected } = makeParams();
    await fileImporter.fileImport(undefined, { fullPath: gpxPath } as DirEntry, params);
    expect(collected.length).toBe(1);
    const item = collected[0].item;
    expect(item.location!.latitude).toBeCloseTo(12.34);
    expect(item.metadata.Source).toBe('GPX');
  });

  it('recognizes and imports a simple KML file with gx:Track', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-kml-'));
    const kmlPath = path.join(tmp, 'track.kml');
    const kmlContent = `<?xml version="1.0"?><kml gx="http://www.google.com/kml/ext/2.2"><Document><Placemark><Track><when>2024-01-02T03:04:05Z</when><coord>56.78 12.34 15.0</coord></Track></Placemark></Document></kml>`;
    fs.writeFileSync(kmlPath, kmlContent, 'utf8');
    const fileImporter = new KMLGXFileImporter();
    const rec = await fileImporter.recognize(undefined, { fullPath: kmlPath } as DirEntry);
    expect(rec.confidence).toBeGreaterThan(0.5);
    const { params, collected } = makeParams();
    await fileImporter.fileImport(undefined, { fullPath: kmlPath } as DirEntry, params);
    expect(collected.length).toBe(1);
    const item = collected[0].item;
    expect(item.location!.longitude).toBeCloseTo(56.78);
    expect(item.metadata.Source).toBe('KMLGX');
    expect(item.metadata.Altitude).toBe(15.0);
    // No fabricated `Name`. A gx:Track coord carries no name, and the
    // `Location 12.34000,56.78000` this used to emit was never rendered as a
    // title (raw-GPS location.fix routes to `position` only) — it only ever
    // landed in ci.position.name. A null name is what makes the row a
    // reverse-geocode candidate.
    expect(item.metadata.Name).toBeUndefined();
    expect(item.metadata.Title).toBeUndefined();
  });

  it('KMLGX: malformed XML does not throw and emits nothing', async () => {
    // processKML() catches parse exceptions and logs+returns silently
    // (kmlgx.ts ~L108-116); this is the only test in the file that isn't the
    // single happy path, so a regression in xml2js's namespace-stripping
    // config or an unparseable real-world export would otherwise go unnoticed.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-kml-bad-'));
    const kmlPath = path.join(tmp, 'broken.kml');
    fs.writeFileSync(kmlPath, '<kml><Document><Placemark><Track>not valid xml <<< &', 'utf8');
    const fileImporter = new KMLGXFileImporter();

    const rec = await fileImporter.recognize(undefined, { fullPath: kmlPath } as DirEntry);
    expect(rec.confidence).toBe(0);

    const log = jest.fn();
    const { params, collected } = makeParams();
    params.log = log;
    await expect(
      fileImporter.fileImport(undefined, { fullPath: kmlPath } as DirEntry, params),
    ).resolves.toBeUndefined();
    expect(collected.length).toBe(0);
    expect(log).toHaveBeenCalledWith('error', 'Failed to parse KML file', expect.any(Object));
  });

  it('KMLGX: a track whose <when>/<coord> counts mismatch is skipped with a warning, not thrown', async () => {
    // Two <when> entries but only one <coord> — processKML() must warn and
    // `continue` past this track (kmlgx.ts ~L123-126) rather than reading out
    // of bounds or throwing. A well-formed second Placemark with a balanced
    // track proves the mismatched track is the only one dropped.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-kml-mismatch-'));
    const kmlPath = path.join(tmp, 'mismatch.kml');
    const kmlContent = [
      '<?xml version="1.0"?>',
      '<kml gx="http://www.google.com/kml/ext/2.2"><Document>',
      '<Placemark><Track>',
      '<when>2024-01-02T03:04:05Z</when>',
      '<when>2024-01-02T03:05:05Z</when>',
      '<coord>56.78 12.34 15.0</coord>',
      '</Track></Placemark>',
      '<Placemark><Track>',
      '<when>2024-01-02T04:00:00Z</when>',
      '<coord>10.0 20.0 5.0</coord>',
      '</Track></Placemark>',
      '</Document></kml>',
    ].join('');
    fs.writeFileSync(kmlPath, kmlContent, 'utf8');
    const fileImporter = new KMLGXFileImporter();

    const log = jest.fn();
    const { params, collected } = makeParams();
    params.log = log;
    await expect(
      fileImporter.fileImport(undefined, { fullPath: kmlPath } as DirEntry, params),
    ).resolves.toBeUndefined();

    // Only the balanced second track's single point survives.
    expect(collected.length).toBe(1);
    expect(collected[0].item.location!.latitude).toBeCloseTo(20.0);
    expect(log).toHaveBeenCalledWith('warn', 'Track timestamp/coord count mismatch', expect.any(Object));
  });

  describe('KMLGX: tracks outside Document > Placemark', () => {
    // The prefixed, namespaced form real files use: `xmlns:gx` and `<gx:Track>`.
    const track = (start: string, coords: string[]) =>
      [
        '<gx:Track>',
        '<altitudeMode>absolute</altitudeMode>',
        ...coords.map((_, i) => `<when>${new Date(Date.parse(start) + i * 30_000).toISOString()}</when>`),
        ...coords.map((c) => `<gx:coord>${c}</gx:coord>`),
        '</gx:Track>',
      ].join('\n');
    const kml = (body: string) =>
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">',
        body,
        '</kml>',
      ].join('\n');

    async function importKML(content: string): Promise<EmittedGraph[]> {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-kml-nested-'));
      const kmlPath = path.join(tmp, 'tracks.kml');
      fs.writeFileSync(kmlPath, content, 'utf8');
      const fileImporter = new KMLGXFileImporter();
      expect((await fileImporter.recognize(undefined, { fullPath: kmlPath } as DirEntry)).confidence).toBe(1);
      const { params, collected } = makeParams();
      await fileImporter.fileImport(undefined, { fullPath: kmlPath } as DirEntry, params);
      fs.rmSync(tmp, { recursive: true, force: true });

      return collected;
    }

    const times = (collected: EmittedGraph[]) => collected.map((g) => g.item.timestamp?.toISOString()).sort();

    it('reads a gx:MultiTrack inside a Placemark inside a Folder', async () => {
      const collected = await importKML(
        kml(
          [
            '<Document>',
            '<Placemark><name>Ride</name>',
            track('2026-08-14T15:30:00Z', ['-122.4783 37.8199 67', '-122.479 37.823 70']),
            '</Placemark>',
            '<Folder><name>Ferry building</name>',
            '<Placemark><name>Ferry walk</name>',
            '<gx:MultiTrack><altitudeMode>clampToGround</altitudeMode><gx:interpolate>1</gx:interpolate>',
            track('2026-08-15T18:05:00Z', ['-122.3937 37.7955 4', '-122.3941 37.7949 4']),
            track('2026-08-15T18:10:00Z', ['-122.3946 37.7943 5']),
            '</gx:MultiTrack>',
            '</Placemark>',
            '</Folder>',
            '</Document>',
          ].join('\n'),
        ),
      );

      expect(times(collected)).toEqual([
        '2026-08-14T15:30:00.000Z',
        '2026-08-14T15:30:30.000Z',
        '2026-08-15T18:05:00.000Z',
        '2026-08-15T18:05:30.000Z',
        '2026-08-15T18:10:00.000Z',
      ]);
      const ferry = collected.find((g) => g.item.timestamp?.toISOString() === '2026-08-15T18:05:30.000Z');
      expect(ferry?.item.location?.latitude).toBeCloseTo(37.7949, 6);
      expect(ferry?.item.metadata.Altitude).toBe(4);
    });

    it('reads tracks in nested Folders, a Placemark at the root and a MultiGeometry', async () => {
      const collected = await importKML(
        kml(
          [
            '<Document>',
            '<Folder><Folder><Placemark>',
            track('2026-08-16T08:00:00Z', ['-122.40 37.79 1']),
            '</Placemark></Folder></Folder>',
            '<Folder/>',
            '<Placemark><MultiGeometry>',
            track('2026-08-16T09:00:00Z', ['-122.41 37.78 2']),
            '</MultiGeometry></Placemark>',
            '</Document>',
            '<Placemark>',
            track('2026-08-16T10:00:00Z', ['-122.42 37.77 3']),
            '</Placemark>',
          ].join('\n'),
        ),
      );

      expect(times(collected)).toEqual([
        '2026-08-16T08:00:00.000Z',
        '2026-08-16T09:00:00.000Z',
        '2026-08-16T10:00:00.000Z',
      ]);
    });
  });
});
