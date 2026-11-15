import {
  RUST_ENCRYPTED_ANON_XC20P_1,
  RUST_ENCRYPTED_ANON_XC20P_2,
  RUST_ENCRYPTED_AUTH_P256,
  RUST_ENCRYPTED_AUTH_X25519,
  RUST_INVALID_ANON_P256_EPK_WRONG_POINT,
} from './__tests__/rustVectors';
import {
  ALICE_DID_DOC,
  BOB_SECRETS,
  ENCRYPTED_1PU_X25519_A256CBC,
  ENCRYPTED_ES_P384_A256CBC,
  ENCRYPTED_ES_P521_A256GCM,
  ENCRYPTED_ES_X25519_XC20P,
  ENCRYPTED_PROTECTED_SENDER,
  ENCRYPTED_SIGNED_1PU_P256_A256CBC,
  PLAINTEXT,
} from './__tests__/vectors';
import { type ContentEncryption } from './contentEncryption';
import { parseDidDocument, relationshipKeys } from './didDocument';
import { base64urlDecode, base64urlEncode } from './encoding';
import { DidcommError } from './errors';
import { computeApv, decryptJwe, encryptJwe, type GeneralJwe, isAuthcrypt, parseJwe } from './jwe';
import { generateKeyPair, type KeyCurve, parsePrivateJwk, parsePublicJwk, type PublicJwk } from './jwk';
import { parseJws, verifyJwsSignature } from './jws';

const aliceDoc = parseDidDocument(ALICE_DID_DOC);
const aliceKey = (kid: string): PublicJwk => {
  const key = [
    ...relationshipKeys(aliceDoc, 'keyAgreement'),
    ...relationshipKeys(aliceDoc, 'authentication'),
  ].find((k) => k.id === kid);

  if (!key) {
    throw new Error(`no ${kid}`);
  }

  return key.jwk;
};

const bob = (kid: string) => parsePrivateJwk(BOB_SECRETS.find((secret) => secret.kid === kid));

function decryptAll(vector: Record<string, unknown>, sender?: PublicJwk): Buffer[] {
  const parsed = parseJwe(vector);

  return parsed.recipients.map((recipient) => decryptJwe(parsed, bob(recipient.kid), sender));
}

describe('specification Appendix C.3: every recipient can decrypt', () => {
  it('ECDH-ES + XC20P over X25519 (3 recipients)', () => {
    const parsed = parseJwe(ENCRYPTED_ES_X25519_XC20P);
    const plaintexts = decryptAll(ENCRYPTED_ES_X25519_XC20P);

    expect(parsed.alg).toBe('ECDH-ES+A256KW');
    expect(parsed.enc).toBe('XC20P');
    expect(parsed.epk.crv).toBe('X25519');
    expect(isAuthcrypt(parsed)).toBe(false);
    expect(plaintexts).toHaveLength(3);

    for (const plaintext of plaintexts) {
      // Appendix C.1 prints an https:// type; the encrypted vectors were generated from the http:// one.
      expect(JSON.parse(plaintext.toString())).toEqual({
        ...PLAINTEXT,
        typ: 'application/didcomm-plain+json',
        type: 'http://example.com/protocols/lets_do_lunch/1.0/proposal',
      });
    }
  });

  it('ECDH-ES + A256CBC-HS512 over P-384 (2 recipients)', () => {
    const plaintexts = decryptAll(ENCRYPTED_ES_P384_A256CBC);

    expect(parseJwe(ENCRYPTED_ES_P384_A256CBC).epk.crv).toBe('P-384');
    expect(plaintexts.map((p) => JSON.parse(p.toString()).id)).toEqual(['1234567890', '1234567890']);
  });

  it('ECDH-ES + A256GCM over P-521 (2 recipients)', () => {
    const plaintexts = decryptAll(ENCRYPTED_ES_P521_A256GCM);

    expect(parseJwe(ENCRYPTED_ES_P521_A256GCM).enc).toBe('A256GCM');
    expect(plaintexts).toHaveLength(2);
  });

  it('ECDH-1PU + A256CBC-HS512 over X25519 (authcrypt from Alice, 3 recipients)', () => {
    const parsed = parseJwe(ENCRYPTED_1PU_X25519_A256CBC);
    const plaintexts = decryptAll(ENCRYPTED_1PU_X25519_A256CBC, aliceKey('did:example:alice#key-x25519-1'));

    expect(isAuthcrypt(parsed)).toBe(true);
    expect(parsed.skid).toBe('did:example:alice#key-x25519-1');
    expect(plaintexts).toHaveLength(3);
    expect(JSON.parse(plaintexts[0].toString()).from).toBe('did:example:alice');
  });

  it('sign then ECDH-1PU over P-256: the plaintext is a JWS Alice signed', () => {
    const [plaintext] = decryptAll(
      ENCRYPTED_SIGNED_1PU_P256_A256CBC,
      aliceKey('did:example:alice#key-p256-1'),
    ).slice(0, 1);
    const signed = parseJws(JSON.parse(plaintext.toString()));

    expect(signed.kid).toBe('did:example:alice#key-1');
    expect(verifyJwsSignature(signed, aliceKey('did:example:alice#key-1'))).toBe(true);
  });

  it('anoncrypt around authcrypt around a signature (sender hidden from the outer hop)', () => {
    const outer = parseJwe(ENCRYPTED_PROTECTED_SENDER);

    expect(outer.alg).toBe('ECDH-ES+A256KW');
    expect(outer.enc).toBe('XC20P');
    expect(outer.epk.crv).toBe('P-521');

    const [innerText] = decryptAll(ENCRYPTED_PROTECTED_SENDER).slice(0, 1);
    const inner = parseJwe(JSON.parse(innerText.toString()));

    expect(isAuthcrypt(inner)).toBe(true);
    expect(inner.skid).toBe('did:example:alice#key-p521-1');

    const signedText = decryptJwe(
      inner,
      bob('did:example:bob#key-p521-1'),
      aliceKey('did:example:alice#key-p521-1'),
    );
    const signed = parseJws(JSON.parse(signedText.toString()));

    expect(verifyJwsSignature(signed, aliceKey('did:example:alice#key-1'))).toBe(true);
  });
});

describe('reference implementation vectors (Rust)', () => {
  it.each([
    ['anoncrypt X25519 XC20P', RUST_ENCRYPTED_ANON_XC20P_1, undefined],
    ['anoncrypt P-256 XC20P', RUST_ENCRYPTED_ANON_XC20P_2, undefined],
    ['authcrypt X25519', RUST_ENCRYPTED_AUTH_X25519, 'did:example:alice#key-x25519-1'],
  ])('decrypts %s for each recipient', (_name, vector, senderKid) => {
    const plaintexts = decryptAll(vector, senderKid ? aliceKey(senderKid) : undefined);

    expect(plaintexts.length).toBeGreaterThanOrEqual(2);

    for (const plaintext of plaintexts) {
      expect(JSON.parse(plaintext.toString()).type).toBe(
        'http://example.com/protocols/lets_do_lunch/1.0/proposal',
      );
    }
  });

  it('decrypts authcrypt over P-256, whose plaintext is a signed message, for each recipient', () => {
    const plaintexts = decryptAll(RUST_ENCRYPTED_AUTH_P256, aliceKey('did:example:alice#key-p256-1'));

    expect(plaintexts).toHaveLength(2);

    for (const plaintext of plaintexts) {
      expect(
        verifyJwsSignature(parseJws(JSON.parse(plaintext.toString())), aliceKey('did:example:alice#key-1')),
      ).toBe(true);
    }
  });

  it('refuses the invalid-curve vector: the ephemeral key is not a point on P-256', () => {
    const header = JSON.parse(
      Buffer.from(
        String(RUST_INVALID_ANON_P256_EPK_WRONG_POINT.protected).replace(/=+$/, ''),
        'base64url',
      ).toString(),
    );

    expect(() => parsePublicJwk(header.epk)).toThrow(/valid P-256/);
    // The vector's own header is padded base64 with "apu": null; the point check is what must stop it.
    const repaired = {
      ...RUST_INVALID_ANON_P256_EPK_WRONG_POINT,
      protected: String(RUST_INVALID_ANON_P256_EPK_WRONG_POINT.protected).replace(/=+$/, ''),
    };
    expect(() => parseJwe(repaired)).toThrow(/valid P-256/);
  });
});

describe('round trips', () => {
  const CURVES: KeyCurve[] = ['X25519', 'P-256', 'P-384', 'P-521'];
  const ENCS: ContentEncryption[] = ['A256CBC-HS512', 'A256GCM', 'XC20P'];
  const plaintext = Buffer.from(
    JSON.stringify({ id: '1', type: 'https://x.example/p/1.0/m', body: { n: 1 } }),
  );

  function recipients(curve: KeyCurve, count: number) {
    return Array.from({ length: count }, (_, index) => {
      const pair = generateKeyPair(curve);
      const kid = `did:example:r#k${index}`;

      return { kid, publicJwk: pair.publicJwk, privateJwk: { ...pair.privateJwk, kid } };
    });
  }

  describe.each(CURVES)('anoncrypt over %s', (curve) => {
    it.each(ENCS)('with %s, to three recipients', (enc) => {
      const to = recipients(curve, 3);
      const jwe = encryptJwe({ plaintext, enc, recipients: to });
      const parsed = parseJwe(jwe as unknown as Record<string, unknown>);

      expect(parsed.alg).toBe('ECDH-ES+A256KW');
      expect(parsed.enc).toBe(enc);
      expect(parsed.skid).toBeUndefined();

      for (const recipient of to) {
        expect(decryptJwe(parsed, recipient.privateJwk).equals(plaintext)).toBe(true);
      }
    });
  });

  describe.each(CURVES)('authcrypt over %s', (curve) => {
    it('decrypts only with the real sender key', () => {
      const to = recipients(curve, 2);
      const sender = generateKeyPair(curve);
      const senderKey = { ...sender.privateJwk, kid: 'did:example:s#key-1' };
      const jwe = encryptJwe({ plaintext, enc: 'A256CBC-HS512', recipients: to, sender: senderKey });
      const parsed = parseJwe(jwe as unknown as Record<string, unknown>);

      expect(isAuthcrypt(parsed)).toBe(true);
      expect(parsed.skid).toBe('did:example:s#key-1');
      expect(decryptJwe(parsed, to[0].privateJwk, sender.publicJwk).equals(plaintext)).toBe(true);
      expect(decryptJwe(parsed, to[1].privateJwk, sender.publicJwk).equals(plaintext)).toBe(true);
      expect(() => decryptJwe(parsed, to[0].privateJwk, generateKeyPair(curve).publicJwk)).toThrow(
        'the message could not be decrypted',
      );
      expect(() => decryptJwe(parsed, to[0].privateJwk)).toThrow(DidcommError);
    });
  });

  it('uses a fresh ephemeral key, IV and content key for every message', () => {
    const to = recipients('X25519', 1);
    const a = encryptJwe({ plaintext, enc: 'A256CBC-HS512', recipients: to });
    const b = encryptJwe({ plaintext, enc: 'A256CBC-HS512', recipients: to });

    expect(a.protected).not.toBe(b.protected);
    expect(a.iv).not.toBe(b.iv);
    expect(a.recipients[0].encrypted_key).not.toBe(b.recipients[0].encrypted_key);
  });

  it('writes the header members DIDComm requires, and apv over the sorted recipient kids', () => {
    const to = recipients('P-256', 2);
    const sender = { ...generateKeyPair('P-256').privateJwk, kid: 'did:example:s#key-1' };
    const jwe = encryptJwe({ plaintext, enc: 'A256CBC-HS512', recipients: [to[1], to[0]], sender });
    const header = JSON.parse(Buffer.from(jwe.protected, 'base64url').toString());

    expect(header).toMatchObject({
      typ: 'application/didcomm-encrypted+json',
      alg: 'ECDH-1PU+A256KW',
      enc: 'A256CBC-HS512',
      skid: 'did:example:s#key-1',
      apu: base64urlEncode(Buffer.from('did:example:s#key-1')),
      apv: computeApv([to[0].kid, to[1].kid]),
    });
    expect(header.epk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(computeApv(['b', 'a'])).toBe(computeApv(['a', 'b']));
    expect(jwe.recipients.map((r) => r.header.kid)).toEqual([to[1].kid, to[0].kid]);
  });

  it('refuses invalid encryption requests', () => {
    const x = recipients('X25519', 1);
    const p = recipients('P-256', 1);

    expect(() =>
      encryptJwe({
        plaintext,
        enc: 'A256GCM',
        recipients: x,
        sender: { ...generateKeyPair('X25519').privateJwk, kid: 'did:example:s#k' },
      }),
    ).toThrow(/A256CBC-HS512/);
    expect(() => encryptJwe({ plaintext, enc: 'A256GCM', recipients: [x[0], p[0]] })).toThrow(
      /one key-agreement curve/,
    );
    expect(() => encryptJwe({ plaintext, enc: 'A256GCM', recipients: [] })).toThrow(DidcommError);
    expect(() => encryptJwe({ plaintext, enc: 'A256GCM', recipients: [x[0], x[0]] })).toThrow(/duplicate/);
    expect(() =>
      encryptJwe({
        plaintext,
        enc: 'A256CBC-HS512',
        recipients: p,
        sender: { ...generateKeyPair('X25519').privateJwk, kid: 'did:example:s#k' },
      }),
    ).toThrow(DidcommError);
    expect(() =>
      encryptJwe({
        plaintext,
        enc: 'A256CBC-HS512',
        recipients: p,
        sender: generateKeyPair('P-256').privateJwk,
      }),
    ).toThrow(DidcommError);
  });
});

describe('parseJwe and decryptJwe reject malformed or hostile input', () => {
  const base = ENCRYPTED_1PU_X25519_A256CBC as unknown as GeneralJwe & Record<string, unknown>;
  const header = () =>
    JSON.parse(Buffer.from(base.protected, 'base64url').toString()) as Record<string, unknown>;
  const withHeader = (patch: Record<string, unknown>) => ({
    ...base,
    protected: base64urlEncode(Buffer.from(JSON.stringify({ ...header(), ...patch }))),
  });
  const sender = aliceKey('did:example:alice#key-x25519-1');

  it.each([
    ['unprotected headers', { ...base, unprotected: { x: 1 } }],
    ['an aad member', { ...base, aad: 'AA' }],
    ['the flattened form', { ...base, header: { kid: 'did:example:bob#key-x25519-1' } }],
    ['no recipients', { ...base, recipients: [] }],
    [
      'too many recipients',
      {
        ...base,
        recipients: Array.from({ length: 101 }, (_, i) => ({
          header: { kid: `did:example:b#k${i}` },
          encrypted_key: base.recipients[0].encrypted_key,
        })),
      },
    ],
    [
      'a recipient without a kid',
      { ...base, recipients: [{ encrypted_key: base.recipients[0].encrypted_key }] },
    ],
    [
      'a recipient kid that is a bare DID',
      {
        ...base,
        recipients: [{ header: { kid: 'did:example:bob' }, encrypted_key: base.recipients[0].encrypted_key }],
      },
    ],
    [
      'a short encrypted_key',
      {
        ...base,
        recipients: base.recipients.map((r) => ({ ...r, encrypted_key: r.encrypted_key.slice(8) })),
      },
    ],
    ['duplicate recipients', { ...base, recipients: [base.recipients[0], base.recipients[0]] }],
    ['a recipient list that does not match apv', { ...base, recipients: base.recipients.slice(0, 2) }],
    ['a short iv', { ...base, iv: base.iv.slice(4) }],
    ['a padded tag', { ...base, tag: `${base.tag}=` }],
    ['a protected header that is not JSON', { ...base, protected: 'AAAA' }],
    ['an unsupported key wrap', withHeader({ alg: 'ECDH-ES+A128KW' })],
    ['direct key agreement', withHeader({ alg: 'ECDH-ES' })],
    ['an unsupported enc', withHeader({ enc: 'A128GCM' })],
    ['authcrypt over GCM', withHeader({ enc: 'A256GCM' })],
    ['zip', withHeader({ zip: 'DEF' })],
    ['crit', withHeader({ crit: ['x'] })],
    ['the wrong typ', withHeader({ typ: 'application/didcomm-signed+json' })],
    [
      'an epk that is a private key',
      withHeader({
        epk: {
          kty: 'OKP',
          crv: 'X25519',
          x: 'GFcMopJljf4pLZfch4a_GhTM_YAf6iNI1dWDGyVCaw0',
          d: 'GFcMopJljf4pLZfch4a_GhTM_YAf6iNI1dWDGyVCaw0',
        },
      }),
    ],
    [
      'an epk on a signing curve',
      withHeader({ epk: { kty: 'OKP', crv: 'Ed25519', x: 'GFcMopJljf4pLZfch4a_GhTM_YAf6iNI1dWDGyVCaw0' } }),
    ],
    ['an apv of the wrong size', withHeader({ apv: 'AAAA' })],
    ['authcrypt without apu', withHeader({ apu: undefined })],
    ['skid and apu naming different keys', withHeader({ skid: 'did:example:alice#key-x25519-9' })],
    [
      'a skid that is not a key',
      withHeader({ skid: 'did:example:alice', apu: base64urlEncode(Buffer.from('did:example:alice')) }),
    ],
  ])('parseJwe rejects %s', (_name, value) => {
    expect(() => parseJwe(value as Record<string, unknown>)).toThrow(DidcommError);
  });

  it('refuses authcrypt over GCM on that rule alone, with every length in the message made consistent', () => {
    const anyBytes = (length: number) => base64urlEncode(Buffer.alloc(length, 7));
    const gcm = {
      ...base,
      protected: base64urlEncode(Buffer.from(JSON.stringify({ ...header(), enc: 'A256GCM' }))),
      iv: anyBytes(12),
      tag: anyBytes(16),
      recipients: base.recipients.map((recipient) => ({ ...recipient, encrypted_key: anyBytes(40) })),
    };

    expect(() => parseJwe(gcm)).toThrow(
      expect.objectContaining({
        code: 'unsupported-algorithm',
        message: expect.stringMatching(/requires A256CBC-HS512/),
      }),
    );
    // The same message as anoncrypt (no apu/skid) parses, so it was the pairing that was refused.
    const { apu: _apu, skid: _skid, ...anonHeader } = header();
    expect(() =>
      parseJwe({
        ...gcm,
        protected: base64urlEncode(
          Buffer.from(JSON.stringify({ ...anonHeader, alg: 'ECDH-ES+A256KW', enc: 'A256GCM' })),
        ),
      }),
    ).not.toThrow();
  });

  it('refuses a skid on an anoncrypt message', () => {
    expect(() =>
      parseJwe({
        ...(ENCRYPTED_ES_X25519_XC20P as Record<string, unknown>),
        protected: base64urlEncode(
          Buffer.from(
            JSON.stringify({
              ...JSON.parse(
                Buffer.from(ENCRYPTED_ES_X25519_XC20P.protected as string, 'base64url').toString(),
              ),
              skid: 'did:example:alice#k',
            }),
          ),
        ),
      }),
    ).toThrow(/must not name a sender/);
  });

  it('reads "apu": null on anoncrypt as absent, which is the same key derivation', () => {
    const anon = parseJwe(ENCRYPTED_ES_X25519_XC20P);
    const nullApu = {
      ...ENCRYPTED_ES_X25519_XC20P,
      protected: base64urlEncode(
        Buffer.from(
          JSON.stringify({
            ...JSON.parse(Buffer.from(ENCRYPTED_ES_X25519_XC20P.protected as string, 'base64url').toString()),
            apu: null,
          }),
        ),
      ),
    };

    expect(parseJwe(nullApu).apu).toEqual(anon.apu);
    expect(() => parseJwe(withHeader({ apu: null }))).toThrow(DidcommError);
  });

  describe('decryption failures are all the same error', () => {
    const parsed = () => parseJwe(base);
    const flip = (text: string): string => {
      const bytes = base64urlDecode(text, 'x');
      bytes[0] ^= 1;

      return base64urlEncode(bytes);
    };

    const key = bob('did:example:bob#key-x25519-1');

    it.each([
      [
        'a changed ciphertext',
        () => decryptJwe(parseJwe({ ...base, ciphertext: flip(base.ciphertext) }), key, sender),
      ],
      ['a changed tag', () => decryptJwe(parseJwe({ ...base, tag: flip(base.tag) }), key, sender)],
      ['a changed iv', () => decryptJwe(parseJwe({ ...base, iv: flip(base.iv) }), key, sender)],
      [
        'a changed wrapped key',
        () =>
          decryptJwe(
            parseJwe({
              ...base,
              recipients: base.recipients.map((r, i) =>
                i === 0 ? { ...r, encrypted_key: flip(r.encrypted_key) } : r,
              ),
            }),
            key,
            sender,
          ),
      ],
      [
        "another key presented under a recipient's kid",
        () =>
          decryptJwe(
            parsed(),
            { ...bob('did:example:bob#key-x25519-2'), kid: 'did:example:bob#key-x25519-1' },
            sender,
          ),
      ],
      ['a key the message is not for', () => decryptJwe(parsed(), bob('did:example:bob#key-p256-1'), sender)],
      ['a missing sender key', () => decryptJwe(parsed(), key)],
      ['the wrong sender key', () => decryptJwe(parsed(), key, aliceKey('did:example:alice#key-p256-1'))],
      [
        'a sender key from another identity',
        () => decryptJwe(parsed(), key, generateKeyPair('X25519').publicJwk),
      ],
    ])('%s', (_name, attempt) => {
      expect(attempt).toThrow(DidcommError);
      expect(attempt).toThrow('the message could not be decrypted');
    });

    it('a changed protected header breaks the AAD, so it breaks decryption', () => {
      const tampered = parseJwe(withHeader({ typ: 'application/didcomm-encrypted+JSON' }));

      expect(() => decryptJwe(tampered, key, sender)).toThrow('the message could not be decrypted');
    });
  });
});
