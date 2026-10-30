import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CatalogSource } from '../useImportApi';

import { BUNDLES } from './bundles.fixture';
import {
  ECOSYSTEM_LABELS,
  PICKER_SECTIONS,
  SERVICE_LOGO,
  bundleLogoUrl,
  bundleToGuide,
  exportEntries,
  mergeObjects,
  objectsFor,
  pickableSections,
  shortTitle,
} from './sources';

/**
 * The wizard's presentation glue, held to what it promises:
 *
 *  - every logo the map names is a file that actually ships — a broken image
 *    on a service button is the most prominent way this page can look wrong;
 *  - the groupings are internally coherent, so a section can always label and
 *    glyph itself;
 *  - the pure derivations behind the picker and the export sequence do what
 *    their comments say (bundle collapses members, ready-then-A→Z ordering,
 *    unknown ecosystems still surface).
 */

const LOGO_DIR = path.resolve(__dirname, '../../../../public/import-logos');

function source(overrides: Partial<CatalogSource> & { id: string }): CatalogSource {
  return {
    title: overrides.id,
    blurb: '',
    ecosystem: 'misc',
    category: 'misc',
    acquisition: 'web-export',
    wait: 'minutes',
    steps: [],
    importer: overrides.id,
    importerReady: true,
    ...overrides,
  };
}

describe('SERVICE_LOGO', () => {
  it('names only files that ship in public/import-logos', () => {
    const missing = Object.entries(SERVICE_LOGO)
      .filter(([, file]) => !existsSync(path.join(LOGO_DIR, file)))
      .map(([id, file]) => `${id} → ${file}`);

    expect(missing).toEqual([]);
  });

  it('every bundle logo ships too', () => {
    // The bundles themselves are authored in the backend (sources/bundles.ts);
    // their ids are what the logo is resolved from, so these must track them.
    for (const bundle of BUNDLES) {
      const file = bundleLogoUrl(bundle).replace('/import-logos/', '');

      expect(existsSync(path.join(LOGO_DIR, file)), `${bundle.id} → ${file}`).toBe(true);
    }
  });
});

describe('the groupings', () => {
  it('every picker section can label its ecosystems', () => {
    for (const section of PICKER_SECTIONS) {
      for (const eco of section.ecosystems) {
        expect(ECOSYSTEM_LABELS[eco], `label for ${eco}`).toBeDefined();
      }
    }
  });

  it('no ecosystem appears in two sections', () => {
    const seen = new Set<string>();

    for (const section of PICKER_SECTIONS) {
      for (const eco of section.ecosystems) {
        expect(seen.has(eco), `${eco} claimed twice`).toBe(false);
        seen.add(eco);
      }
    }
  });
});

describe('shortTitle', () => {
  it('drops the parenthetical', () => {
    expect(shortTitle('Gmail (Google Takeout)')).toBe('Gmail');
    expect(shortTitle('Spotify')).toBe('Spotify');
  });
});

describe('pickableSections', () => {
  const catalog = [
    source({ id: 'gmail', title: 'Gmail (Google Takeout)', ecosystem: 'google' }),
    source({ id: 'google_photos', title: 'Google Photos', ecosystem: 'google' }),
    source({ id: 'spotify', title: 'Spotify', ecosystem: 'music' }),
    source({ id: 'deezer', title: 'Deezer', ecosystem: 'music', importerReady: false }),
    source({ id: 'whatsapp', title: 'WhatsApp', ecosystem: 'meta' }),
    source({ id: 'facebook', title: 'Facebook', ecosystem: 'meta' }),
  ];

  it('collapses bundle members into the bundle button', () => {
    const sections = pickableSections(catalog, BUNDLES);
    const google = sections.find((section) => section.key === 'google');

    // gmail and google_photos are Takeout members: one bundle button, no
    // per-service buttons for them.
    expect(google?.items.map((item) => item.key)).toEqual(['b:google']);
  });

  it('keeps a service NOT covered by its ecosystem’s bundle as its own button', () => {
    const sections = pickableSections(catalog, BUNDLES);
    const social = sections.find((section) => section.key === 'social');

    // WhatsApp exports separately from the Meta bundle.
    expect(social?.items.map((item) => item.key)).toEqual(['b:meta', 'whatsapp']);
  });

  it('sorts ready importers A→Z, then coming-soon ones A→Z after them', () => {
    const withPandora = [
      ...catalog,
      source({ id: 'pandora', title: 'Pandora', ecosystem: 'music', importerReady: false }),
      source({ id: 'last_fm', title: 'Last.fm', ecosystem: 'music' }),
    ];
    const sections = pickableSections(withPandora, BUNDLES);
    const music = sections.find((section) => section.key === 'music');

    // Alphabetical is predictable to scan, but a tile that can import today
    // still outranks a "coming soon" one: Last.fm → Spotify, then Deezer →
    // Pandora.
    expect(music?.items.map((item) => item.key)).toEqual(['last_fm', 'spotify', 'deezer', 'pandora']);
    expect(music?.items.map((item) => item.ready)).toEqual([true, true, false, false]);
  });

  it("names the bundle's members on its tile", () => {
    const sections = pickableSections(catalog, BUNDLES);
    const google = sections.find((section) => section.key === 'google');

    // The tile must say what the one download stands for, by display name —
    // someone scanning for "Gmail" finds it under the Google brand.
    expect(google?.items[0].memberNames).toEqual(['Gmail', 'Google Photos']);
  });

  it('shows a STANDALONE member as its own button, still covered by the bundle', () => {
    const withInstagram = [...catalog, source({ id: 'instagram', title: 'Instagram', ecosystem: 'meta' })];
    const sections = pickableSections(withInstagram, BUNDLES);
    const social = sections.find((section) => section.key === 'social');
    const meta = social?.items.find((item) => item.key === 'b:meta');

    // Instagram is scannable by its own name AND stays a Meta member, so the
    // bundle keeps declaring (and crediting) it. Alphabetical, like the rest.
    expect(social?.items.map((item) => item.key)).toEqual(['instagram', 'b:meta', 'whatsapp']);
    expect(meta?.importers).toContain('instagram');
    expect(meta?.memberNames).toContain('Instagram');
  });

  it('gives an ecosystem no section claims its own group', () => {
    const sections = pickableSections(
      [source({ id: 'novel_service', title: 'Novel', ecosystem: 'brand-new-ecosystem' })],
      BUNDLES,
    );

    expect(sections.map((section) => section.key)).toContain('brand-new-ecosystem');
  });
});

/**
 * Amazon is one Privacy Central flow feeding five importers, modelled as five
 * catalog sources under one bundle. The tile's chips are the full member
 * union — there is no cap; a tile with more than four kinds wraps into a
 * second column instead of dropping the ones that sort last.
 */
describe('the Amazon bundle', () => {
  const amazonCatalog = [
    source({ id: 'amazon', title: 'Amazon orders', ecosystem: 'amazon', category: 'finance' }),
    source({ id: 'prime_video', title: 'Prime Video', ecosystem: 'amazon', category: 'video' }),
    source({ id: 'audible', title: 'Audible', ecosystem: 'amazon', category: 'audio' }),
    source({ id: 'kindle_reading', title: 'Kindle reading', ecosystem: 'amazon', category: 'reading' }),
    source({ id: 'amazon_music', title: 'Amazon Music', ecosystem: 'amazon', category: 'audio' }),
  ];

  it('collapses all five sources into one button claiming every importer', () => {
    const sections = pickableSections(amazonCatalog, BUNDLES);
    const amazon = sections.find((section) => section.key === 'amazon');

    expect(amazon?.items.map((item) => item.key)).toEqual(['b:amazon']);
    expect(amazon?.items[0].importers.sort()).toEqual([
      'amazon',
      'amazon_music',
      'audible',
      'kindle_reading',
      'prime_video',
    ]);
  });

  it('shows every kind its members bring, Orders & payments included', () => {
    const sections = pickableSections(amazonCatalog, BUNDLES);
    const tile = sections.find((section) => section.key === 'amazon')?.items[0];

    expect(tile?.objects.map((o) => o.label)).toEqual([
      'Watch history',
      'Listening',
      'Playlists',
      'Books & highlights',
      'Orders & payments',
    ]);
  });
});

/**
 * The picker used to show a name and nothing else, so "what would adding this
 * give me" was answerable only by picking it and reading the next step.
 *
 * These lists key off each source's `category`, not off its authored
 * `whatImported` prose. The prose matcher this replaced failed both ways at
 * once: only 17 of 100 catalog entries carry `whatImported`, and where it did
 * exist it produced false claims — the cases pinned below.
 */
describe('objectsFor', () => {
  it('gives every catalog category a list', () => {
    // The categories the backend actually uses (guides.ts). A new one falling
    // through is caught here rather than by a user seeing a bare tile.
    const CATEGORIES = [
      'mail',
      'photos',
      'location',
      'calendar',
      'contacts',
      'video',
      'messages',
      'health',
      'audio',
      'social',
      'browser',
      'reading',
      'misc',
      'travel',
      'ai',
      'productivity',
      'gaming',
      'finance',
      'code',
    ];

    for (const category of CATEGORIES) {
      expect(objectsFor(category), category).not.toHaveLength(0);
    }
  });

  it('gives a GPS format Places, not Listening and Orders', () => {
    // GPX's authored prose is "Track points (lat/lon) in route order" — which
    // the old keyword matcher read as music tracks and shop orders, while
    // missing location entirely because "lat/lon" is not "coordinates".
    expect(objectsFor('location').map((o) => o.label)).toEqual(['Places']);
  });

  it('claims nothing for a category it has not been taught', () => {
    expect(objectsFor('brand-new-category')).toEqual([]);
    expect(objectsFor(undefined)).toEqual([]);
  });

  it('gives a bundle the union of what its members import, deduplicated', () => {
    expect(
      mergeObjects([objectsFor('mail'), objectsFor('photos'), objectsFor('mail')]).map((o) => o.label),
    ).toEqual(['Mail', 'Photos', 'Videos']);
  });

  it('orders a bundle by the vocabulary, not by member order', () => {
    const forwards = mergeObjects([objectsFor('mail'), objectsFor('calendar')]);
    const backwards = mergeObjects([objectsFor('calendar'), objectsFor('mail')]);

    expect(forwards.map((o) => o.label)).toEqual(backwards.map((o) => o.label));
  });
});

describe('exportEntries', () => {
  const catalog = [
    source({ id: 'gmail', ecosystem: 'google' }),
    source({ id: 'spotify', ecosystem: 'music' }),
    source({ id: 'facebook', ecosystem: 'meta' }),
    source({ id: 'whatsapp', ecosystem: 'meta' }),
  ];

  it('one card per pick: a bundle is one card, walked in picker order', () => {
    const entries = exportEntries(catalog, BUNDLES, new Set(['b:google', 'spotify', 'whatsapp']));

    expect(entries.map((entry) => entry.key)).toEqual(['b:google', 'whatsapp', 'spotify']);
  });

  it('a bundle member picked THROUGH the bundle does not also get its own card', () => {
    const entries = exportEntries(catalog, BUNDLES, new Set(['b:meta']));

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('bundle');
  });

  it('a STANDALONE member picked on its own gets its own card, declaring itself', () => {
    const withInstagram = [...catalog, source({ id: 'instagram', ecosystem: 'meta' })];
    const entries = exportEntries(withInstagram, BUNDLES, new Set(['instagram']));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'service', key: 'instagram', importers: ['instagram'] });
  });

  it('the bundle still declares a standalone member picked through the bundle', () => {
    const withInstagram = [...catalog, source({ id: 'instagram', ecosystem: 'meta' })];
    const entries = exportEntries(withInstagram, BUNDLES, new Set(['b:meta']));

    expect(entries).toHaveLength(1);
    expect(entries[0].importers).toEqual(expect.arrayContaining(['facebook', 'instagram']));
  });
});

describe('bundleToGuide', () => {
  it("keeps the steps heading and the alternative path, so the card renders them like a source's", () => {
    const guide = bundleToGuide({
      ...BUNDLES[1],
      url: 'https://accountscenter.facebook.com/',
      stepsTitle: 'One-time export',
      steps: ['Open Accounts Center.'],
      altPath: {
        title: 'Ongoing transfer',
        url: 'https://example.invalid/transfer',
        steps: ['Set up a transfer.'],
      },
      notes: ['WhatsApp is separate.'],
    });

    expect(guide).toMatchObject({
      title: 'Meta (Facebook, Instagram)',
      url: 'https://accountscenter.facebook.com/',
      stepsTitle: 'One-time export',
      steps: ['Open Accounts Center.'],
      altPath: {
        title: 'Ongoing transfer',
        url: 'https://example.invalid/transfer',
        steps: ['Set up a transfer.'],
      },
      notes: ['WhatsApp is separate.'],
    });
  });

  it('leaves both out when the bundle has neither', () => {
    const guide = bundleToGuide(BUNDLES[0]);

    expect(guide.stepsTitle).toBeUndefined();
    expect(guide.altPath).toBeUndefined();
  });
});
