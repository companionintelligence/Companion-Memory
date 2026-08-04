import { buildNaturalKey } from './naturalKey';
import type { Dimension } from './types';

const fallback = { archiveRelpath: 'netflix/watch.txt', recordOrdinal: 0 };

const run = (dims: Dimension[], overrides: Partial<Parameters<typeof buildNaturalKey>[0]> = {}) =>
  buildNaturalKey({
    scope: 'netflix',
    kind: 'media.watch',
    dims,
    fallback,
    seen: new Map(),
    ...overrides,
  });

describe('buildNaturalKey', () => {
  it('is deterministic for the same input', () => {
    const dims: Dimension[] = [
      { name: 'title', value: 'The Witcher: S1E1', temporal: false },
      { name: 'profile', value: 'Liam', temporal: false },
    ];

    expect(run(dims)).toBe(run(dims));
  });

  it('is insensitive to the order dimensions are declared in', () => {
    const a = run([
      { name: 'title', value: 'A', temporal: false },
      { name: 'profile', value: 'B', temporal: false },
    ]);
    const b = run([
      { name: 'profile', value: 'B', temporal: false },
      { name: 'title', value: 'A', temporal: false },
    ]);

    expect(a).toBe(b);
  });

  it('separates the scope and kind namespaces', () => {
    const dims: Dimension[] = [
      { name: 'title', value: 'A', temporal: false },
      { name: 'profile', value: 'B', temporal: false },
    ];

    expect(run(dims, { scope: 'netflix' })).not.toBe(run(dims, { scope: 'hulu' }));
    expect(run(dims, { kind: 'media.watch' })).not.toBe(run(dims, { kind: 'media.play' }));
  });

  // The defect this function exists to fix: Netflix's quick export has a
  // constant filename and no per-row id, so the old hash reduced to
  // ('netflix','watch','watch.txt', UTC-midnight, '') and an entire day of
  // viewing collapsed onto one key, then vanished into INSERT OR IGNORE.
  it('keeps three titles watched on one date distinct', () => {
    const seen = new Map<string, number>();
    const keys = ['The Witcher', 'Arcane', 'Blue Eye Samurai'].map((title, index) =>
      buildNaturalKey({
        scope: 'netflix',
        kind: 'media.watch',
        dims: [
          { name: 'title', value: title, temporal: false },
          { name: 'date', value: '2026-08-03', temporal: true },
        ],
        fallback: { archiveRelpath: 'netflix/watch.txt', recordOrdinal: index },
        seen,
      }),
    );

    expect(new Set(keys).size).toBe(3);
  });

  it('ignores temporal dimensions when counting toward the two-dimension floor', () => {
    const seen = new Map<string, number>();
    // Only ONE non-temporal dimension, so both rows must fall back to
    // archive+ordinal rather than colliding on the shared title.
    const keys = [0, 1].map((ordinal) =>
      buildNaturalKey({
        scope: 'netflix',
        kind: 'media.watch',
        dims: [
          { name: 'title', value: 'Same Show', temporal: false },
          { name: 'day', value: '2026-08-03', temporal: true },
          { name: 'start_iso', value: '2026-08-03T00:00:00Z', temporal: true },
        ],
        fallback: { archiveRelpath: 'netflix/watch.txt', recordOrdinal: ordinal },
        seen,
      }),
    );

    expect(new Set(keys).size).toBe(2);
  });

  it.each([
    ['a null value', null],
    ['an undefined value', undefined],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('does not count %s toward the two-dimension floor', (_label, value) => {
    const seen = new Map<string, number>();
    const keys = [0, 1].map((ordinal) =>
      buildNaturalKey({
        scope: 'netflix',
        kind: 'media.watch',
        dims: [
          { name: 'title', value: 'Same Show', temporal: false },
          { name: 'profile', value, temporal: false },
        ],
        fallback: { archiveRelpath: 'netflix/watch.txt', recordOrdinal: ordinal },
        seen,
      }),
    );

    expect(new Set(keys).size).toBe(2);
  });

  it('preserves genuine repeats with an occurrence suffix', () => {
    const seen = new Map<string, number>();
    const dims: Dimension[] = [
      { name: 'title', value: 'Same Show', temporal: false },
      { name: 'profile', value: 'Liam', temporal: false },
    ];

    const first = buildNaturalKey({ scope: 'netflix', kind: 'media.watch', dims, fallback, seen });
    const second = buildNaturalKey({ scope: 'netflix', kind: 'media.watch', dims, fallback, seen });
    const third = buildNaturalKey({ scope: 'netflix', kind: 'media.watch', dims, fallback, seen });

    expect(second).toBe(`${first}#1`);
    expect(third).toBe(`${first}#2`);
  });

  // A double import of the same archive must be a no-op, which is only true if
  // the counter restarts per run and the ordinals are stable.
  it('reproduces identical keys on a re-import of the same archive', () => {
    const importOnce = () => {
      const seen = new Map<string, number>();

      return ['A', 'A', 'B'].map((title, index) =>
        buildNaturalKey({
          scope: 'netflix',
          kind: 'media.watch',
          dims: [{ name: 'title', value: title, temporal: false }],
          fallback: { archiveRelpath: 'netflix/watch.txt', recordOrdinal: index },
          seen,
        }),
      );
    };

    expect(importOnce()).toEqual(importOnce());
  });

  it('carries the spec version so a bump can be detected', () => {
    const dims: Dimension[] = [
      { name: 'title', value: 'A', temporal: false },
      { name: 'profile', value: 'B', temporal: false },
    ];

    expect(run(dims)).toMatch(/^nat:v1:[0-9a-f]{64}$/);
    expect(run(dims, { specVersion: 2 })).toMatch(/^nat:v2:[0-9a-f]{64}$/);
  });
});
