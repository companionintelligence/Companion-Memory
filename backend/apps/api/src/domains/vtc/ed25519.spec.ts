import { generateKeyPairSync } from 'node:crypto';

import { LocalSigner, privateKeyFromSeed, publicKeyObject, rawPublicKey, verifyEd25519 } from './ed25519';

/**
 * RFC 8032 §7.1, "TEST 1": the empty message. The seed, public key and signature are copied from
 * the RFC. Ed25519 is deterministic, so signing with the seed must give the RFC's signature.
 */
const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const SIGNATURE =
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

/** The order of the Ed25519 base point group, from RFC 8032 §5.1. */
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

const hex = (text: string) => new Uint8Array(Buffer.from(text, 'hex'));

/** `signature` with S replaced by S + `multiples` x L: the same point, a non-canonical encoding. */
function malleated(signature: Uint8Array, multiples: bigint): Uint8Array {
  const out = new Uint8Array(signature);
  let s = 0n;
  for (let index = 63; index >= 32; index -= 1) {
    s = (s << 8n) + BigInt(signature[index] ?? 0);
  }

  s += multiples * L;
  for (let index = 32; index < 64; index += 1) {
    out[index] = Number(s & 0xffn);
    s >>= 8n;
  }

  expect(s).toBe(0n); // still fits in 32 bytes, so the encoding is well formed and only non-canonical

  return out;
}

describe('Ed25519 over node:crypto', () => {
  it('derives the RFC 8032 test 1 public key from its seed', () => {
    expect(Buffer.from(rawPublicKey(privateKeyFromSeed(hex(SEED)))).toString('hex')).toBe(PUBLIC);
  });

  it('signs the empty message with the RFC 8032 test 1 signature, byte for byte', async () => {
    const signer = new LocalSigner('did:example:community#key-0', privateKeyFromSeed(hex(SEED)));

    expect(Buffer.from(await signer.sign(new Uint8Array(0))).toString('hex')).toBe(SIGNATURE);
    expect(signer.verificationMethod).toBe('did:example:community#key-0');
  });

  it('verifies the RFC signature and nothing near it', () => {
    const message = new Uint8Array(0);

    expect(verifyEd25519(hex(PUBLIC), message, hex(SIGNATURE))).toBe(true);
    expect(verifyEd25519(hex(PUBLIC), new Uint8Array([0]), hex(SIGNATURE))).toBe(false);
  });

  it.each([1n, 2n])('refuses a signature whose S was shifted up by %i x L (RFC 8032 §5.1.7)', (multiples) => {
    const forged = malleated(hex(SIGNATURE), multiples);

    // Without the canonical-S check this would verify: S + L is the same scalar modulo L.
    expect(verifyEd25519(hex(PUBLIC), new Uint8Array(0), forged)).toBe(false);
  });

  it('refuses every single-bit change to the signature', () => {
    const good = hex(SIGNATURE);
    const accepted: number[] = [];

    for (let bit = 0; bit < 64 * 8; bit += 1) {
      const flipped = new Uint8Array(good);
      flipped[bit >> 3] = (flipped[bit >> 3] ?? 0) ^ (0x80 >> (bit & 7));
      if (verifyEd25519(hex(PUBLIC), new Uint8Array(0), flipped)) {
        accepted.push(bit);
      }
    }

    expect(accepted).toEqual([]);
  });

  it('refuses a signature made for another message, and one checked under another key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signer = new LocalSigner('did:example:community#key-0', privateKey);
    const signature = await signer.sign(Buffer.from('message'));

    expect(verifyEd25519(rawPublicKey(publicKey), Buffer.from('message'), signature)).toBe(true);
    expect(verifyEd25519(rawPublicKey(publicKey), Buffer.from('massage'), signature)).toBe(false);
    expect(verifyEd25519(hex(PUBLIC), Buffer.from('message'), signature)).toBe(false);
  });

  it('answers false, and does not throw, for keys and signatures of the wrong length', () => {
    expect(verifyEd25519(hex(PUBLIC), new Uint8Array(0), new Uint8Array(63))).toBe(false);
    expect(verifyEd25519(hex(PUBLIC), new Uint8Array(0), new Uint8Array(65))).toBe(false);
    expect(verifyEd25519(new Uint8Array(31), new Uint8Array(0), hex(SIGNATURE))).toBe(false);
    expect(verifyEd25519(new Uint8Array(33), new Uint8Array(0), hex(SIGNATURE))).toBe(false);
  });

  it('refuses a seed or a public key that is not 32 bytes', () => {
    expect(() => privateKeyFromSeed(new Uint8Array(31))).toThrow(RangeError);
    expect(() => privateKeyFromSeed(new Uint8Array(33))).toThrow(RangeError);
    expect(() => publicKeyObject(new Uint8Array(31))).toThrow(RangeError);
  });
});
