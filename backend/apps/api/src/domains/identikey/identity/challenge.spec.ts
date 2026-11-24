import { codeOf, fixture, hex, toHex, VECTOR } from '../__tests__/support';
import { cbor, decode, encode, type Cbor } from '../encoding/dcbor';

import {
  MAX_CHALLENGE_BYTES,
  MAX_CHALLENGE_ITEMS,
  MAX_RESPONSE_BYTES,
  MAX_RESPONSE_ITEMS,
  PROTOCOL_VERSION,
  PURPOSE_CHALLENGE,
  SIGNING_CONTEXT,
  decodeChallenge,
  decodeResponse,
  encodeChallenge,
  encodeResponse,
  signingPayload,
  type Challenge,
} from './challenge';
import { publicKeyToCbor, signatureToCbor, pqPublicKey, pqSignature } from './keys';
import { SoftwareSigner, respond } from './softwareSigner';

/** The challenge behind `fixtures/auth-v1/challenge.bin`, as the Rust crate's `vectors.rs` builds it. */
const CHALLENGE: Challenge = {
  version: PROTOCOL_VERSION,
  audience: VECTOR.audience,
  nonce: new Uint8Array(16).fill(0x42),
  issuedAt: VECTOR.now,
  expiresAt: VECTOR.now + VECTOR.ttlSeconds,
};

/** Values plus map keys, counted the way the decoder's budget counts them. */
function itemsIn(value: Cbor): number {
  switch (value.t) {
    case 'array':
      return 1 + value.v.reduce((sum, item) => sum + itemsIn(item), 0);
    case 'map':
      return 1 + value.v.reduce((sum, [, item]) => sum + 1 + itemsIn(item), 0);
    default:
      return 1;
  }
}

describe('challenge and response messages', () => {
  describe('the challenge', () => {
    it('encodes to exactly the bytes the Rust reference committed', () => {
      expect(toHex(encodeChallenge(CHALLENGE))).toBe(toHex(fixture('auth-v1/challenge.bin')));
    });

    it('is the canonical map with its keys in encoded-byte order: v, aud, exp, iat, nonce', () => {
      expect(toHex(encodeChallenge(CHALLENGE))).toBe(
        'a5' +
          '6176' +
          '01' +
          '63617564' +
          '70' +
          toHex(new TextEncoder().encode('identikey-vector')) +
          '63657870' +
          '1a6553f178' +
          '63696174' +
          '1a6553f100' +
          '656e6f6e6365' +
          '50' +
          '42'.repeat(16),
      );
    });

    it('decodes the Rust bytes back to the same fields', () => {
      expect(decodeChallenge(fixture('auth-v1/challenge.bin'))).toEqual(CHALLENGE);
    });

    it.each([
      [
        'an unknown member',
        cbor.map([
          ['v', cbor.uint(1)],
          ['aud', cbor.text('a')],
          ['nonce', cbor.bytes(new Uint8Array(16))],
          ['iat', cbor.uint(1)],
          ['exp', cbor.uint(2)],
          ['extra', cbor.uint(0)],
        ]),
      ],
      [
        'a missing member',
        cbor.map([
          ['v', cbor.uint(1)],
          ['aud', cbor.text('a')],
          ['nonce', cbor.bytes(new Uint8Array(16))],
          ['iat', cbor.uint(1)],
        ]),
      ],
      [
        'a text nonce',
        cbor.map([
          ['v', cbor.uint(1)],
          ['aud', cbor.text('a')],
          ['nonce', cbor.text('0123456789abcdef')],
          ['iat', cbor.uint(1)],
          ['exp', cbor.uint(2)],
        ]),
      ],
      [
        'a text version',
        cbor.map([
          ['v', cbor.text('1')],
          ['aud', cbor.text('a')],
          ['nonce', cbor.bytes(new Uint8Array(16))],
          ['iat', cbor.uint(1)],
          ['exp', cbor.uint(2)],
        ]),
      ],
      [
        'an integer audience',
        cbor.map([
          ['v', cbor.uint(1)],
          ['aud', cbor.uint(7)],
          ['nonce', cbor.bytes(new Uint8Array(16))],
          ['iat', cbor.uint(1)],
          ['exp', cbor.uint(2)],
        ]),
      ],
      [
        'a timestamp too large for a JS number',
        cbor.map([
          ['v', cbor.uint(1)],
          ['aud', cbor.text('a')],
          ['nonce', cbor.bytes(new Uint8Array(16))],
          ['iat', cbor.uint(1n << 60n)],
          ['exp', cbor.uint(2)],
        ]),
      ],
      ['an array instead of a map', cbor.array([cbor.uint(1)])],
    ])('refuses %s', (_label, value) => {
      expect(codeOf(() => decodeChallenge(encode(value)))).toBe('malformed');
    });

    it('refuses trailing bytes, truncation and the empty input', () => {
      const bytes = fixture('auth-v1/challenge.bin');

      expect(codeOf(() => decodeChallenge(new Uint8Array([...bytes, 0])))).toBe('malformed');
      expect(codeOf(() => decodeChallenge(bytes.subarray(0, bytes.length - 1)))).toBe('malformed');
      expect(codeOf(() => decodeChallenge(new Uint8Array(0)))).toBe('malformed');
    });

    it('refuses a challenge over the size ceiling', () => {
      const big = encodeChallenge({ ...CHALLENGE, audience: 'x'.repeat(MAX_CHALLENGE_BYTES) });

      expect(codeOf(() => decodeChallenge(big))).toBe('malformed');
    });

    it('is 11 items, inside the item ceiling with a little room', () => {
      const items = itemsIn(decode(encodeChallenge(CHALLENGE)));

      expect(items).toBe(11);
      expect(MAX_CHALLENGE_ITEMS).toBeGreaterThanOrEqual(items);
      expect(MAX_CHALLENGE_ITEMS).toBeLessThanOrEqual(2 * items);
    });

    it('refuses a challenge that is mostly values, as a budget failure and not a shape failure', () => {
      // 1 000 zeros in "v": about a kilobyte, under the byte ceiling, over the item ceiling.
      const hostile = new Uint8Array([
        0xa1,
        0x61,
        0x76,
        0x99,
        0x03,
        0xe8,
        ...Array.from({ length: 1000 }, () => 0),
      ]);

      expect(hostile.length).toBeLessThanOrEqual(MAX_CHALLENGE_BYTES);
      expect(() => decodeChallenge(hostile)).toThrow(/more than 16 values and keys/);
    });

    it('reads a version it does not speak without judging it (the verifier does that)', () => {
      expect(decodeChallenge(encodeChallenge({ ...CHALLENGE, version: 2 })).version).toBe(2);
    });
  });

  describe('the signed payload', () => {
    it('is dCBOR(["identikey-auth/v1", "challenge", chal]), as assembled by hand in Python', () => {
      expect(SIGNING_CONTEXT).toBe('identikey-auth/v1');
      expect(PURPOSE_CHALLENGE).toBe('challenge');
      expect(toHex(signingPayload(fixture('auth-v1/challenge.bin')))).toBe(
        '83' +
          '71' +
          toHex(new TextEncoder().encode('identikey-auth/v1')) +
          '69' +
          toHex(new TextEncoder().encode('challenge')) +
          '5842' +
          toHex(fixture('auth-v1/challenge.bin')),
      );
    });

    it('is domain-separated: it differs from the challenge bytes and from a payload with another purpose', () => {
      const bytes = fixture('auth-v1/challenge.bin');

      expect(toHex(signingPayload(bytes))).not.toBe(toHex(bytes));
      expect(toHex(signingPayload(bytes))).toContain(toHex(bytes));
    });
  });

  describe('the response', () => {
    it.each([
      [
        'ed25519',
        'auth-v1/response-ed25519.bin',
        'ed25519',
        'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737',
      ],
      [
        'p256',
        'auth-v1/response-p256.bin',
        'p256',
        '03d65a93977caa3d1b081852ff57a79e465f1660577304baead505dd3a48589cf3',
      ],
    ])('decodes the Rust %s response and re-encodes it to the same bytes', (_name, file, alg, key) => {
      const bytes = fixture(file);
      const response = decodeResponse(bytes);

      expect(response.publicKey.alg).toBe(alg);
      expect(response.signature.alg).toBe(alg);
      expect(toHex(response.publicKey.bytes)).toBe(key);
      expect(response.pq).toBeUndefined();
      expect(toHex(response.challengeBytes)).toBe(toHex(fixture('auth-v1/challenge.bin')));
      expect(toHex(encodeResponse(response))).toBe(toHex(bytes));
    });

    it('keeps a post-quantum pair through an encode/decode round trip, at the largest parameter set', async () => {
      const signer = SoftwareSigner.generateP256().withMlDsa('ml-dsa-87');
      const bytes = await respond(signer, encodeChallenge(CHALLENGE), { audience: VECTOR.audience });
      const response = decodeResponse(bytes);

      expect(response.pq?.publicKey.alg).toBe('ml-dsa-87');
      expect(toHex(encodeResponse(response))).toBe(toHex(bytes));
      // The ceiling has to admit the biggest honest response, with room to spare.
      expect(bytes.length).toBeGreaterThan(7000);
      expect(bytes.length).toBeLessThan(MAX_RESPONSE_BYTES / 2);
    });

    it('is 27 items at its largest, inside the item ceiling with room to spare', async () => {
      // A P-256 key (the longer classical encoding) with ML-DSA-87: every member present.
      const signer = SoftwareSigner.generateP256().withMlDsa('ml-dsa-87');
      const bytes = await respond(signer, encodeChallenge(CHALLENGE), { audience: VECTOR.audience });
      const items = itemsIn(decode(bytes));

      expect(items).toBe(27);
      expect(MAX_RESPONSE_ITEMS).toBeGreaterThanOrEqual(items);
      expect(MAX_RESPONSE_ITEMS).toBeLessThanOrEqual(2 * items);
    });

    it('refuses a response that is mostly values, as a budget failure and not a shape failure', () => {
      // "chal" holding 10 000 zeros: 10 KB, well under the byte ceiling, far over the item ceiling.
      const count = 10_000;
      const hostile = new Uint8Array([
        0xa1,
        0x64,
        ...new TextEncoder().encode('chal'),
        0x99,
        count >> 8,
        count & 0xff,
        ...Array.from({ length: count }, () => 0),
      ]);

      expect(hostile.length).toBeLessThan(MAX_RESPONSE_BYTES);
      expect(() => decodeResponse(hostile)).toThrow(/more than 40 values and keys/);
    });

    it('refuses a post-quantum key without its signature, and a signature without its key', () => {
      const base = decodeResponse(fixture('auth-v1/response-ed25519.bin'));
      const members = (extra: [string, Cbor][]) =>
        encode(
          cbor.map([
            ['chal', cbor.bytes(base.challengeBytes)],
            ['pub', publicKeyToCbor(base.publicKey)],
            ['sig', signatureToCbor(base.signature)],
            ...extra,
          ]),
        );
      const pqKey = publicKeyToCbor(pqPublicKey('ml-dsa-44', new Uint8Array(1312)));
      const pqSig = signatureToCbor(pqSignature('ml-dsa-44', new Uint8Array(2420)));

      expect(codeOf(() => decodeResponse(members([['pqpub', pqKey]])))).toBe('pq-dangling');
      expect(codeOf(() => decodeResponse(members([['pqsig', pqSig]])))).toBe('pq-dangling');
      expect(
        decodeResponse(
          members([
            ['pqpub', pqKey],
            ['pqsig', pqSig],
          ]),
        ).pq?.publicKey.alg,
      ).toBe('ml-dsa-44');
    });

    it.each([
      ['an unknown member', 'extra'],
      ['a missing "sig"', 'sig'],
      ['a missing "pub"', 'pub'],
      ['a missing "chal"', 'chal'],
    ])('refuses %s', (_label, which) => {
      const base = decodeResponse(fixture('auth-v1/response-ed25519.bin'));
      const all: [string, Cbor][] = [
        ['chal', cbor.bytes(base.challengeBytes)],
        ['pub', publicKeyToCbor(base.publicKey)],
        ['sig', signatureToCbor(base.signature)],
      ];
      const entries: [string, Cbor][] =
        which === 'extra' ? [...all, ['extra', cbor.uint(1)]] : all.filter(([key]) => key !== which);

      expect(codeOf(() => decodeResponse(encode(cbor.map(entries))))).toBe('malformed');
    });

    it('refuses input over the size ceiling before parsing it', () => {
      expect(codeOf(() => decodeResponse(new Uint8Array(MAX_RESPONSE_BYTES + 1)))).toBe('malformed');
    });

    it('refuses a wrong-length key or signature inside an otherwise fine response', () => {
      const good = decodeResponse(fixture('auth-v1/response-ed25519.bin'));
      const shortKey = encode(
        cbor.map([
          ['chal', cbor.bytes(good.challengeBytes)],
          [
            'pub',
            cbor.map([
              ['alg', cbor.text('ed25519')],
              ['key', cbor.bytes(hex('0102'))],
            ]),
          ],
          ['sig', signatureToCbor(good.signature)],
        ]),
      );

      expect(codeOf(() => decodeResponse(shortKey))).toBe('bad-key');
    });
  });
});
