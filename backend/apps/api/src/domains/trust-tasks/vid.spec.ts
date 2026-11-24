import { generateKeyPairSync } from 'node:crypto';

import { base64urlEncode } from './crypto/multibase';
import {
  CompositeVidResolver,
  PROOF_PURPOSES,
  SovereignKeriVidResolver,
  isProofPurpose,
  isSovereignVidShape,
  sovereignJwk,
  sovereignKeyBytes,
  sovereignVerificationMethodId,
  sovereignVidFor,
  type VidResolver,
} from './vid';

function freshKey(): { raw: Uint8Array; vid: string } {
  const jwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  const raw = new Uint8Array(Buffer.from(jwk.x as string, 'base64url'));

  return { raw, vid: sovereignVidFor(raw) };
}

describe('sovereign did:keri:D<x> identifiers', () => {
  it('spell out the key they were made from', () => {
    const { raw, vid } = freshKey();

    expect(vid).toMatch(/^did:keri:D[A-Za-z0-9_-]{43}$/);
    expect(sovereignKeyBytes(vid)).toEqual(raw);
  });

  it('refuse everything that is not the documented self-certifying form', () => {
    const { raw } = freshKey();
    const x = base64urlEncode(raw);
    // A last character that decodes to the same bytes but is not the canonical spelling.
    const lastIndex = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(x.slice(-1));
    const alias = `${x.slice(0, -1)}${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[(lastIndex + 1) % 64]}`;

    const refused = [
      `did:keri:E${x}`, // a digest-of-inception AID: needs a KEL
      `did:keri:B${x}`, // a CESR public-key code
      `did:keri:D${x}A`, // one character too long
      `did:keri:D${x.slice(1)}`, // one character too short
      `did:keri:D${x.slice(0, 42)}=`,
      `did:key:D${x}`,
      `did:keri:d${x}`,
      `${'did:keri:D'}${x} `,
      `did:keri:D${alias}`, // two spellings of one key would be two identifiers
      '',
      'did:keri:D',
    ];

    for (const candidate of refused) {
      expect(sovereignKeyBytes(candidate)).toBeNull();
    }
  });

  it('refuse a small-order key — an identifier spelling one is not an identity — though it has the right shape', async () => {
    // The all-zero string, the identity point, and the point of order two: signatures under them need no private key.
    for (const hex of [
      '00'.repeat(32),
      `01${'00'.repeat(31)}`,
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    ]) {
      const vid = sovereignVidFor(new Uint8Array(Buffer.from(hex, 'hex')));

      expect(isSovereignVidShape(vid)).toBe(true);
      expect(sovereignKeyBytes(vid)).toBeNull();
      expect(sovereignJwk(vid)).toBeNull();
      expect(await new SovereignKeriVidResolver().resolve(vid)).toBeNull();
    }
  });

  it('refuse a non-canonical spelling of a key (y not reduced modulo p)', () => {
    const vid = sovereignVidFor(
      new Uint8Array(Buffer.from('edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', 'hex')),
    );

    expect(isSovereignVidShape(vid)).toBe(true);
    expect(sovereignKeyBytes(vid)).toBeNull();
  });

  it('have a shape that is a string test and nothing more', () => {
    const { vid } = freshKey();

    expect(isSovereignVidShape(vid)).toBe(true);
    for (const candidate of [
      '',
      'did:keri:D',
      `${vid}x`,
      vid.replace('D', 'E'),
      vid.toLowerCase(),
      `${vid}\n`,
    ]) {
      expect(isSovereignVidShape(candidate)).toBe(false);
    }
  });

  it('refuse a key that is not 32 bytes when building one', () => {
    expect(() => sovereignVidFor(new Uint8Array(31))).toThrow(RangeError);
  });

  it('name their one verification method after the identifier', () => {
    const { vid } = freshKey();

    expect(sovereignVerificationMethodId(vid)).toBe(`${vid}#${vid.slice('did:keri:'.length)}`);
  });
});

describe('SovereignKeriVidResolver', () => {
  it('synthesizes a controller document with one method authorized for every signing relationship', async () => {
    const { raw, vid } = freshKey();
    const document = await new SovereignKeriVidResolver().resolve(vid);

    expect(document?.id).toBe(vid);
    expect(document?.verificationMethods).toHaveLength(1);

    const method = document?.verificationMethods[0];
    expect(method?.id).toBe(sovereignVerificationMethodId(vid));
    expect(method?.controller).toBe(vid);
    expect(method?.publicKey).toEqual(raw);
    expect([...(method?.relationships ?? [])].sort()).toEqual([...PROOF_PURPOSES].sort());
    // A key-agreement key never authorizes a signature, so it must not appear.
    expect(method?.relationships.has('keyAgreement' as never)).toBe(false);
  });

  it('knows nothing about any other scheme, a rotated key, or a CESR prefix', async () => {
    const resolver = new SovereignKeriVidResolver();

    expect(await resolver.resolve('did:web:example.com')).toBeNull();
    expect(await resolver.resolve('did:keri:EAbc')).toBeNull();
    expect(await resolver.resolve('')).toBeNull();
  });
});

describe('CompositeVidResolver', () => {
  const answering = (id: string): VidResolver => ({
    resolve: async (vid) => (vid === id ? { id, verificationMethods: [] } : null),
  });

  it('asks each resolver in turn and returns the first answer', async () => {
    const composite = new CompositeVidResolver([answering('did:a'), answering('did:b')]);

    expect(await composite.resolve('did:b')).toEqual({ id: 'did:b', verificationMethods: [] });
    expect(await composite.resolve('did:c')).toBeNull();
  });
});

describe('isProofPurpose', () => {
  it('admits the four signing relationships and nothing else', () => {
    for (const purpose of PROOF_PURPOSES) {
      expect(isProofPurpose(purpose)).toBe(true);
    }

    for (const other of ['keyAgreement', '', undefined, 3, 'Authentication']) {
      expect(isProofPurpose(other)).toBe(false);
    }
  });
});
