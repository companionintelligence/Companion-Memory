import { describe, expect, it } from 'vitest';

import type { CatalogSource, ObjectCount } from '../useImportApi';

import { countFor, indexObjectCounts } from './useObjectCounts';

/**
 * The count-attribution rules behind the picker's "24K Mail" line — the
 * live-table sibling of `useSourceUsage.test.ts`'s `creditedSources`.
 */

function catalogSource(overrides: Partial<CatalogSource> & { id: string }): CatalogSource {
  return {
    title: overrides.id,
    blurb: '',
    ecosystem: 'music',
    category: 'audio',
    acquisition: 'web-export',
    wait: 'minutes',
    steps: [],
    importer: overrides.id,
    importerReady: true,
    ...overrides,
  };
}

describe('indexObjectCounts', () => {
  it('keeps a count for an importer that owns its catalog entry alone', () => {
    const catalog = [catalogSource({ id: 'gmail' })];
    const index = indexObjectCounts([{ importer: 'gmail', label: 'Mail', count: 24_000 }], catalog);

    expect(index.get('gmail')?.get('Mail')).toBe(24_000);
  });

  // The exact scenario useSourceUsage.ts's docblock warns against, now for a
  // count instead of a date: google_calendar/apple_calendar/outlook_calendar
  // all share the importer 'calendar', so a live count for it cannot say
  // which one produced it.
  it('drops a count for an importer shared by more than one catalog entry', () => {
    const catalog = [
      catalogSource({ id: 'google_calendar', importer: 'calendar' }),
      catalogSource({ id: 'apple_calendar', importer: 'calendar' }),
    ];
    const index = indexObjectCounts([{ importer: 'calendar', label: 'Calendar', count: 1_841 }], catalog);

    expect(index.has('calendar')).toBe(false);
  });

  it('drops a zero or negative count rather than indexing a fabricated entry', () => {
    const catalog = [catalogSource({ id: 'gmail' })];
    const index = indexObjectCounts(
      [
        { importer: 'gmail', label: 'Mail', count: 0 },
        { importer: 'gmail', label: 'Spam', count: -1 },
      ],
      catalog,
    );

    expect(index.has('gmail')).toBe(false);
  });
});

describe('countFor', () => {
  const index = new Map<string, ReadonlyMap<string, number>>([
    ['gmail', new Map([['Mail', 24_000]])],
    [
      'google_photos',
      new Map([
        ['Photos', 1_200_000],
        ['Videos', 3_400],
      ]),
    ],
  ]);

  it("reads a single service's own count", () => {
    expect(countFor(index, ['gmail'], 'Mail')).toBe(24_000);
  });

  it("sums a bundle's members for the same label", () => {
    // The Google tile's importers include both gmail and google_photos; a
    // Photos-labelled chip only exists on the photos side, so this pins that
    // summing does not require every member to contribute.
    expect(countFor(index, ['gmail', 'google_photos'], 'Photos')).toBe(1_200_000);
  });

  it('is undefined — never 0 — when nothing is known for any of the importers', () => {
    // "Never imported" and "imported, and it was zero" must render
    // identically (no number), for the same reason useSourceUsage shows no
    // date rather than a blank one.
    expect(countFor(index, ['strava'], 'Health & activity')).toBeUndefined();
  });

  it('ignores an unknown importer while still summing the known ones', () => {
    expect(countFor(index, ['gmail', 'unknown_source'], 'Mail')).toBe(24_000);
  });
});

// Guards the wire format: a real ObjectCount from the API must satisfy what
// indexObjectCounts consumes, so a backend shape change fails a type check
// here before it ever reaches the picker.
const _wireShapeCheck: ObjectCount = { importer: 'gmail', label: 'Mail', count: 1 };
void _wireShapeCheck;
