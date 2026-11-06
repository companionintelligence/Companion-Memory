import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ML_DSA, mlDsaFromSeed, verifyMlDsa, type MlDsaAlg } from './mlDsa';

const hex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'hex'));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

interface VectorFile {
  seed: string;
  message: string;
  vectors: Record<MlDsaAlg, { publicKey: string; signature: string }>;
}

/**
 * Produced by dilithium-py 1.5.1, a pure-Python FIPS 204 implementation that shares no code with
 * @noble/post-quantum or with the Rust `fips204` crate: key derivation from a seed, then a
 * DETERMINISTIC pure-mode (empty context) signature over the real signing payload of the Rust
 * `challenge.bin` fixture. How: `__tests__/fixtures/README.md`.
 */
const FILE: VectorFile = JSON.parse(
  readFileSync(join(__dirname, '..', '__tests__', 'fixtures', 'ml-dsa', 'vectors.json'), 'utf8'),
);
const ALGS: readonly MlDsaAlg[] = ['ml-dsa-44', 'ml-dsa-65', 'ml-dsa-87'];

describe('ML-DSA (FIPS 204, pure mode, empty context)', () => {
  const seed = hex(FILE.seed);
  const message = hex(FILE.message);

  describe.each(ALGS)('%s against the independent implementation', (alg) => {
    const vector = FILE.vectors[alg];

    it('derives the same public key from the same seed', () => {
      expect(toHex(mlDsaFromSeed(alg, seed).publicKey)).toBe(vector.publicKey);
    });

    it('verifies the independent implementation’s signature', () => {
      expect(verifyMlDsa(alg, hex(vector.publicKey), message, hex(vector.signature))).toBe(true);
    });

    it('signs deterministically to the SAME BYTES as the independent implementation', () => {
      // Deterministic ML-DSA is fully determined by (key, message, empty context), so byte equality
      // here is the strongest interop statement available: same key encoding, same domain
      // separation, same rejection sampling. A wrong context would change every byte.
      const { sign } = mlDsaFromSeed(alg, seed, { deterministic: true });

      expect(toHex(sign(message))).toBe(vector.signature);
    });

    it('has the FIPS 204 Table 2 sizes', () => {
      expect(hex(vector.publicKey)).toHaveLength(ML_DSA[alg].publicKey);
      expect(hex(vector.signature)).toHaveLength(ML_DSA[alg].signature);
    });
  });

  describe('signing', () => {
    const { publicKey, sign } = mlDsaFromSeed('ml-dsa-65', seed);

    it('is HEDGED by default: two signatures of one message differ, and both verify', () => {
      const first = sign(message);
      const second = sign(message);

      expect(toHex(first)).not.toBe(toHex(second));
      expect(verifyMlDsa('ml-dsa-65', publicKey, message, first)).toBe(true);
      expect(verifyMlDsa('ml-dsa-65', publicKey, message, second)).toBe(true);
    });

    it('is reproducible when asked to be deterministic', () => {
      const pair = mlDsaFromSeed('ml-dsa-65', seed, { deterministic: true });

      expect(toHex(pair.sign(message))).toBe(toHex(pair.sign(message)));
    });

    it('rejects a seed that is not 32 bytes', () => {
      expect(() => mlDsaFromSeed('ml-dsa-65', new Uint8Array(31))).toThrow(RangeError);
    });
  });

  describe('verification refuses', () => {
    const { publicKey, sign } = mlDsaFromSeed('ml-dsa-65', seed);
    const signature = sign(message);

    it('a changed message or any damaged signature byte', () => {
      expect(verifyMlDsa('ml-dsa-65', publicKey, hex('00'), signature)).toBe(false);
      for (const index of [0, 100, signature.length - 1]) {
        const damaged = Uint8Array.from(signature);
        damaged[index] ^= 0x01;

        expect(verifyMlDsa('ml-dsa-65', publicKey, message, damaged)).toBe(false);
      }
    });

    it('a different key', () => {
      const other = mlDsaFromSeed('ml-dsa-65', new Uint8Array(32).fill(9)).publicKey;

      expect(verifyMlDsa('ml-dsa-65', other, message, signature)).toBe(false);
    });

    it('the wrong lengths and the wrong parameter set, without throwing', () => {
      expect(verifyMlDsa('ml-dsa-65', publicKey.subarray(1), message, signature)).toBe(false);
      expect(verifyMlDsa('ml-dsa-65', publicKey, message, signature.subarray(1))).toBe(false);
      expect(verifyMlDsa('ml-dsa-44', publicKey, message, signature)).toBe(false);
      expect(verifyMlDsa('ml-dsa-87', publicKey, message, signature)).toBe(false);
      expect(verifyMlDsa('ml-dsa-65', new Uint8Array(0), message, new Uint8Array(0))).toBe(false);
    });

    it('garbage of exactly the right size', () => {
      expect(
        verifyMlDsa('ml-dsa-65', new Uint8Array(1952).fill(7), message, new Uint8Array(3309).fill(7)),
      ).toBe(false);
    });
  });
});
