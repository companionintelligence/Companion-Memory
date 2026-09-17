import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'path';

import { GoogleMapsPlacesFileImporter } from '../google_maps_places';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const DIR = path.join(__dirname, 'fixtures', 'google-maps-places', 'Maps (your places)');

function runDir(): Promise<EmittedGraph[]> {
  const fi = new GoogleMapsPlacesFileImporter();
  const pipeline: EmittedGraph[] = [];

  return fi
    .fileImport({}, { filename: 'Maps (your places)', fullPath: DIR }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams)
    .then(() => pipeline.filter((p) => p.item));
}

describe('Google Maps (your places) datasource', () => {
  it('recognizes the "Maps (your places)" directory', async () => {
    const fi = new GoogleMapsPlacesFileImporter();
    const rec = await fi.recognize({}, { filename: 'Maps (your places)', fullPath: DIR });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('recognizes a Saved Places.json file', async () => {
    const fi = new GoogleMapsPlacesFileImporter();
    const rec = await fi.recognize(
      {},
      {
        filename: 'Saved Places.json',
        fullPath: path.join(DIR, 'Saved Places.json'),
      },
    );
    expect(rec.confidence).toBeGreaterThan(0);
  });

  it('imports saved places and reviews', async () => {
    const items = (await runDir()).map((p) => p.item);
    expect(items.length).toBe(3);

    const places = items.filter((i) => i.classification === 'place');
    const reviews = items.filter((i) => i.classification === 'annotation');
    expect(places.length).toBe(2);
    expect(reviews.length).toBe(1);
  });

  it('maps a saved place with coordinates, title, address, and cid-based id', async () => {
    const items = (await runDir()).map((p) => p.item);
    const place = items.find((i) => i.metadata?.Name === 'St Germaine Apartments');
    expect(place).toBeDefined();
    expect(place!.classification).toBe('place');
    expect(place!.location?.latitude).toBeCloseTo(34.0556813, 5);
    expect(place!.location?.longitude).toBeCloseTo(-118.3062426, 5);
    expect(place!.metadata?.Title).toBe('St Germaine Apartments');
    expect(place!.metadata?.Address).toContain('900 S Serrano Ave');
    expect(place!.id).toBe('gmaps:place:2552432144292227829');
    expect(place!.timestamp?.toISOString()).toBe('2023-09-30T17:32:23.000Z');
  });

  it('treats the [0,0] placeholder coordinate as no location', async () => {
    const items = (await runDir()).map((p) => p.item);
    const noLoc = items.find((i) => i.metadata?.Comment);
    expect(noLoc).toBeDefined();
    expect(noLoc!.location).toBeUndefined();
    // Title falls back to the address, never the bare filename.
    expect(noLoc!.metadata?.Title).toContain('213 S 12th St');
  });

  it('maps a review with rating, text, place title, and a content-derived id', async () => {
    const items = (await runDir()).map((p) => p.item);
    const review = items.find((i) => i.classification === 'annotation');
    expect(review!.metadata?.Title).toBe('Laguna Niguel Smiles Dentistry');
    expect(review!.metadata?.Rating).toBe(5);
    expect(review!.metadata?.Text).toBe('Great staff and reasonably priced.');
    // SRC-06. This assertion used to pin `gmaps:review:0` — the PARSE INDEX.
    // `source_id` IS the destination's unique key, so an index-keyed id means
    // the identity of every review moves the moment Google emits one more (they
    // arrive newest-first), silently overwriting its neighbour's row on the next
    // import. Pin the SHAPE here; the stability properties are asserted below.
    expect(review!.id).toMatch(/^gmaps:review:[0-9a-f]{64}$/);
    expect(review!.location?.latitude).toBeCloseTo(33.5256569, 5);
    expect(review!.timestamp?.toISOString()).toBe('2025-01-20T21:49:34.812Z');
  });

  describe('identity is derived from content, not position (SRC-06)', () => {
    const review = (name: string, text: string, date: string) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-117.715302, 33.5256569] },
      properties: {
        date,
        five_star_rating_published: 5,
        google_maps_url: 'https://www.google.com/maps/place//data=!4m2!3m1!1s0x0:0xc7a6fa0ca15362b3',
        location: { address: `${name} address`, country_code: 'US', name },
        review_text_published: text,
      },
    });

    async function idsFor(features: unknown[], dirPrefix = 'gmaps-review-'): Promise<string[]> {
      const root = await fs.promises.mkdtemp(path.join(tmpdir(), dirPrefix));
      await fs.promises.writeFile(
        path.join(root, 'Reviews.json'),
        JSON.stringify({ type: 'FeatureCollection', features }),
      );
      const fi = new GoogleMapsPlacesFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: path.basename(root), fullPath: root }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      return pipeline.filter((p) => p.item).map((p) => p.item.id!);
    }

    const older = review('Old Cafe', 'Still good.', '2024-05-01T12:00:00.000Z');
    const newer = review('New Cafe', 'Just opened.', '2025-01-20T21:49:34.812983Z');
    const newest = review('Newest Cafe', 'Brand new.', '2025-06-01T09:00:00.000Z');

    it('keeps every pre-existing review’s id when a new one is PREPENDED', async () => {
      // Takeout writes reviews newest-first, so the next export prepends. Under
      // the index scheme every id below would shift by one.
      const before = await idsFor([newer, older]);
      const after = await idsFor([newest, newer, older]);

      expect(before).toHaveLength(2);
      expect(after).toHaveLength(3);
      expect(after.slice(1)).toEqual(before);
    });

    it('does not collide two different Reviews.json in one tree', async () => {
      // findSupportedFiles recurses to depth 6 and returns EVERY match, so two
      // Takeouts (or two accounts) in one inbox unit are walked in one run.
      // Under the index scheme both files restarted at 0 and the second file's
      // rows were swallowed by staged_items_run_source_hash_uniq's
      // ON CONFLICT DO NOTHING — counted as an ordinary duplicate, not a loss.
      const root = await fs.promises.mkdtemp(path.join(tmpdir(), 'gmaps-two-takeouts-'));
      for (const [dir, feat] of [
        ['account-a', newer],
        ['account-b', older],
      ] as const) {
        await fs.promises.mkdir(path.join(root, dir), { recursive: true });
        await fs.promises.writeFile(
          path.join(root, dir, 'Reviews.json'),
          JSON.stringify({ type: 'FeatureCollection', features: [feat] }),
        );
      }

      const fi = new GoogleMapsPlacesFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: path.basename(root), fullPath: root }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      const ids = pipeline.filter((p) => p.item).map((p) => p.item.id!);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    });

    it('gives the same review the same id from a different export path', async () => {
      const [a] = await idsFor([newer], 'gmaps-review-path-a-');
      const [b] = await idsFor([newer], 'gmaps-review-path-b-');

      expect(a).toBe(b);
    });

    it('still tells two reviews of the SAME place on the same day apart', async () => {
      // The key spans name+address+url+rating+text, so two reviews that differ
      // in anything a reader would notice stay two rows.
      const sameDay = '2025-03-03T08:00:00.000Z';
      const ids = await idsFor([
        review('One Place', 'First visit.', sameDay),
        review('One Place', 'Second visit.', sameDay),
      ]);

      expect(new Set(ids).size).toBe(2);
    });

    it('does not move a review id when only the raw date changes', async () => {
      // The date is deliberately NOT in the key. Takeout writes it at
      // microsecond precision and nothing downstream stores that string
      // (ci.content has no time column), so a key containing it could never be
      // re-keyed by a migration — see contentKey. The user-visible half of the
      // same decision: a review re-exported with a jittered date converges onto
      // the row it already has instead of minting a second one.
      const [a] = await idsFor([review('Same Cafe', 'Unchanged.', '2025-01-20T21:49:34.812983Z')]);
      const [b] = await idsFor([review('Same Cafe', 'Unchanged.', '2025-01-20T21:49:34.999999Z')]);

      expect(a).toBe(b);
    });

    it('tells two nameless, textless reviews apart by the place url', async () => {
      // Not hypothetical: three reviews in the reference corpus carry no name
      // and no address, and two of those also carry no text, leaving the star
      // rating as the only other field. The maps url is what they ARE — it
      // holds the place id (`…/data=!4m2!3m1!1s0x0:<hex>`) — so it is in the
      // key, and these two stay two rows.
      const bare = (hex: string) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-117.715302, 33.5256569] },
        properties: {
          date: '2024-08-08T08:08:08.888888Z',
          five_star_rating_published: 5,
          google_maps_url: `https://www.google.com/maps/place//data=!4m2!3m1!1s0x0:${hex}`,
        },
      });
      const ids = await idsFor([bare('0xb047c640ba792e36'), bare('0xed44b9d290ed51fa')]);

      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    });

    it('pins the exact digest both lanes must produce', async () => {
      // A golden value, because this key is a stored identity: changing it
      // re-homes every row already in ci.content / ci.events, and those rows do
      // NOT converge on their own (INGEST_REFRESH_COLUMNS is [] for both — DO
      // NOTHING, not DO UPDATE). If this test goes red, the change needs a
      // re-key migration alongside it, the way
      // 20260904023747_repair_google_maps_places_positional_ids accompanied the
      // move off the parse index. The values are sha256 over
      // U+001F-joined fields, and the migration recomputes them in SQL as
      // encode(sha256(convert_to(concat_ws(chr(31), …), 'UTF8')), 'hex').
      const [reviewId] = await idsFor([
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-118.3, 34.05] },
          properties: {
            date: '2025-01-20T21:49:34.812983Z',
            five_star_rating_published: 5,
            google_maps_url: 'https://maps.example/x',
            location: { address: '30131 Town Center Dr', name: 'Laguna Niguel Smiles Dentistry' },
            review_text_published: 'Great staff.',
          },
        },
      ]);

      expect(reviewId).toBe('gmaps:review:d33399e140ad86a780ab0fc035b1b6746868a7a2f3188fdb4e8bb3502f897289');
    });

    it('keys a cid-less saved place on its content too, not on the parse index', async () => {
      // Same defect on the place lane: `Saved Places.json` entries whose maps
      // url carries no ?cid= fell back to the index.
      const place = (name: string, lat: number, lon: number) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          date: '2024-02-02T10:00:00.000Z',
          google_maps_url: 'https://www.google.com/maps/search/?api=1&query=some+place',
          location: { address: `${name} address`, name },
        },
      });

      async function placeIds(features: unknown[]): Promise<string[]> {
        const root = await fs.promises.mkdtemp(path.join(tmpdir(), 'gmaps-place-'));
        await fs.promises.writeFile(
          path.join(root, 'Saved Places.json'),
          JSON.stringify({ type: 'FeatureCollection', features }),
        );
        const fi = new GoogleMapsPlacesFileImporter();
        const pipeline: EmittedGraph[] = [];
        await fi.fileImport({}, { filename: path.basename(root), fullPath: root }, {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams);

        return pipeline.filter((p) => p.item).map((p) => p.item.id!);
      }

      const first = place('Alpha Bakery', 34.05, -118.3);
      const second = place('Beta Diner', 34.06, -118.31);

      const before = await placeIds([second, first]);
      const after = await placeIds([place('Gamma Bar', 34.07, -118.32), second, first]);

      expect(before.every((id) => /^gmaps:place:[0-9a-f]{64}$/.test(id))).toBe(true);
      expect(after.slice(1)).toEqual(before);
    });
  });

  it('gives every item a truthy, distinct id and a parseable timestamp', async () => {
    const items = (await runDir()).map((p) => p.item);
    const ids = items.map((i) => i.id!);
    expect(ids.every((id) => !!id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of items) {
      expect(i.timestamp).toBeInstanceOf(Date);
      expect(isNaN(i.timestamp!.getTime())).toBe(false);
    }
  });

  it('produces the same ids on re-import (idempotent)', async () => {
    const a = (await runDir()).map((p) => p.item.id!).sort();
    const b = (await runDir()).map((p) => p.item.id!).sort();
    expect(b).toEqual(a);
  });

  it('recurses into the current Takeout My labeled places layout', async () => {
    const root = await fs.promises.mkdtemp(path.join(tmpdir(), 'google-maps-current-'));
    const nested = path.join(root, 'My labeled places');
    await fs.promises.mkdir(nested, { recursive: true });
    await fs.promises.writeFile(
      path.join(nested, 'Labeled places.json'),
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-118.5, 34.2] },
            properties: { name: 'Home', address: 'Example address' },
          },
        ],
      }),
    );

    const importer = new GoogleMapsPlacesFileImporter();
    const rec = await importer.recognize({}, { filename: root, fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0);
    const pipeline: EmittedGraph[] = [];
    await importer.fileImport({}, { filename: root, fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    expect(pipeline).toHaveLength(1);
    expect(pipeline[0].item.metadata).toMatchObject({
      Title: 'Home',
      Address: 'Example address',
      Kind: 'labeled_place',
    });
    expect(pipeline[0].item.location).toEqual({ latitude: 34.2, longitude: -118.5 });
    // The place lane's golden value — see 'pins the exact digest both lanes
    // must produce' for why this is pinned rather than shape-matched. Key is
    // name + address + url ('' here: Labeled places.json carries no url) +
    // lat/lon at toFixed(7).
    expect(pipeline[0].item.id).toBe(
      'gmaps:place:987bab959a5968dc3816f67d1f999e532f4031ee477c2ac99e8789162e4044a9',
    );
  });

  it('keeps two otherwise identical pins apart by coordinates', async () => {
    // Coordinates are in the place key at fixed 7dp (~1cm) rather than at JS's
    // default float rendering, so that Postgres can reproduce the same string
    // — to_char(round(x::numeric, 7), 'FM9990.0000000') — and re-key these rows
    // if the key ever moves again. Fixed precision must still discriminate.
    const root = await fs.promises.mkdtemp(path.join(tmpdir(), 'google-maps-coords-'));
    await fs.promises.writeFile(
      path.join(root, 'Labeled places.json'),
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-118.5, 34.2] },
            properties: { name: 'Parking', address: 'Level 3' },
          },
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-118.5000001, 34.2] },
            properties: { name: 'Parking', address: 'Level 3' },
          },
        ],
      }),
    );

    const importer = new GoogleMapsPlacesFileImporter();
    const pipeline: EmittedGraph[] = [];
    await importer.fileImport({}, { filename: root, fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const ids = pipeline.filter((p) => p.item).map((p) => p.item.id!);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
