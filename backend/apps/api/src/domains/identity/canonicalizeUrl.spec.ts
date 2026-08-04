import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalizeUrl } from './canonicalizeUrl';

interface FixtureCase {
  name: string;
  input: string;
  canonical: string | null;
  provider?: string;
  providerRef?: string;
}

// Read rather than import: be-api's tsconfig does not enable resolveJsonModule,
// and this file is the cross-repo contract — it must stay plain JSON that
// CI-Import-Tools can read with its own loader.
const fixtures = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'identity-fixtures.json'), 'utf8'),
) as { specVersion: number; cases: FixtureCase[] };

describe('canonicalizeUrl fixture contract', () => {
  it('pins a non-trivial number of cases', () => {
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(30);
  });

  it.each(fixtures.cases.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    (_name, testCase) => {
      const result = canonicalizeUrl(testCase.input);

      if (testCase.canonical === null) {
        expect(result).toBeNull();

        return;
      }

      expect(result).not.toBeNull();
      expect(result?.canonical).toBe(testCase.canonical);

      if (testCase.provider) {
        expect(result?.provider).toBe(testCase.provider);
        expect(result?.providerRef).toBe(testCase.providerRef);
      } else {
        expect(result?.provider).toBeUndefined();
      }
    },
  );
});

describe('canonicalizeUrl', () => {
  // The property that makes the canonical form usable as a stored key: writing
  // it back through the function must not move it again.
  it.each(fixtures.cases.filter((testCase) => testCase.canonical !== null))(
    'is idempotent for $name',
    (testCase) => {
      const once = canonicalizeUrl(testCase.input);
      const twice = canonicalizeUrl(once!.canonical);

      expect(twice?.canonical).toBe(once?.canonical);
      expect(twice?.providerRef).toBe(once?.providerRef);
    },
  );

  it('collapses every spelling of one video onto a single canonical form', () => {
    const spellings = [
      'https://youtu.be/dQw4w9WgXcQ?t=30',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=newsletter',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=xY',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
    ];

    const canonical = new Set(spellings.map((url) => canonicalizeUrl(url)?.canonical));

    expect(canonical).toEqual(new Set(['https://youtube.com/watch?v=dQw4w9WgXcQ']));
  });

  it.each([null, undefined, '', 'not a url at all with spaces'])(
    'returns null for %p rather than throwing',
    (input) => {
      expect(canonicalizeUrl(input)).toBeNull();
    },
  );

  it('does not treat a provider-shaped path on an unrelated host as that provider', () => {
    const result = canonicalizeUrl('https://notyoutube.example.com/watch?v=dQw4w9WgXcQ');

    expect(result?.provider).toBeUndefined();
    expect(result?.canonical).toBe('https://notyoutube.example.com/watch?v=dQw4w9WgXcQ');
  });

  it('rejects a malformed video id instead of minting a junk provider ref', () => {
    const result = canonicalizeUrl('https://www.youtube.com/watch?v=%20');

    expect(result?.providerRef).toBeUndefined();
  });
});
