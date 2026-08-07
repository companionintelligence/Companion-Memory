import { describe, expect, it } from 'vitest';

import { groupSourcesByKind, sourceLabel } from './sourceLabels';
import type { SourceCount } from './useStatsService';

describe('sourceLabel', () => {
  it('names CI-Server-internal provenance keys', () => {
    expect(sourceLabel('self')).toBe('Your own profile');
    expect(sourceLabel('Unknown')).toBe('No recorded source');
    expect(sourceLabel('import:communications:participant')).toBe('Message participants');
  });

  it('resolves connectors through the shared map, ignoring the import: prefix', () => {
    expect(sourceLabel('import:apple_contacts')).toBe('Contacts');
    expect(sourceLabel('gmail')).toBe('Gmail');
  });

  it('matches connectors case-insensitively, as importers write free text', () => {
    // `properties.Source` on real LinkedIn rows is "LinkedIn", not "linkedin".
    expect(sourceLabel('LinkedIn')).toBe('LinkedIn');
  });

  it('title-cases unknown sources rather than dropping them', () => {
    expect(sourceLabel('import:acme_crm')).toBe('Acme Crm');
  });

  it('leaves already-cased names alone', () => {
    expect(sourceLabel('MySpace')).toBe('MySpace');
  });
});

describe('groupSourcesByKind', () => {
  const rows: SourceCount[] = [
    { source: 'LinkedIn', kind: 'imported', count: 2360 },
    { source: 'import:communications:participant', kind: 'derived', count: 627 },
    { source: 'self', kind: 'self', count: 1 },
  ];

  it('groups rows into sections in display order', () => {
    expect(groupSourcesByKind(rows)).toEqual([
      {
        kind: 'imported',
        label: 'Imported from elsewhere',
        rows: [{ key: 'LinkedIn', label: 'LinkedIn', count: 2360 }],
      },
      {
        kind: 'derived',
        label: 'Worked out on this device',
        rows: [
          {
            key: 'import:communications:participant',
            label: 'Message participants',
            count: 627,
          },
        ],
      },
      { kind: 'self', label: 'You', rows: [{ key: 'self', label: 'Your own profile', count: 1 }] },
    ]);
  });

  it('disambiguates sources that share a connector label within one section', () => {
    const colliding: SourceCount[] = [
      { source: 'google_contacts', kind: 'imported', count: 900 },
      { source: 'apple_contacts', kind: 'imported', count: 400 },
      { source: 'gmail', kind: 'imported', count: 100 },
    ];

    expect(groupSourcesByKind(colliding)[0].rows).toEqual([
      { key: 'google_contacts', label: 'Google Contacts', count: 900 },
      { key: 'apple_contacts', label: 'Apple Contacts', count: 400 },
      { key: 'gmail', label: 'Gmail', count: 100 },
    ]);
  });

  it('drops kinds with no rows', () => {
    expect(groupSourcesByKind(rows).map((g) => g.kind)).not.toContain('unknown');
  });

  it('preserves the API ordering within a section', () => {
    const many: SourceCount[] = [
      { source: 'gmail', kind: 'imported', count: 90 },
      { source: 'spotify', kind: 'imported', count: 40 },
    ];

    expect(groupSourcesByKind(many)[0].rows.map((r) => r.label)).toEqual(['Gmail', 'Spotify']);
  });

  it('returns nothing for an empty breakdown', () => {
    expect(groupSourcesByKind([])).toEqual([]);
  });

  it('shows rows with an unrecognised kind rather than dropping them', () => {
    // An older frontend against a newer API that added a kind.
    const future = [{ source: 'gmail', kind: 'inferred' as never, count: 5 }];

    expect(groupSourcesByKind(future)).toEqual([
      { kind: 'unknown', label: 'Unattributed', rows: [{ key: 'gmail', label: 'Gmail', count: 5 }] },
    ]);
  });
});
