import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';

import { encodePoint, FIELD_PRIME, GENUINE, ORDER_8_Y, REFUSED_Y, WEAK } from './__tests__/weakEd25519';
import { ed25519PublicKeyToX25519, ed25519SeedToX25519Secret, isWeakEd25519PublicKey } from './edwards';
import { base64urlDecode, multibaseDecodeBase58btc, multibaseEncodeBase58btc } from './encoding';
import { DidcommError } from './errors';

function ed25519Pair(): { seed: Buffer; publicKey: Buffer } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });

  return {
    seed: base64urlDecode(jwk.d, 'd'),
    publicKey: base64urlDecode(jwk.x, 'x'),
  };
}

/** An X25519 private key object from a raw 32-byte scalar (PKCS#8 wrapper; JWK import needs x too). */
function x25519PrivateFrom(scalar: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), scalar]),
    format: 'der',
    type: 'pkcs8',
  });
}

function x25519PublicFrom(raw: Buffer): KeyObject {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') },
    format: 'jwk',
  });
}

function x25519PublicOf(secret: Buffer): Buffer {
  return base64urlDecode(createPublicKey(x25519PrivateFrom(secret)).export({ format: 'jwk' }).x, 'x');
}

describe('Ed25519 → X25519', () => {
  it('maps the public key to the public key of the converted secret (20 random keys)', () => {
    for (let round = 0; round < 20; round += 1) {
      const { seed, publicKey } = ed25519Pair();

      expect(
        ed25519PublicKeyToX25519(publicKey).equals(x25519PublicOf(ed25519SeedToX25519Secret(seed))),
      ).toBe(true);
    }
  });

  it('gives two converted identities one Diffie-Hellman secret', () => {
    const alice = ed25519Pair();
    const bob = ed25519Pair();

    const aliceSide = diffieHellman({
      privateKey: x25519PrivateFrom(ed25519SeedToX25519Secret(alice.seed)),
      publicKey: x25519PublicFrom(ed25519PublicKeyToX25519(bob.publicKey)),
    });
    const bobSide = diffieHellman({
      privateKey: x25519PrivateFrom(ed25519SeedToX25519Secret(bob.seed)),
      publicKey: x25519PublicFrom(ed25519PublicKeyToX25519(alice.publicKey)),
    });

    expect(aliceSide.equals(bobSide)).toBe(true);
    expect(aliceSide.some((byte) => byte !== 0)).toBe(true);
  });

  it('clamps the converted secret as X25519 requires, for every seed', () => {
    for (let round = 0; round < 64; round += 1) {
      const scalar = ed25519SeedToX25519Secret(randomBytes(32));

      expect(scalar[0] & 0b111).toBe(0);
      expect(scalar[31] & 0x80).toBe(0);
      expect(scalar[31] & 0x40).toBe(0x40);
    }
  });

  it('reproduces a published did:key pair: the Ed25519 key and the X25519 keyAgreement key derived from it', () => {
    // A third-party pair (the did:key method's Ed25519 example), independent of this code. The two
    // property tests above prove the map is self-consistent; this one proves it is the map
    // everyone else uses.
    const ed = multibaseDecodeBase58btc('z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp');
    const converted = ed25519PublicKeyToX25519(ed.subarray(2));

    expect(multibaseEncodeBase58btc(Buffer.concat([Buffer.from([0xec, 0x01]), converted]))).toBe(
      'z6LShs9GGnqk85isEBzzshkuVWrVKsRp24GnDuHk8QWkARMW',
    );
  });

  it('refuses inputs of the wrong length', () => {
    expect(() => ed25519PublicKeyToX25519(Buffer.alloc(31))).toThrow(DidcommError);
    expect(() => ed25519SeedToX25519Secret(Buffer.alloc(33))).toThrow(DidcommError);
  });

  it('refuses the identity, the order-2 point, the order-4 points and the order-8 points', () => {
    const identity = Buffer.alloc(32);
    identity[0] = 1; // y = 1
    const minusOne = Buffer.from('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'hex'); // y = p − 1
    const orderFour = Buffer.alloc(32); // y = 0
    // y = y8 (libsodium's blocklist entry) and y = p − y8, each at either sign of x.
    const orderEight = [
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
    ].map((hex) => Buffer.from(hex, 'hex'));

    for (const key of [identity, minusOne, orderFour, ...orderEight]) {
      expect(() => ed25519PublicKeyToX25519(key)).toThrow(/small order/);
    }
  });

  it('refuses a non-canonical y (y ≥ p)', () => {
    const nonCanonical = Buffer.from(
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'hex',
    ); // y = p

    expect(() => ed25519PublicKeyToX25519(nonCanonical)).toThrow(/canonical/);
  });

  it('refuses a y that is not on the curve', () => {
    let rejected = 0;

    for (let y = 2; y < 40; y += 1) {
      const candidate = Buffer.alloc(32);
      candidate[0] = y;

      try {
        ed25519PublicKeyToX25519(candidate);
      } catch (error) {
        if (error instanceof DidcommError && /not a point on the curve/.test(error.message)) {
          rejected += 1;
        }
      }
    }

    // About half of all y values have no x; a handful of 38 must hit the branch.
    expect(rejected).toBeGreaterThan(5);
  });
});

describe('isWeakEd25519PublicKey (the y-value test of peers/ed25519Weak.ts)', () => {
  const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

  it.each(WEAK)('refuses %s', (_name, hex) => {
    expect(isWeakEd25519PublicKey(bytes(hex))).toBe(true);
  });

  it.each(GENUINE)('accepts %s', (_name, hex) => {
    expect(isWeakEd25519PublicKey(bytes(hex))).toBe(false);
  });

  it('accepts freshly generated keys', () => {
    for (let round = 0; round < 100; round += 1) {
      expect(isWeakEd25519PublicKey(ed25519Pair().publicKey)).toBe(false);
    }
  });

  it('refuses anything that is not 32 bytes', () => {
    const genuine = bytes(GENUINE[0][1]);

    expect(isWeakEd25519PublicKey(genuine.subarray(0, 31))).toBe(true);
    expect(isWeakEd25519PublicKey(Uint8Array.of(...genuine, 0))).toBe(true);
    expect(isWeakEd25519PublicKey(new Uint8Array(0))).toBe(true);
  });

  it('refuses all 48 encodings: five small-order y values and the 19 non-canonical ones, at either sign', () => {
    const encodings = new Set<string>();
    for (const y of REFUSED_Y) {
      for (const negative of [false, true]) {
        const key = encodePoint(y, negative);

        expect(isWeakEd25519PublicKey(key)).toBe(true);
        encodings.add(Buffer.from(key).toString('hex'));
      }
    }

    expect(encodings.size).toBe(48);
  });

  it('does not refuse the y values next to the refused ones', () => {
    for (const y of [2n, 3n, FIELD_PRIME - 2n, FIELD_PRIME - 18n, ORDER_8_Y - 1n, ORDER_8_Y + 1n]) {
      expect(isWeakEd25519PublicKey(encodePoint(y, false))).toBe(false);
      expect(isWeakEd25519PublicKey(encodePoint(y, true))).toBe(false);
    }
  });

  it('does not modify the key it is given', () => {
    const key = bytes(WEAK[1][1]);
    const before = Buffer.from(key).toString('hex');

    isWeakEd25519PublicKey(key);

    expect(Buffer.from(key).toString('hex')).toBe(before);
  });
});
