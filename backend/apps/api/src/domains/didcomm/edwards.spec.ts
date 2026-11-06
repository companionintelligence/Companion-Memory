import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';

import { ed25519PublicKeyToX25519, ed25519SeedToX25519Secret } from './edwards';
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

  it('refuses the identity, the order-2 point and the order-4 points', () => {
    const identity = Buffer.alloc(32);
    identity[0] = 1; // y = 1
    const minusOne = Buffer.from('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'hex'); // y = p − 1
    const orderFour = Buffer.alloc(32); // y = 0

    for (const key of [identity, minusOne, orderFour]) {
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
