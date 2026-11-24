import { blake3Hash } from './blake3';

/**
 * BLAKE3 of the official test-vector input pattern (byte i is `i % 251`), at the lengths where the
 * algorithm changes shape: block edges (64), chunk edges (1024) and the first tree levels.
 *
 * The expected values come from the `blake3` PyPI package, the reference Rust implementation, NOT from
 * `@noble/hashes`; the first two match the published empty-input and one-byte hashes. This is what
 * stands between a dependency bump and a silent change of every fingerprint.
 */
const VECTORS: readonly (readonly [number, string])[] = [
  [0, 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'],
  [1, '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213'],
  [2, '7b7015bb92cf0b318037702a6cdd81dee41224f734684c2c122cd6359cb1ee63'],
  [3, 'e1be4d7a8ab5560aa4199eea339849ba8e293d55ca0a81006726d184519e647f'],
  [63, 'e9bc37a594daad83be9470df7f7b3798297c3d834ce80ba85d6e207627b7db7b'],
  [64, '4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98'],
  [65, 'de1e5fa0be70df6d2be8fffd0e99ceaa8eb6e8c93a63f2d8d1c30ecb6b263dee'],
  [127, 'd81293fda863f008c09e92fc382a81f5a0b4a1251cba1634016a0f86a6bd640d'],
  [128, 'f17e570564b26578c33bb7f44643f539624b05df1a76c81f30acd548c44b45ef'],
  [129, '683aaae9f3c5ba37eaaf072aed0f9e30bac0865137bae68b1fde4ca2aebdcb12'],
  [1023, '10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11'],
  [1024, '42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7'],
  [1025, 'd00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444'],
  [2048, 'e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a'],
  [2049, '5f4d72f40d7a5f82b15ca2b2e44b1de3c2ef86c426c95c1af0b6879522563030'],
  [3072, 'b98cb0ff3623be03326b373de6b9095218513e64f1ee2edd2525c7ad1e5cffd2'],
  [3073, '7124b49501012f81cc7f11ca069ec9226cecb8a2c850cfe644e327d22d3e1cd3'],
  [4096, '015094013f57a5277b59d8475c0501042c0b642e531b0a1c8f58d2163229e969'],
  [5120, '9cadc15fed8b5d854562b26a9536d9707cadeda9b143978f319ab34230535833'],
  [102400, 'bc3e3d41a1146b069abffad3c0d44860cf664390afce4d9661f7902e7943e085'],
];

describe('blake3Hash', () => {
  it.each(VECTORS)('hashes %p bytes of the test pattern to the reference value', (length, expected) => {
    const input = new Uint8Array(length).map((_, i) => i % 251);

    expect(Buffer.from(blake3Hash(input)).toString('hex')).toBe(expected);
  });

  it('returns 32 bytes', () => {
    expect(blake3Hash(new Uint8Array(0))).toHaveLength(32);
  });
});
