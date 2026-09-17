import { bytes, csv, duration, stamp, table } from '../output';

describe('table', () => {
  it('pads columns to their widest cell and rules the header', () => {
    const rendered = table(
      [{ name: 'gpx' }, { name: 'google_photos' }],
      [{ header: 'name', value: (row) => row.name }],
    );

    expect(rendered.split('\n')).toEqual(['name', '─────────────', 'gpx', 'google_photos']);
  });

  it('right-aligns the columns that ask for it', () => {
    const rendered = table(
      [{ n: 5 }, { n: 1000 }],
      [{ header: 'n', value: (row) => String(row.n), align: 'right' }],
    );

    expect(rendered.split('\n').slice(2)).toEqual(['   5', '1000']);
  });

  it('says nothing is there in words — an empty result must not look like a failure', () => {
    expect(table([], [{ header: 'name', value: () => '' }])).toBe('(none)');
    expect(table([], [{ header: 'name', value: () => '' }], 'Nothing in the inbox.')).toBe(
      'Nothing in the inbox.',
    );
  });
});

describe('bytes', () => {
  it('scales to the unit an export is measured in', () => {
    expect(bytes(0)).toBe('0B');
    expect(bytes(1024)).toBe('1.0KB');
    expect(bytes(12 * 1024 * 1024 * 1024)).toBe('12GB');
  });

  it('is blank for an unknown size rather than 0', () => {
    expect(bytes(null)).toBe('');
    expect(bytes(undefined)).toBe('');
  });
});

describe('duration', () => {
  it('reads at a glance at every scale', () => {
    expect(duration(1500)).toBe('2s');
    expect(duration(61_000)).toBe('1m1s');
    expect(duration(3 * 3600 * 1000 + 60_000)).toBe('3h1m');
    expect(duration(null)).toBe('');
  });
});

describe('stamp', () => {
  it('trims to the minute', () => {
    expect(stamp('2026-08-16T10:30:45.123Z')).toBe('2026-08-16 10:30');
    expect(stamp(null)).toBe('');
  });
});

describe('csv', () => {
  it('trims and drops empties', () => {
    expect(csv(' a , b ,, ')).toEqual(['a', 'b']);
  });

  it('distinguishes "not given" from "given as empty"', () => {
    expect(csv(undefined)).toBeUndefined();
    expect(csv(' , ')).toBeUndefined();
  });
});
