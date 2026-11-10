import { LocalEd25519Signer, publicKeyFromSeed, verifyEd25519 } from './ed25519';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const fromHex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'hex'));

/**
 * RFC 8032 §7.1, test vectors 1-3, copied from the RFC: secret key (the seed), public key, message, signature.
 * Ed25519 is deterministic, so signing with the published seed must give the published signature byte for byte.
 */
const VECTORS = [
  {
    name: 'TEST 1 (empty message)',
    secret: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    message: '',
    signature:
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e0652249015' +
      '55fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  },
  {
    name: 'TEST 2 (one byte)',
    secret: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    publicKey: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    message: '72',
    signature:
      '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da' +
      '085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  },
  {
    name: 'TEST 3 (two bytes)',
    secret: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
    publicKey: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    message: 'af82',
    signature:
      '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac' +
      '18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
  },
];

describe.each(VECTORS)('Ed25519 against RFC 8032 §7.1 $name', (vector) => {
  const seed = fromHex(vector.secret);
  const message = fromHex(vector.message);

  it('derives the published public key from the seed', () => {
    expect(hex(publicKeyFromSeed(seed))).toBe(vector.publicKey);
    expect(hex(new LocalEd25519Signer('did:example:1#key', seed).publicKey)).toBe(vector.publicKey);
  });

  it('signs to the published signature, byte for byte', async () => {
    const signature = await new LocalEd25519Signer('did:example:1#key', seed).sign(message);

    expect(hex(signature)).toBe(vector.signature);
  });

  it('verifies the published signature', () => {
    expect(verifyEd25519(fromHex(vector.publicKey), message, fromHex(vector.signature))).toBe(true);
  });

  it('rejects the signature when any one bit of the message, key or signature changes', () => {
    const publicKey = fromHex(vector.publicKey);
    const signature = fromHex(vector.signature);

    const otherMessage = Uint8Array.from([...message, 0]);
    expect(verifyEd25519(publicKey, otherMessage, signature)).toBe(false);

    const flippedSignature = Uint8Array.from(signature);
    flippedSignature[10] = (flippedSignature[10] ?? 0) ^ 0x01;
    expect(verifyEd25519(publicKey, message, flippedSignature)).toBe(false);

    const flippedKey = Uint8Array.from(publicKey);
    flippedKey[5] = (flippedKey[5] ?? 0) ^ 0x01;
    expect(verifyEd25519(flippedKey, message, signature)).toBe(false);
  });
});

describe('verifyEd25519 refuses what is not a plain valid signature', () => {
  const vector = VECTORS[0]!;
  const publicKey = fromHex(vector.publicKey);
  const message = fromHex(vector.message);
  const signature = fromHex(vector.signature);

  // L, the group order, little-endian: 2^252 + 27742317777372353535851937790883648493.
  const addGroupOrder = (sig: Uint8Array): Uint8Array => {
    let scalar = 0n;
    for (let i = 63; i >= 32; i--) {
      scalar = (scalar << 8n) | BigInt(sig[i] ?? 0);
    }

    scalar += 2n ** 252n + 27742317777372353535851937790883648493n;
    const out = Uint8Array.from(sig);
    for (let i = 32; i < 64; i++) {
      out[i] = Number(scalar & 0xffn);
      scalar >>= 8n;
    }

    return out;
  };

  it('refuses a malleated signature whose scalar is S + L (RFC 8032 §5.1.7)', () => {
    const malleated = addGroupOrder(signature);

    expect(hex(malleated)).not.toBe(hex(signature));
    expect(verifyEd25519(publicKey, message, malleated)).toBe(false);
  });

  it('refuses wrong lengths without throwing', () => {
    expect(verifyEd25519(publicKey, message, signature.subarray(0, 63))).toBe(false);
    expect(verifyEd25519(publicKey, message, Uint8Array.from([...signature, 0]))).toBe(false);
    expect(verifyEd25519(publicKey.subarray(0, 31), message, signature)).toBe(false);
    expect(verifyEd25519(new Uint8Array(0), message, new Uint8Array(0))).toBe(false);
  });

  it('refuses a signature of all zeros', () => {
    expect(verifyEd25519(publicKey, message, new Uint8Array(64))).toBe(false);
  });
});

describe('LocalEd25519Signer', () => {
  it('carries its id and rejects a seed that is not 32 bytes', () => {
    expect(new LocalEd25519Signer('did:example:1#key', new Uint8Array(32)).id).toBe('did:example:1#key');
    expect(() => new LocalEd25519Signer('did:example:1#key', new Uint8Array(31))).toThrow(RangeError);
    expect(() => publicKeyFromSeed(new Uint8Array(33))).toThrow(RangeError);
  });
});
