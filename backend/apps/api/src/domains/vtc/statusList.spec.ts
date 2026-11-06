import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { encodeMultibaseBase64url } from './multibase';
import {
  buildStatusListCredential,
  createBitstring,
  encodeBitstring,
  evaluateStatus,
  expandBitstring,
  MIN_STATUS_LIST_ENTRIES,
  parseStatusEntry,
  readStatus,
  StatusListError,
  writeStatus,
  type BitstringStatusListEntry,
  type StatusErrorCode,
} from './statusList';

/**
 * The `encodedList` printed in the W3C Bitstring Status List specification's examples
 * (https://www.w3.org/TR/vc-bitstring-status-list/): 16 KiB, which is 131,072 entries, all zero.
 */
const SPEC_ENCODED_LIST = 'uH4sIAAAAAAAAA-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAA';

const LIST_URL = 'https://community.example.com/v1/status-lists/revocation';
const ISSUER = 'did:webvh:community.example.com:abc';
const NOW = new Date('2026-11-05T12:00:00Z');

const entry = (overrides: Record<string, unknown> = {}): BitstringStatusListEntry =>
  parseStatusEntry({
    id: `${LIST_URL}#42`,
    type: 'BitstringStatusListEntry',
    statusPurpose: 'revocation',
    statusListIndex: '42',
    statusListCredential: LIST_URL,
    ...overrides,
  });

function list(
  bits = createBitstring(),
  changes: Record<string, unknown> = {},
  subject: Record<string, unknown> = {},
) {
  const built = buildStatusListCredential({
    id: LIST_URL,
    issuer: ISSUER,
    purpose: 'revocation',
    bits,
    validFrom: new Date('2026-11-05T00:00:00Z'),
    validUntil: new Date('2026-11-06T00:00:00Z'),
    ttlMs: 3_600_000,
  });

  return { ...built, ...changes, credentialSubject: { ...(built.credentialSubject as object), ...subject } };
}

function codeOf(run: () => unknown): StatusErrorCode | 'no error' {
  try {
    run();
  } catch (error) {
    return error instanceof StatusListError ? error.code : (`other: ${String(error)}` as never);
  }

  return 'no error';
}

describe('bitstring encoding', () => {
  it('expands the specification’s own example to 131,072 zero entries', () => {
    const bits = expandBitstring(SPEC_ENCODED_LIST);

    expect(bits).toHaveLength(16_384);
    expect(bits.every((byte) => byte === 0)).toBe(true);
  });

  it('round-trips through GZIP and Multibase base64url, starting with the GZIP magic', () => {
    const bits = createBitstring();
    writeStatus(bits, 94_567, 1);

    const encoded = encodeBitstring(bits);

    expect(encoded.startsWith('uH4sI')).toBe(true);
    expect(Array.from(expandBitstring(encoded))).toEqual(Array.from(bits));
  });

  it('numbers entries from the left-most bit of the first byte (§7.1)', () => {
    const bits = createBitstring();

    writeStatus(bits, 0, 1);
    expect(bits[0]).toBe(0b1000_0000);

    writeStatus(bits, 7, 1);
    expect(bits[0]).toBe(0b1000_0001);

    writeStatus(bits, 8, 1);
    expect(bits[1]).toBe(0b1000_0000);

    expect([0, 1, 7, 8, 9].map((index) => readStatus(bits, index))).toEqual([1, 0, 1, 1, 0]);
  });

  it('clears a bit without disturbing its neighbours', () => {
    const bits = createBitstring();
    [3, 4, 5].forEach((index) => writeStatus(bits, index, 1));

    writeStatus(bits, 4, 0);

    expect([3, 4, 5].map((index) => readStatus(bits, index))).toEqual([1, 0, 1]);
  });

  it('reads and writes multi-bit entries most significant bit first', () => {
    const bits = createBitstring();

    writeStatus(bits, 1, 3, 2);
    expect(bits[0]).toBe(0b0011_0000);
    expect(readStatus(bits, 1, 2)).toBe(3);

    writeStatus(bits, 1, 2, 2);
    expect(bits[0]).toBe(0b0010_0000);
    expect(readStatus(bits, 1, 2)).toBe(2);
    expect(readStatus(bits, 0, 2)).toBe(0);
    expect(() => writeStatus(bits, 0, 4, 2)).toThrow(RangeError);
  });

  it.each([2, 3, 5, 6, 7, 9, 13, 32])(
    'keeps neighbouring entries intact at statusSize %i, including entries that straddle a byte',
    (size) => {
      const bits = createBitstring();
      const last = Math.floor((bits.length * 8) / size) - 1;
      const indexes = [...Array.from({ length: 40 }, (_, index) => index), last - 1, last];
      const value = (index: number) => (index * 2_654_435_761 + 12_345) % 2 ** size;

      for (const index of indexes) {
        writeStatus(bits, index, value(index), size);
      }

      for (const index of indexes) {
        expect(readStatus(bits, index, size)).toBe(value(index));
      }

      // Entries nobody wrote, next to ones somebody did, still read zero.
      expect(readStatus(bits, 40, size)).toBe(0);
      expect(readStatus(bits, last - 2, size)).toBe(0);
    },
  );

  it.each([MIN_STATUS_LIST_ENTRIES - 8, MIN_STATUS_LIST_ENTRIES + 1, 0, -8, 1.5, Number.NaN, 2 ** 31])(
    'will not create a list of %p entries',
    (entries) => {
      expect(() => createBitstring(entries)).toThrow(RangeError);
    },
  );

  it('creates larger lists in whole bytes', () => {
    expect(createBitstring(MIN_STATUS_LIST_ENTRIES * 2)).toHaveLength(32_768);
  });

  it.each([
    ['one past the end', MIN_STATUS_LIST_ENTRIES],
    ['a negative slot', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a slot beyond any safe integer', 2 ** 60],
  ])('reports RANGE_ERROR for %s', (_name, index) => {
    expect(codeOf(() => readStatus(createBitstring(), index))).toBe('RANGE_ERROR');
  });

  describe('refuses an encodedList that is', () => {
    it.each([
      ['not a string', 7],
      ['missing', undefined],
      ['empty', ''],
      ['under the wrong multibase prefix', `z${SPEC_ENCODED_LIST.slice(1)}`],
      ['standard base64', `u${Buffer.from(SPEC_ENCODED_LIST).toString('base64')}+/`],
      ['not GZIP', encodeMultibaseBase64url(Buffer.from('not a gzip stream'))],
      ['a truncated GZIP stream', SPEC_ENCODED_LIST.slice(0, 40)],
    ])('%s', (_name, encoded) => {
      expect(codeOf(() => expandBitstring(encoded))).toBe('STATUS_VERIFICATION_ERROR');
    });

    it('longer than the 4 MiB of text the reader decodes, though the stream itself is valid GZIP', () => {
      // Random bytes do not compress, so the text length follows the byte count (x 4/3).
      const encodedOf = (bytes: number) => encodeMultibaseBase64url(gzipSync(randomBytes(bytes)));
      const justUnder = encodedOf(3_000_000);
      const over = encodedOf(3_300_000);

      expect(justUnder.length).toBeLessThan(4 * 1024 * 1024);
      expect(over.length).toBeGreaterThan(4 * 1024 * 1024);
      expect(expandBitstring(justUnder)).toHaveLength(3_000_000);
      expect(() => expandBitstring(over)).toThrow('missing or too long');
    });

    it('a GZIP bomb that expands past 8 MiB', () => {
      const bomb = encodeMultibaseBase64url(gzipSync(Buffer.alloc(9 * 1024 * 1024)));

      expect(bomb.length).toBeLessThan(64 * 1024);
      expect(codeOf(() => expandBitstring(bomb))).toBe('STATUS_VERIFICATION_ERROR');
    });
  });
});

describe('parseStatusEntry', () => {
  it('reads the entry an OpenVTC community puts on a membership credential', () => {
    expect(entry()).toEqual({
      id: `${LIST_URL}#42`,
      statusPurpose: 'revocation',
      statusListIndex: 42,
      statusListCredential: LIST_URL,
      statusSize: 1,
    });
  });

  it('reads a statusSize', () => {
    expect(entry({ statusSize: 2 }).statusSize).toBe(2);
  });

  it.each([
    ['a number index', { statusListIndex: 42 }],
    ['an index with a leading zero', { statusListIndex: '042' }],
    ['a negative index', { statusListIndex: '-1' }],
    ['a fractional index', { statusListIndex: '1.5' }],
    ['an index too large to be exact', { statusListIndex: '1000000000000000' }],
    ['no index', { statusListIndex: undefined }],
    ['an http list URL', { statusListCredential: 'http://community.example.com/list' }],
    ['a list URL with credentials', { statusListCredential: 'https://user:pass@community.example.com/list' }],
    ['a list URL with a fragment', { statusListCredential: `${LIST_URL}#42` }],
    ['a list URL that is not a URL', { statusListCredential: 'not a url' }],
    ['a list URL that is not a string', { statusListCredential: 42 }],
    ['an empty purpose', { statusPurpose: '' }],
    ['a purpose that is not a string', { statusPurpose: ['revocation'] }],
    ['a statusSize of 0', { statusSize: 0 }],
    ['a statusSize over 32', { statusSize: 33 }],
    ['a fractional statusSize', { statusSize: 1.5 }],
    ['a string statusSize', { statusSize: '2' }],
    ['another type', { type: 'StatusList2021Entry' }],
    ['an id that is not a string', { id: 7 }],
  ])('refuses %s', (_name, overrides) => {
    expect(codeOf(() => entry(overrides))).toBe('STATUS_VERIFICATION_ERROR');
  });

  it.each([undefined, null, 'entry', 7, []])('refuses the non-object %p', (value) => {
    expect(codeOf(() => parseStatusEntry(value))).toBe('STATUS_VERIFICATION_ERROR');
  });
});

describe('evaluateStatus', () => {
  const evaluate = (credential: unknown, entryOverride: BitstringStatusListEntry = entry(), extra = {}) =>
    evaluateStatus(entryOverride, credential, { now: NOW, ...extra });

  it('reads a clear slot as valid, using the specification’s own list', () => {
    const credential = list(undefined, {}, { encodedList: SPEC_ENCODED_LIST });

    expect(evaluate(credential, entry({ statusListIndex: '94567' }))).toEqual({
      purpose: 'revocation',
      status: 0,
      valid: true,
      ttlMs: 3_600_000,
      bounded: true,
    });
  });

  it('reads a set slot as not valid, and only that slot', () => {
    const bits = createBitstring();
    writeStatus(bits, 42, 1);

    expect(evaluate(list(bits))).toMatchObject({ status: 1, valid: false });
    expect(evaluate(list(bits), entry({ statusListIndex: '41' }))).toMatchObject({ status: 0, valid: true });
    expect(evaluate(list(bits), entry({ statusListIndex: '43' }))).toMatchObject({ status: 0, valid: true });
  });

  it('answers for a list that serves several purposes', () => {
    expect(
      evaluate(list(createBitstring(), {}, { statusPurpose: ['revocation', 'suspension'] })),
    ).toMatchObject({
      valid: true,
    });
  });

  it('accepts a list with no id, and a list that names the URL it was fetched from', () => {
    expect(evaluate(list(createBitstring(), { id: undefined }))).toMatchObject({ valid: true });
    expect(evaluate(list(createBitstring(), { id: LIST_URL }))).toMatchObject({ valid: true });
  });

  it('accepts a list with no validUntil unless one is required', () => {
    const unbounded = list(createBitstring(), { validUntil: undefined });

    expect(evaluate(unbounded)).toMatchObject({ valid: true, bounded: false });
    expect(codeOf(() => evaluate(unbounded, entry(), { requireExpiry: true }))).toBe(
      'STATUS_VERIFICATION_ERROR',
    );
  });

  it('reports no ttl when the list gives none or gives nonsense', () => {
    expect(evaluate(list(createBitstring(), {}, { ttl: undefined })).ttlMs).toBeNull();
    expect(evaluate(list(createBitstring(), {}, { ttl: -1 })).ttlMs).toBeNull();
    expect(evaluate(list(createBitstring(), {}, { ttl: '3600' })).ttlMs).toBeNull();
  });

  describe('fails closed', () => {
    it.each([
      ['a different type', list(createBitstring(), { type: ['VerifiableCredential'] })],
      ['a subject of another type', list(createBitstring(), {}, { type: 'StatusList2021' })],
      ['no subject', { ...list(), credentialSubject: undefined }],
      ['an array of subjects', { ...list(), credentialSubject: [list().credentialSubject] }],
      [
        'an id other than the URL it was fetched from',
        list(createBitstring(), { id: 'https://evil.example/list' }),
      ],
      ['another purpose', list(createBitstring(), {}, { statusPurpose: 'suspension' })],
      ['no purpose', list(createBitstring(), {}, { statusPurpose: undefined })],
      ['a validFrom in the future', list(createBitstring(), { validFrom: '2026-11-05T12:01:01Z' })],
      ['a validUntil that has passed', list(createBitstring(), { validUntil: '2026-11-05T12:00:00Z' })],
      ['a validFrom that is not a date-time', list(createBitstring(), { validFrom: 'yesterday' })],
      ['an encodedList that is not a list', list(createBitstring(), {}, { encodedList: 'uAAAA' })],
    ])('a list credential with %s', (_name, credential) => {
      expect(codeOf(() => evaluate(credential))).toBe('STATUS_VERIFICATION_ERROR');
    });

    it.each([undefined, null, 'list', 7, []])('the non-object list %p', (credential) => {
      expect(codeOf(() => evaluate(credential))).toBe('STATUS_VERIFICATION_ERROR');
    });

    it('gives clock drift to validFrom and none to validUntil', () => {
      const early = list(createBitstring(), { validFrom: '2026-11-05T12:00:30Z' });
      const late = list(createBitstring(), { validUntil: '2026-11-05T12:00:00Z' });

      expect(evaluate(early, entry(), { skewMs: 60_000 })).toMatchObject({ valid: true });
      expect(codeOf(() => evaluate(early))).toBe('STATUS_VERIFICATION_ERROR');
      expect(codeOf(() => evaluate(late, entry(), { skewMs: 60_000 }))).toBe('STATUS_VERIFICATION_ERROR');
    });

    it('a list older than maxAgeMs, counted from its validFrom, by a single millisecond', () => {
      // The default list's validFrom is 12 hours before NOW.
      const twelveHours = 12 * 3_600_000;

      expect(evaluate(list(), entry(), { maxAgeMs: twelveHours })).toMatchObject({ valid: true });
      expect(codeOf(() => evaluate(list(), entry(), { maxAgeMs: twelveHours - 1 }))).toBe(
        'STATUS_VERIFICATION_ERROR',
      );
    });

    it('a list with no validFrom when an age limit is set, though not when none is', () => {
      const undated = list(createBitstring(), { validFrom: undefined });

      expect(evaluate(undated)).toMatchObject({ valid: true });
      expect(codeOf(() => evaluate(undated, entry(), { maxAgeMs: 86_400_000 }))).toBe(
        'STATUS_VERIFICATION_ERROR',
      );
    });

    it.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY])('an age limit of %p', (maxAgeMs) => {
      expect(codeOf(() => evaluate(list(), entry(), { maxAgeMs }))).toBe('STATUS_VERIFICATION_ERROR');
    });

    it.each([
      ['an invalid Date as the clock', { now: new Date(Number.NaN) }],
      ['a NaN clock allowance', { skewMs: Number.NaN }],
      ['a negative clock allowance', { skewMs: -1 }],
      ['an infinite clock allowance', { skewMs: Number.POSITIVE_INFINITY }],
    ])('%s, which would make every time comparison false', (_name, extra) => {
      // This list has already expired: a clock that cannot compare must not wave it through.
      const expired = list(createBitstring(), { validUntil: '2026-11-05T12:00:00Z' });

      expect(codeOf(() => evaluate(expired, entry(), extra))).toBe('STATUS_VERIFICATION_ERROR');
      expect(codeOf(() => evaluate(list(), entry(), extra))).toBe('STATUS_VERIFICATION_ERROR');
    });

    it('a list shorter than the 131,072-entry floor (STATUS_LIST_LENGTH_ERROR)', () => {
      const short = list(new Uint8Array(8_192));

      expect(codeOf(() => evaluate(short))).toBe('STATUS_LIST_LENGTH_ERROR');
    });

    it('a wide status size that leaves fewer than 131,072 entries', () => {
      expect(codeOf(() => evaluate(list(), entry({ statusSize: 2 })))).toBe('STATUS_LIST_LENGTH_ERROR');
      expect(
        evaluate(list(createBitstring(MIN_STATUS_LIST_ENTRIES * 2)), entry({ statusSize: 2 })),
      ).toMatchObject({
        valid: true,
      });
    });

    it('a slot past the end of the list (RANGE_ERROR)', () => {
      expect(
        codeOf(() => evaluate(list(), entry({ statusListIndex: String(MIN_STATUS_LIST_ENTRIES) }))),
      ).toBe('RANGE_ERROR');
    });
  });
});

describe('buildStatusListCredential', () => {
  it('builds the credential shape the specification describes', () => {
    const credential = buildStatusListCredential({
      id: LIST_URL,
      issuer: ISSUER,
      purpose: 'revocation',
      bits: createBitstring(),
      validFrom: new Date('2026-11-05T00:00:00.500Z'),
    });

    expect(credential).toMatchObject({
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      id: LIST_URL,
      type: ['VerifiableCredential', 'BitstringStatusListCredential'],
      issuer: ISSUER,
      validFrom: '2026-11-05T00:00:00Z',
      credentialSubject: { id: `${LIST_URL}#list`, type: 'BitstringStatusList', statusPurpose: 'revocation' },
    });
    expect('validUntil' in credential).toBe(false);
    expect('ttl' in (credential.credentialSubject as object)).toBe(false);
  });
});
