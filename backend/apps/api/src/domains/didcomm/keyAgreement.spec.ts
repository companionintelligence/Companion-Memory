import { createPrivateKey, createPublicKey } from 'node:crypto';

import { DidcommError } from './errors';
import { aesKeyUnwrap, aesKeyWrap, concatKdfSha256, deriveKeyEncryptionKey, ecdh } from './keyAgreement';
import { generateKeyPair, privateKeyObject, publicKeyObject } from './jwk';

const hex = (text: string): Buffer => Buffer.from(text.replace(/\s+/g, ''), 'hex');

describe('Concat KDF', () => {
  it('matches RFC 7518 Appendix C', () => {
    const z = Buffer.from([
      158, 86, 217, 29, 129, 113, 53, 211, 114, 131, 66, 131, 191, 132, 38, 156, 251, 49, 110, 163, 218, 128,
      106, 72, 246, 218, 167, 121, 140, 254, 144, 196,
    ]);

    const key = concatKdfSha256({
      z,
      algorithmId: 'A128GCM',
      apu: Buffer.from('Alice'),
      apv: Buffer.from('Bob'),
      keyBits: 128,
    });

    expect(key.toString('base64url')).toBe('VqqN6vgjbSBcIijNcacQGg');
  });

  it('puts the content tag, length-prefixed, after the key length (ECDH-1PU)', () => {
    const base = {
      z: Buffer.alloc(64, 1),
      algorithmId: 'ECDH-1PU+A256KW',
      apu: Buffer.from('u'),
      apv: Buffer.from('v'),
      keyBits: 256,
    };
    const tag = Buffer.alloc(32, 9);

    expect(concatKdfSha256({ ...base, tag }).equals(concatKdfSha256(base))).toBe(false);
    expect(
      concatKdfSha256({ ...base, tag }).equals(concatKdfSha256({ ...base, tag: Buffer.alloc(32, 8) })),
    ).toBe(false);
  });

  it('separates parties: swapping apu and apv changes the key', () => {
    const base = { z: Buffer.alloc(32, 3), algorithmId: 'ECDH-ES+A256KW', keyBits: 256 };

    expect(
      concatKdfSha256({ ...base, apu: Buffer.from('a'), apv: Buffer.from('b') }).equals(
        concatKdfSha256({ ...base, apu: Buffer.from('b'), apv: Buffer.from('a') }),
      ),
    ).toBe(false);
  });

  it('refuses output lengths a single SHA-256 block cannot give', () => {
    const input = { z: Buffer.alloc(32), algorithmId: 'x', apu: Buffer.alloc(0), apv: Buffer.alloc(0) };

    expect(() => concatKdfSha256({ ...input, keyBits: 512 })).toThrow(DidcommError);
    expect(() => concatKdfSha256({ ...input, keyBits: 0 })).toThrow(DidcommError);
    expect(() => concatKdfSha256({ ...input, keyBits: 130 })).toThrow(DidcommError);
  });
});

describe('deriveKeyEncryptionKey', () => {
  const common = { ze: Buffer.alloc(32, 1), apu: Buffer.alloc(0), apv: Buffer.from('v') };

  it('requires the static secret and the tag for ECDH-1PU, and forbids them for ECDH-ES', () => {
    expect(() => deriveKeyEncryptionKey({ ...common, alg: 'ECDH-1PU+A256KW' })).toThrow(DidcommError);
    expect(() =>
      deriveKeyEncryptionKey({ ...common, alg: 'ECDH-1PU+A256KW', zs: Buffer.alloc(32, 2) }),
    ).toThrow(DidcommError);
    expect(() =>
      deriveKeyEncryptionKey({
        ...common,
        alg: 'ECDH-ES+A256KW',
        zs: Buffer.alloc(32, 2),
        tag: Buffer.alloc(32),
      }),
    ).toThrow(DidcommError);
    expect(deriveKeyEncryptionKey({ ...common, alg: 'ECDH-ES+A256KW' })).toHaveLength(32);
    expect(
      deriveKeyEncryptionKey({
        ...common,
        alg: 'ECDH-1PU+A256KW',
        zs: Buffer.alloc(32, 2),
        tag: Buffer.alloc(32),
      }),
    ).toHaveLength(32);
  });

  it('gives a different key when either half of Z changes (the sender is authenticated)', () => {
    const tag = Buffer.alloc(32, 5);
    const a = deriveKeyEncryptionKey({ ...common, alg: 'ECDH-1PU+A256KW', zs: Buffer.alloc(32, 2), tag });
    const b = deriveKeyEncryptionKey({ ...common, alg: 'ECDH-1PU+A256KW', zs: Buffer.alloc(32, 3), tag });

    expect(a.equals(b)).toBe(false);
  });
});

describe('AES key wrap', () => {
  it('matches RFC 3394 §4.6 (256-bit KEK, 256-bit key data)', () => {
    const kek = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const key = hex('00112233445566778899aabbccddeeff000102030405060708090a0b0c0d0e0f');
    const wrapped = hex('28c9f404c4b810f4cbccb35cfb87f8263f5786e2d80ed326cbc7f0e71a99f43bfb988b9b7a02dd21');

    expect(aesKeyWrap(kek, key).equals(wrapped)).toBe(true);
    expect(aesKeyUnwrap(kek, wrapped).equals(key)).toBe(true);
  });

  it('wraps a 64-byte A256CBC-HS512 key into 72 bytes', () => {
    const kek = Buffer.alloc(32, 7);
    const cek = Buffer.alloc(64, 9);

    expect(aesKeyWrap(kek, cek)).toHaveLength(72);
  });

  it('detects tampering with the same error as every other decryption failure', () => {
    const kek = Buffer.alloc(32, 7);
    const wrapped = aesKeyWrap(kek, Buffer.alloc(32, 1));
    const bad = Buffer.from(wrapped);
    bad[3] ^= 1;

    expect(() => aesKeyUnwrap(kek, bad)).toThrow('the message could not be decrypted');
    expect(() => aesKeyUnwrap(Buffer.alloc(32, 8), wrapped)).toThrow(DidcommError);
    expect(() => aesKeyUnwrap(kek, wrapped.subarray(1))).toThrow(DidcommError);
    expect(() => aesKeyUnwrap(kek.subarray(1), wrapped)).toThrow(DidcommError);
  });

  it('refuses to wrap a key that is too short or misaligned', () => {
    expect(() => aesKeyWrap(Buffer.alloc(32), Buffer.alloc(8))).toThrow(DidcommError);
    expect(() => aesKeyWrap(Buffer.alloc(32), Buffer.alloc(20))).toThrow(DidcommError);
    expect(() => aesKeyWrap(Buffer.alloc(16), Buffer.alloc(32))).toThrow(DidcommError);
  });
});

describe('ecdh', () => {
  it.each(['X25519', 'P-256', 'P-384', 'P-521'] as const)('agrees on a secret over %s', (curve) => {
    const alice = generateKeyPair(curve);
    const bob = generateKeyPair(curve);

    const aliceSide = ecdh(privateKeyObject(alice.privateJwk), publicKeyObject(bob.publicJwk));
    const bobSide = ecdh(privateKeyObject(bob.privateJwk), publicKeyObject(alice.publicJwk));

    expect(aliceSide.equals(bobSide)).toBe(true);
  });

  it('refuses a small-order X25519 public key (all-zero secret)', () => {
    const { privateJwk } = generateKeyPair('X25519');
    const lowOrderPoints = [
      Buffer.alloc(32), // u = 0
      Buffer.from('0100000000000000000000000000000000000000000000000000000000000000', 'hex'), // u = 1
      Buffer.from('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'hex'), // u = p − 1
    ];

    for (const point of lowOrderPoints) {
      const publicKey = createPublicKey({
        key: { kty: 'OKP', crv: 'X25519', x: point.toString('base64url') },
        format: 'jwk',
      });

      expect(() => ecdh(privateKeyObject(privateJwk), publicKey)).toThrow(DidcommError);
    }
  });

  it('refuses mismatched curves', () => {
    const x = generateKeyPair('X25519');
    const p = generateKeyPair('P-256');

    expect(() => ecdh(privateKeyObject(x.privateJwk), publicKeyObject(p.publicJwk))).toThrow(DidcommError);
  });

  it('is symmetric for keys built from raw JWK members', () => {
    // Guards the createPrivateKey path used when a secret arrives as a plain JWK.
    const a = generateKeyPair('P-384').privateJwk;
    const b = generateKeyPair('P-384').privateJwk;
    const privateA = createPrivateKey({ key: { ...a }, format: 'jwk' });
    const publicB = createPublicKey({ key: { kty: b.kty, crv: b.crv, x: b.x, y: b.y }, format: 'jwk' });

    expect(ecdh(privateA, publicB)).toHaveLength(48);
  });
});
