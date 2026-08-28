import {
  classifyExternalId,
  EXTERNAL_ID_URI_SHAPE,
  EXTERNAL_ID_UUID_SHAPE,
  SOURCE_NATIVE_EXTERNAL_ID_KIND,
} from './externalIdKind';

/**
 * Every scheme-prefixed `external_id` an in-tree datasource can mint today, as
 * of the F22 audit. Each one was stamped `'file'` by migration
 * 20260818215331's `source_system IS DISTINCT FROM 'spotify'` rule — the
 * mislabel this predicate exists to make impossible.
 */
const SOURCE_NATIVE_URIS = [
  // domains/import/datasources/spotify.ts (the only one the old rule knew about)
  'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
  'spotify:episode:512ojhOuo1ktJprKbVcKyQ',
  'spotify:show:5CfCWKI5pZ28U0uOzXkDHe',
  // domains/import/datasources/amazon_music.ts
  'amazonmusic:track:B07JQZ1KMP',
  'amazonmusic:album:B08XYZ1234',
  // domains/import/datasources/audible.ts
  'audible:asin:B002V0QK4C',
  // domains/import/datasources/kindle_reading.ts
  'kindle:asin:B00X4WHP55',
  'kindle:doc:B00X4WHP55',
  // domains/import/datasources/prime_video.ts
  'primevideo:title:9f2c1b0a4d3e5f60',
];

describe('classifyExternalId', () => {
  it.each(SOURCE_NATIVE_URIS)('classifies the scheme-prefixed id %s as external_uri', (uri) => {
    expect(classifyExternalId(uri)).toBe('external_uri');
  });

  it('classifies a URL as external_uri — any scheme counts, not a hard-coded list', () => {
    expect(classifyExternalId('https://cdn.example.com/photo.jpg')).toBe('external_uri');
    expect(classifyExternalId('http://example.com/a')).toBe('external_uri');
    // A scheme this codebase has never seen must classify the same way: the
    // whole point is that the rule survives the next datasource.
    expect(classifyExternalId('someunreleasedsource:thing:42')).toBe('external_uri');
  });

  it('classifies a uuid as a file id, case-insensitively', () => {
    expect(classifyExternalId('0198f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f')).toBe('file');
    expect(classifyExternalId('0198F0A1-2B3C-7D4E-8F90-1A2B3C4D5E6F')).toBe('file');
  });

  it('anchors the uuid shape at both ends — a uuid-with-a-tail is not a file id', () => {
    expect(classifyExternalId('0198f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f-extra')).toBeUndefined();
    expect(classifyExternalId('urn:0198f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f')).toBe('external_uri');
    expect(classifyExternalId('0198f0a1-2b3c-7d4e-8f90-1a2b3c4d5e')).toBeUndefined();
  });

  it('leaves a bare platform id UNCLASSIFIED rather than guessing file', () => {
    // These are the ETL connectors' external_ids. Guessing 'file' for them is
    // exactly the defect; the transforms stamp them explicitly instead.
    for (const bare of [
      'dQw4w9WgXcQ', // YouTube videoId
      'UCuAXFkgsw1L7xaCfnd5JJOw', // YouTube channelId
      '1a2B3cDeFgHiJkLmNoPqRsTuV', // Google Drive fileId
      '01ABCDEFGHIJKLMNOPQRSTUVWXYZ', // OneDrive itemId
      '730', // Steam appid
      '10160123456789012', // Facebook post id
      '3n3Ppam7vgaVa1iaRUc9Lp', // bare Spotify track id (ETL, not the URI form)
    ]) {
      expect(classifyExternalId(bare)).toBeUndefined();
    }
  });

  it('requires a lowercase-alpha scheme — a digit or uppercase before the colon is not a scheme', () => {
    // GitHub's commit-comment external_id is `<sha>:<id>`; a hex sha almost
    // always contains digits, so it must NOT read as a scheme prefix.
    expect(classifyExternalId('7d3a19b0f2:8891234')).toBeUndefined();
    expect(classifyExternalId('Spotify:track:x')).toBeUndefined();
    expect(classifyExternalId(':leading')).toBeUndefined();
  });

  it('treats absent/empty input as unclassified', () => {
    expect(classifyExternalId(undefined)).toBeUndefined();
    expect(classifyExternalId(null)).toBeUndefined();
    expect(classifyExternalId('')).toBeUndefined();
  });

  it('never lets both shapes match the same value (the two kinds are disjoint)', () => {
    const values = [
      ...SOURCE_NATIVE_URIS,
      '0198f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f',
      'https://example.com',
      'dQw4w9WgXcQ',
      '730',
    ];

    for (const value of values) {
      expect(EXTERNAL_ID_URI_SHAPE.test(value) && EXTERNAL_ID_UUID_SHAPE.test(value)).toBe(false);
    }
  });

  it('names external_uri as the kind an ETL connector stamps', () => {
    // The const exists so the transforms document WHY once; if it ever became
    // 'file' every connector row would start claiming to be a ci.files id.
    expect(SOURCE_NATIVE_EXTERNAL_ID_KIND).toBe('external_uri');
  });
});
