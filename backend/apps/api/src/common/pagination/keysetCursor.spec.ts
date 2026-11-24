import { decodeKeysetCursor, encodeKeysetCursor } from './keysetCursor';

describe('keyset cursor codec', () => {
  it('round-trips two parts in the default format', () => {
    const cursor = encodeKeysetCursor(['2026-05-01T00:00:00.123456Z', 'abc']);

    expect(Buffer.from(cursor, 'base64').toString('utf8')).toBe('2026-05-01T00:00:00.123456Z|abc');
    expect(decodeKeysetCursor(cursor, 2)).toEqual(['2026-05-01T00:00:00.123456Z', 'abc']);
  });

  it('keeps every call site its own wire format', () => {
    const doubleColon = encodeKeysetCursor(['0.91', 'id-1'], { separator: '::' });
    const urlSafe = encodeKeysetCursor(['2026-05-01T00:00:00.000Z', 'id-1'], { alphabet: 'base64url' });

    expect(Buffer.from(doubleColon, 'base64').toString('utf8')).toBe('0.91::id-1');
    expect(decodeKeysetCursor(doubleColon, 2, { separator: '::' })).toEqual(['0.91', 'id-1']);
    expect(urlSafe).not.toMatch(/[+/=]/);
    expect(decodeKeysetCursor(urlSafe, 2, { alphabet: 'base64url' })).toEqual([
      '2026-05-01T00:00:00.000Z',
      'id-1',
    ]);
  });

  it('splits on the FIRST separators, so a separator inside the last part survives', () => {
    // The bug three of the hand-rolled copies had: `split('::')` on this gave
    // `['t', 'a', 'b']` and the id came back as `a`.
    const cursor = encodeKeysetCursor(['t', 'a::b'], { separator: '::' });

    expect(decodeKeysetCursor(cursor, 2, { separator: '::' })).toEqual(['t', 'a::b']);
    expect(decodeKeysetCursor(encodeKeysetCursor(['a', 'b', 'c|d']), 3)).toEqual(['a', 'b', 'c|d']);
  });

  it('is null for an absent, undecodable or under-filled cursor, and keeps empty parts', () => {
    expect(decodeKeysetCursor(null, 2)).toBeNull();
    expect(decodeKeysetCursor('', 2)).toBeNull();
    expect(decodeKeysetCursor(Buffer.from('no-separator').toString('base64'), 2)).toBeNull();
    expect(decodeKeysetCursor(encodeKeysetCursor(['a', 'b']), 3)).toBeNull();
    // A receipt with no purchase date encodes an empty first part; that is the caller's to judge.
    expect(decodeKeysetCursor(encodeKeysetCursor(['', 'id']), 2)).toEqual(['', 'id']);
  });
});
