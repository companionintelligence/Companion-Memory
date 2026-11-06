import { createFromPrior } from './fromPrior';
import { parseDidDocument, relationshipKeys } from './didDocument';
import { utf8Encode } from './encoding';
import { DidcommError } from './errors';
import { generateDidKeyIdentity, generateDidPeerIdentity, secretsOf } from './identity';
import { encryptJwe } from './jwe';
import { type PrivateJwk, parsePrivateJwk } from './jwk';
import { createJws } from './jws';
import { createMessage, type DidcommMessage } from './message';
import { packEncrypted, packPlaintext, packSigned, unpack } from './pack';
import { createDidResolver, firstOf, StaticDidResolver } from './resolver';
import { InMemorySecretsResolver } from './secrets';
import {
  ALICE_DID_DOC,
  ALICE_SECRETS,
  BOB_DID_DOC,
  BOB_SECRETS,
  ENCRYPTED_1PU_X25519_A256CBC,
  ENCRYPTED_ES_P384_A256CBC,
  ENCRYPTED_ES_P521_A256GCM,
  ENCRYPTED_ES_X25519_XC20P,
  ENCRYPTED_PROTECTED_SENDER,
  ENCRYPTED_SIGNED_1PU_P256_A256CBC,
  PLAINTEXT,
  SIGNED_ES256,
  SIGNED_ES256K,
  SIGNED_EDDSA,
} from './__tests__/vectors';

const aliceDoc = parseDidDocument(ALICE_DID_DOC);
const bobDoc = parseDidDocument(BOB_DID_DOC);
const specResolver = new StaticDidResolver([aliceDoc, bobDoc]);
const didResolver = createDidResolver();
const bobSecrets = new InMemorySecretsResolver(BOB_SECRETS.map(parsePrivateJwk));
const aliceSecrets = new InMemorySecretsResolver(ALICE_SECRETS.map(parsePrivateJwk));
const aliceSecret = (kid: string): PrivateJwk =>
  parsePrivateJwk(ALICE_SECRETS.find((secret) => secret.kid === kid));

/** Between the vectors' created_time (1516269022) and expires_time (1516385931). */
const VECTOR_TIME = 1516300000;
const asBob = { resolver: specResolver, secrets: bobSecrets, now: VECTOR_TIME };
const asAlice = { resolver: specResolver, secrets: aliceSecrets };

/** Authcrypt a plaintext object from Alice's X25519 key to Bob's X25519 keys, bypassing every pack-time check. */
function craftAuthcrypt(plaintext: object, signed = false): string {
  const payload = signed
    ? JSON.stringify(createJws(utf8Encode(JSON.stringify(plaintext)), aliceSecret('did:example:alice#key-1')))
    : JSON.stringify(plaintext);
  const recipients = relationshipKeys(bobDoc, 'keyAgreement')
    .filter((key) => key.jwk.crv === 'X25519')
    .map((key) => ({ kid: key.id, publicJwk: key.jwk }));

  return JSON.stringify(
    encryptJwe({
      plaintext: utf8Encode(payload),
      enc: 'A256CBC-HS512',
      recipients,
      sender: aliceSecret('did:example:alice#key-x25519-1'),
    }),
  );
}

const MESSAGE = {
  id: 'm-1',
  type: 'https://example.com/protocols/lets_do_lunch/1.0/proposal',
  from: 'did:example:alice',
  to: ['did:example:bob'],
  created_time: 1516269022,
  expires_time: 1516385931,
  body: { messagespecificattribute: 'and its value' },
};

describe('unpack: the specification vectors', () => {
  it('anoncrypt (ECDH-ES, XC20P): decrypts, and does not believe the "from" it finds inside', async () => {
    const { message, metadata } = await unpack(JSON.stringify(ENCRYPTED_ES_X25519_XC20P), asBob);

    expect(message.from).toBe('did:example:alice');
    expect(metadata).toMatchObject({
      layers: ['anoncrypt'],
      encrypted: true,
      authenticated: false,
      nonRepudiation: false,
      anonymousSender: true,
      protectedSender: false,
      encAlgs: { anoncrypt: 'XC20P' },
      recipientDid: 'did:example:bob',
    });
    // "from" is a claim in an unauthenticated message; the metadata must not promote it.
    expect(metadata.senderDid).toBeUndefined();
    expect(metadata.recipientKid?.startsWith('did:example:bob#key-x25519-')).toBe(true);
  });

  it.each([
    ['P-384 with A256CBC-HS512', ENCRYPTED_ES_P384_A256CBC, 'A256CBC-HS512'],
    ['P-521 with A256GCM', ENCRYPTED_ES_P521_A256GCM, 'A256GCM'],
  ])('anoncrypt over %s', async (_name, vector, enc) => {
    const { metadata } = await unpack(JSON.stringify(vector), asBob);

    expect(metadata.layers).toEqual(['anoncrypt']);
    expect(metadata.encAlgs.anoncrypt).toBe(enc);
  });

  it('authcrypt (ECDH-1PU, X25519): proves Alice sent it', async () => {
    const { message, metadata } = await unpack(JSON.stringify(ENCRYPTED_1PU_X25519_A256CBC), asBob);

    expect(message.body).toEqual({ messagespecificattribute: 'and its value' });
    expect(metadata).toMatchObject({
      layers: ['authcrypt'],
      authenticated: true,
      nonRepudiation: false,
      anonymousSender: false,
      senderDid: 'did:example:alice',
      senderKid: 'did:example:alice#key-x25519-1',
      encAlgs: { authcrypt: 'A256CBC-HS512' },
    });
  });

  it('sign then authcrypt (P-256): both the sender and the signer are Alice', async () => {
    const { metadata } = await unpack(JSON.stringify(ENCRYPTED_SIGNED_1PU_P256_A256CBC), asBob);

    expect(metadata).toMatchObject({
      layers: ['authcrypt', 'sign'],
      authenticated: true,
      nonRepudiation: true,
      senderDid: 'did:example:alice',
      senderKid: 'did:example:alice#key-p256-1',
      signerKid: 'did:example:alice#key-1',
      signAlg: 'EdDSA',
    });
  });

  it('protected sender: anoncrypt(authcrypt(sign)) is read through all three layers', async () => {
    const { message, metadata } = await unpack(JSON.stringify(ENCRYPTED_PROTECTED_SENDER), asBob);

    expect(message.from).toBe('did:example:alice');
    expect(metadata).toMatchObject({
      layers: ['anoncrypt', 'authcrypt', 'sign'],
      protectedSender: true,
      authenticated: true,
      nonRepudiation: true,
      senderKid: 'did:example:alice#key-p521-1',
      encAlgs: { anoncrypt: 'XC20P', authcrypt: 'A256CBC-HS512' },
    });
  });

  it.each([
    ['EdDSA', SIGNED_EDDSA, 'EdDSA', 'did:example:alice#key-1'],
    ['ES256', SIGNED_ES256, 'ES256', 'did:example:alice#key-2'],
    ['ES256K', SIGNED_ES256K, 'ES256K', 'did:example:alice#key-3'],
  ])(
    "a %s signed message verifies against the sender's authentication key",
    async (_name, vector, alg, kid) => {
      const { message, metadata } = await unpack(JSON.stringify(vector), {
        ...asBob,
        require: { encrypted: false },
      });

      expect(message.id).toBe('1234567890');
      expect(metadata).toMatchObject({
        layers: ['sign'],
        authenticated: true,
        nonRepudiation: true,
        encrypted: false,
        signAlg: alg,
        signerKid: kid,
        senderDid: 'did:example:alice',
      });
    },
  );

  it('refuses unencrypted messages unless told that is acceptable', async () => {
    await expect(unpack(JSON.stringify(SIGNED_EDDSA), asBob)).rejects.toMatchObject({
      code: 'policy-violation',
    });
    await expect(unpack(JSON.stringify(PLAINTEXT), asBob)).rejects.toMatchObject({
      code: 'policy-violation',
    });

    const plain = await unpack(JSON.stringify(PLAINTEXT), { ...asBob, require: { encrypted: false } });

    expect(plain.metadata).toMatchObject({
      layers: [],
      encrypted: false,
      authenticated: false,
      anonymousSender: false,
    });
  });
});

describe('unpack: enforcing what the layers claim', () => {
  const plaintext = { ...MESSAGE, typ: 'application/didcomm-plain+json' };

  it('accepts a correctly built authcrypt message (control)', async () => {
    const { metadata } = await unpack(craftAuthcrypt(plaintext), asBob);

    expect(metadata.senderDid).toBe('did:example:alice');
  });

  it('rejects authcrypt whose "from" names someone else than the sender key', async () => {
    await expect(
      unpack(craftAuthcrypt({ ...plaintext, from: 'did:example:mallory' }), asBob),
    ).rejects.toMatchObject({
      code: 'inconsistent-layers',
    });
  });

  it('rejects authcrypt with no "from" at all', async () => {
    const { from: _from, ...anonymousLooking } = plaintext;

    await expect(unpack(craftAuthcrypt(anonymousLooking), asBob)).rejects.toMatchObject({
      code: 'inconsistent-layers',
    });
  });

  it('rejects a signature whose signer is not the message "from"', async () => {
    const forged = JSON.stringify(
      createJws(
        utf8Encode(JSON.stringify({ ...plaintext, from: 'did:example:bob' })),
        aliceSecret('did:example:alice#key-1'),
      ),
    );

    await expect(unpack(forged, { ...asBob, require: { encrypted: false } })).rejects.toMatchObject({
      code: 'inconsistent-layers',
    });
  });

  it("rejects a signature by a key that the signer's DID does not list under authentication", async () => {
    // Alice's P-256 key-p256-1 is a key-agreement key. It can sign, and the signature verifies, but
    // the DID never authorized it to authenticate Alice.
    const jws = JSON.stringify(
      createJws(utf8Encode(JSON.stringify(plaintext)), aliceSecret('did:example:alice#key-p256-1')),
    );

    await expect(unpack(jws, { ...asBob, require: { encrypted: false } })).rejects.toMatchObject({
      code: 'key-not-found',
    });
  });

  it("rejects authcrypt whose sender key the sender's DID does not list under keyAgreement", async () => {
    const recipients = relationshipKeys(bobDoc, 'keyAgreement')
      .filter((key) => key.jwk.crv === 'Ed25519' || key.jwk.crv === 'X25519')
      .map((key) => ({ kid: key.id, publicJwk: key.jwk }));
    // Alice's Ed25519 key-1 is an authentication key (and not an X25519 key at all).
    const bogus = JSON.stringify(
      encryptJwe({
        plaintext: utf8Encode(JSON.stringify(plaintext)),
        enc: 'A256CBC-HS512',
        recipients,
        sender: { ...aliceSecret('did:example:alice#key-x25519-1'), kid: 'did:example:alice#key-1' },
      }),
    );

    await expect(unpack(bogus, asBob)).rejects.toMatchObject({ code: 'key-not-found' });
  });

  it('rejects a message whose "to" does not list the DID it was decrypted for', async () => {
    const misaddressed = craftAuthcrypt({ ...plaintext, to: ['did:example:carol'] });

    await expect(unpack(misaddressed, asBob)).rejects.toMatchObject({ code: 'inconsistent-layers' });
    await expect(unpack(misaddressed, { ...asBob, allowMisaddressed: true })).resolves.toMatchObject({
      message: { to: ['did:example:carol'] },
    });
  });

  it('rejects nested envelopes the specification forbids', async () => {
    const innerAnon = JSON.stringify(
      encryptJwe({
        plaintext: utf8Encode(JSON.stringify(plaintext)),
        enc: 'A256CBC-HS512',
        recipients: relationshipKeys(bobDoc, 'keyAgreement')
          .filter((key) => key.jwk.crv === 'X25519')
          .map((key) => ({ kid: key.id, publicJwk: key.jwk })),
      }),
    );
    const bobRecipients = relationshipKeys(bobDoc, 'keyAgreement')
      .filter((key) => key.jwk.crv === 'X25519')
      .map((key) => ({ kid: key.id, publicJwk: key.jwk }));
    const anonOfAnon = JSON.stringify(
      encryptJwe({ plaintext: utf8Encode(innerAnon), enc: 'A256CBC-HS512', recipients: bobRecipients }),
    );
    const authOfAnon = JSON.stringify(
      encryptJwe({
        plaintext: utf8Encode(innerAnon),
        enc: 'A256CBC-HS512',
        recipients: bobRecipients,
        sender: aliceSecret('did:example:alice#key-x25519-1'),
      }),
    );
    const signOfSigned = JSON.stringify(
      createJws(utf8Encode(JSON.stringify(SIGNED_EDDSA)), aliceSecret('did:example:alice#key-1')),
    );

    await expect(unpack(anonOfAnon, asBob)).rejects.toMatchObject({ code: 'inconsistent-layers' });
    await expect(unpack(authOfAnon, asBob)).rejects.toMatchObject({ code: 'inconsistent-layers' });
    await expect(unpack(signOfSigned, { ...asBob, require: { encrypted: false } })).rejects.toMatchObject({
      code: 'inconsistent-layers',
    });
  });

  it('refuses a message past its expiry, allowing for clock skew, unless told otherwise', async () => {
    const wire = craftAuthcrypt(plaintext);

    await expect(unpack(wire, { ...asBob, now: 1516385931 + 61 })).rejects.toMatchObject({ code: 'expired' });
    await expect(unpack(wire, { ...asBob, now: 1516385931 + 30 })).resolves.toBeDefined();
    await expect(
      unpack(wire, { ...asBob, now: 1516385931 + 3600, allowExpired: true }),
    ).resolves.toBeDefined();
    await expect(
      unpack(wire, { ...asBob, now: 1516385931 + 61, clockSkewSeconds: 120 }),
    ).resolves.toBeDefined();
  });

  it('enforces the policy on what must have been proven', async () => {
    const anon = JSON.stringify(ENCRYPTED_ES_X25519_XC20P);
    const auth = JSON.stringify(ENCRYPTED_1PU_X25519_A256CBC);

    await expect(unpack(anon, { ...asBob, require: { authenticated: true } })).rejects.toMatchObject({
      code: 'policy-violation',
    });
    await expect(unpack(auth, { ...asBob, require: { authenticated: true } })).resolves.toBeDefined();
    await expect(unpack(auth, { ...asBob, require: { nonRepudiation: true } })).rejects.toMatchObject({
      code: 'policy-violation',
    });
    await expect(
      unpack(JSON.stringify(ENCRYPTED_SIGNED_1PU_P256_A256CBC), {
        ...asBob,
        require: { nonRepudiation: true },
      }),
    ).resolves.toBeDefined();
  });

  it('refuses oversized input before parsing it', async () => {
    await expect(unpack('x'.repeat(2048), { ...asBob, maxBytes: 1024 })).rejects.toMatchObject({
      code: 'too-large',
    });
    await expect(unpack(Buffer.alloc(2048, 0x20), { ...asBob, maxBytes: 1024 })).rejects.toMatchObject({
      code: 'too-large',
    });
  });

  it('says "secret-not-found" when no recipient key is held, and "decryption-failed" when a held one does not open it', async () => {
    const carol = secretsOf(generateDidKeyIdentity());
    const wire = JSON.stringify(ENCRYPTED_1PU_X25519_A256CBC);

    await expect(unpack(wire, { ...asBob, secrets: carol })).rejects.toMatchObject({
      code: 'secret-not-found',
    });

    const tampered = JSON.parse(wire);
    tampered.ciphertext = `${tampered.ciphertext.slice(0, -2)}AA`;

    await expect(unpack(JSON.stringify(tampered), asBob)).rejects.toMatchObject({
      code: 'decryption-failed',
    });
  });

  it.each([
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['an object that is nothing', '{"hello":"world"}'],
    ['an empty object', '{}'],
  ])('rejects input that is %s', async (_name, wire) => {
    await expect(unpack(wire, asBob)).rejects.toBeInstanceOf(DidcommError);
  });

  it('does not recurse forever on nested envelopes', async () => {
    let wire = craftAuthcrypt(plaintext);

    for (let level = 0; level < 6; level += 1) {
      wire = JSON.stringify(
        encryptJwe({
          plaintext: utf8Encode(wire),
          enc: 'A256CBC-HS512',
          recipients: relationshipKeys(bobDoc, 'keyAgreement')
            .filter((key) => key.jwk.crv === 'X25519')
            .map((key) => ({ kid: key.id, publicJwk: key.jwk })),
        }),
      );
    }

    await expect(unpack(wire, asBob)).rejects.toBeInstanceOf(DidcommError);
  });

  it('accepts an already-parsed envelope', async () => {
    await expect(unpack(ENCRYPTED_1PU_X25519_A256CBC, asBob)).resolves.toMatchObject({
      metadata: { authenticated: true },
    });
  });

  it('verifies a from_prior rotation carried by the message, and refuses one that hands over to someone else', async () => {
    const prior = generateDidKeyIdentity();
    const resolver = firstOf(specResolver, didResolver);
    const rotation = (subject: string) =>
      createFromPrior({ subject, issuerKid: prior.signingKid, secrets: secretsOf(prior), now: 1516269022 });

    const accepted = await unpack(
      craftAuthcrypt({ ...MESSAGE, from_prior: await rotation('did:example:alice') }),
      { ...asBob, resolver },
    );

    expect(accepted.metadata.fromPrior).toMatchObject({
      issuer: prior.did,
      subject: 'did:example:alice',
      issuedAt: 1516269022,
      kid: prior.signingKid,
    });

    const handedToSomeoneElse = craftAuthcrypt({
      ...MESSAGE,
      from_prior: await rotation('did:example:mallory'),
    });

    await expect(unpack(handedToSomeoneElse, { ...asBob, resolver })).rejects.toMatchObject({
      code: 'inconsistent-layers',
    });
    // Without a resolver that can see the prior DID the rotation cannot be checked, so the message is refused.
    await expect(
      unpack(craftAuthcrypt({ ...MESSAGE, from_prior: await rotation('did:example:alice') }), asBob),
    ).rejects.toMatchObject({ code: 'did-resolution-failed' });
  });
});

describe('pack then unpack', () => {
  const hello = (from: string, to: string, extra: Partial<DidcommMessage> = {}) =>
    createMessage({
      type: 'https://example.com/protocols/hello/1.0/greeting',
      from,
      to: [to],
      body: { text: 'héllo ✓', n: 1.5, nested: { ok: true } },
      ...extra,
    });

  it('authcrypt between two did:key identities (Ed25519 keys, X25519 derived)', async () => {
    const alice = generateDidKeyIdentity();
    const bob = generateDidKeyIdentity();
    const context = { resolver: didResolver, secrets: secretsOf(alice, bob) };
    const message = hello(alice.did, bob.did);

    const { packed, metadata: packMetadata } = await packEncrypted(message, {
      ...context,
      to: bob.did,
      from: alice.did,
    });
    const received = await unpack(packed, { ...context, now: message.created_time });

    expect(packMetadata).toMatchObject({
      layers: ['authcrypt'],
      enc: 'A256CBC-HS512',
      senderKid: alice.agreementKid,
      recipientKids: [bob.agreementKid],
      skippedKeys: 0,
    });
    expect(received.message).toEqual(message);
    expect(received.metadata).toMatchObject({
      layers: ['authcrypt'],
      authenticated: true,
      senderDid: alice.did,
      recipientKid: bob.agreementKid,
    });
  });

  it('keeps the body byte-for-byte: a signature over it survives the trip', async () => {
    const alice = generateDidKeyIdentity();
    const bob = generateDidKeyIdentity();
    const context = { resolver: didResolver, secrets: secretsOf(alice, bob) };
    const body = JSON.parse('{"z":1,"a":{"y":[3,2,1],"k":"v"},"u":"\\u00e9","f":1.0,"e":1e2}');
    const message = hello(alice.did, bob.did, { body });

    const { packed } = await packEncrypted(message, { ...context, to: bob.did, from: alice.did });
    const { message: received } = await unpack(packed, context);

    expect(JSON.stringify(received.body)).toBe(JSON.stringify(body));
    expect(Object.keys(received.body ?? {})).toEqual(['z', 'a', 'u', 'f', 'e']);
  });

  it('authcrypt between did:peer identities, delivered to the service the recipient publishes', async () => {
    const alice = generateDidPeerIdentity();
    const bob = generateDidPeerIdentity({ uri: 'https://bob.example/didcomm' });
    const context = { resolver: didResolver, secrets: secretsOf(alice, bob) };
    const { packed } = await packEncrypted(hello(alice.did, bob.did), {
      ...context,
      to: bob.did,
      from: alice.did,
    });

    await expect(unpack(packed, context)).resolves.toMatchObject({
      metadata: { senderDid: alice.did, senderKid: alice.agreementKid },
    });
  });

  it('anoncrypt needs no secret of the sender', async () => {
    const bob = generateDidKeyIdentity();
    const resolver = didResolver;
    const { packed, metadata } = await packEncrypted(
      createMessage({ type: 'https://example.com/p/1.0/m', to: [bob.did], body: { x: 1 } }),
      {
        resolver,
        secrets: secretsOf(),
        to: bob.did,
      },
    );

    expect(metadata).toMatchObject({ layers: ['anoncrypt'], senderKid: undefined });
    await expect(unpack(packed, { resolver, secrets: secretsOf(bob) })).resolves.toMatchObject({
      metadata: { anonymousSender: true },
    });
  });

  it('sign then anoncrypt gives non-repudiation while hiding the signature from the wire', async () => {
    const alice = generateDidKeyIdentity();
    const bob = generateDidKeyIdentity();
    const context = { resolver: didResolver, secrets: secretsOf(alice, bob) };
    const { packed, metadata } = await packEncrypted(hello(alice.did, bob.did), {
      ...context,
      to: bob.did,
      signFrom: alice.did,
    });

    expect(metadata.layers).toEqual(['anoncrypt', 'sign']);
    expect(metadata.signerKid).toBe(alice.signingKid);
    expect(packed).not.toContain('signatures');

    const received = await unpack(packed, context);

    expect(received.metadata).toMatchObject({
      layers: ['anoncrypt', 'sign'],
      nonRepudiation: true,
      authenticated: true,
      senderDid: alice.did,
      signAlg: 'EdDSA',
    });
  });

  it('protectSender hides the authcrypt sender key id from the outer envelope', async () => {
    const alice = generateDidKeyIdentity();
    const bob = generateDidKeyIdentity();
    const context = { resolver: didResolver, secrets: secretsOf(alice, bob) };
    const open = await packEncrypted(hello(alice.did, bob.did), { ...context, to: bob.did, from: alice.did });
    const hidden = await packEncrypted(hello(alice.did, bob.did), {
      ...context,
      to: bob.did,
      from: alice.did,
      protectSender: true,
    });
    const outerHeader = (wire: string) => Buffer.from(JSON.parse(wire).protected, 'base64url').toString();

    expect(outerHeader(open.packed)).toContain(alice.agreementKid);
    expect(outerHeader(hidden.packed)).not.toContain('skid');
    expect(outerHeader(hidden.packed)).not.toContain(alice.did);
    expect(hidden.metadata.layers).toEqual(['anoncrypt', 'authcrypt']);

    const received = await unpack(hidden.packed, context);

    expect(received.metadata).toMatchObject({
      protectedSender: true,
      authenticated: true,
      senderDid: alice.did,
    });
  });

  it.each(['A256CBC-HS512', 'A256GCM', 'XC20P'] as const)('anoncrypt with %s', async (enc) => {
    const bob = generateDidKeyIdentity();
    const resolver = didResolver;
    const { packed } = await packEncrypted(
      createMessage({ type: 'https://example.com/p/1.0/m', to: [bob.did] }),
      { resolver, secrets: secretsOf(), to: bob.did, enc },
    );

    await expect(unpack(packed, { resolver, secrets: secretsOf(bob) })).resolves.toMatchObject({
      metadata: { encAlgs: { anoncrypt: enc } },
    });
  });

  it("across the specification's identities: picks the curve both sides have and encrypts for every recipient key on it", async () => {
    const message = { ...MESSAGE, typ: 'application/didcomm-plain+json' };
    const { packed, metadata } = await packEncrypted(message, {
      ...asAlice,
      to: 'did:example:bob',
      from: 'did:example:alice',
    });

    expect(metadata).toMatchObject({
      layers: ['authcrypt'],
      senderKid: 'did:example:alice#key-x25519-1',
      recipientKids: [
        'did:example:bob#key-x25519-1',
        'did:example:bob#key-x25519-2',
        'did:example:bob#key-x25519-3',
      ],
      skippedKeys: 6,
    });
    await expect(unpack(packed, asBob)).resolves.toMatchObject({
      metadata: { senderDid: 'did:example:alice' },
    });

    for (const curve of ['P-256', 'P-521'] as const) {
      const forced = await packEncrypted(message, {
        ...asAlice,
        to: 'did:example:bob',
        from: 'did:example:alice',
        curve,
      });

      expect(
        forced.metadata.recipientKids.every((kid) => kid.includes(curve === 'P-256' ? 'p256' : 'p521')),
      ).toBe(true);
      await expect(unpack(forced.packed, asBob)).resolves.toMatchObject({ message: { id: 'm-1' } });
    }
  });

  it('encrypts to one named key only', async () => {
    const { metadata, packed } = await packEncrypted(MESSAGE, {
      ...asAlice,
      to: 'did:example:bob#key-x25519-2',
      from: 'did:example:alice',
    });

    expect(metadata.recipientKids).toEqual(['did:example:bob#key-x25519-2']);
    await expect(unpack(packed, asBob)).resolves.toMatchObject({
      metadata: { recipientKid: 'did:example:bob#key-x25519-2' },
    });
  });

  it("signs with Alice's authentication key from the DID alone, and with a named one", async () => {
    const byDid = await packSigned(MESSAGE, { ...asAlice, signFrom: 'did:example:alice' });
    const byKid = await packSigned(MESSAGE, { ...asAlice, signFrom: 'did:example:alice#key-2' });

    expect(byDid.metadata.signerKid).toBe('did:example:alice#key-1');
    expect(byKid.metadata.signerKid).toBe('did:example:alice#key-2');
    await expect(unpack(byKid.packed, { ...asBob, require: { encrypted: false } })).resolves.toMatchObject({
      metadata: { signAlg: 'ES256' },
    });
  });

  it('packPlaintext validates and emits JSON', () => {
    expect(JSON.parse(packPlaintext(MESSAGE))).toEqual(MESSAGE);
    expect(() => packPlaintext({ ...MESSAGE, to: [] })).toThrow(DidcommError);
  });
});

describe('packEncrypted refuses to build something inconsistent or weak', () => {
  it.each([
    [
      'authcrypt and a signature together',
      { from: 'did:example:alice', signFrom: 'did:example:alice' },
      'policy-violation',
    ],
    ['protectSender without a sender', { protectSender: true }, 'invalid-argument'],
    ['authcrypt with A256GCM', { from: 'did:example:alice', enc: 'A256GCM' as const }, 'invalid-argument'],
  ])('%s', async (_name, extra, code) => {
    await expect(
      packEncrypted(MESSAGE, { ...asAlice, to: 'did:example:bob', ...extra }),
    ).rejects.toMatchObject({ code });
  });

  it('refuses to authcrypt as a DID whose keys this agent does not hold', async () => {
    const { from: _from, ...withoutFrom } = MESSAGE;

    await expect(
      packEncrypted(withoutFrom, { ...asAlice, to: 'did:example:bob', from: 'did:example:bob' }),
    ).rejects.toMatchObject({ code: 'secret-not-found' });
  });

  it('refuses a message whose "to" omits the recipient, or whose "from" is not the sender', async () => {
    await expect(
      packEncrypted(
        { ...MESSAGE, to: ['did:example:carol'] },
        { ...asAlice, to: 'did:example:bob', from: 'did:example:alice' },
      ),
    ).rejects.toMatchObject({ code: 'inconsistent-layers' });
    await expect(
      packEncrypted(
        { ...MESSAGE, from: 'did:example:mallory' },
        { ...asAlice, to: 'did:example:bob', from: 'did:example:alice' },
      ),
    ).rejects.toMatchObject({ code: 'inconsistent-layers' });
  });

  it('refuses to sign and encrypt a message with no "to", and to sign as someone else', async () => {
    const { to: _to, ...withoutTo } = MESSAGE;

    await expect(
      packEncrypted(withoutTo, { ...asAlice, to: 'did:example:bob', signFrom: 'did:example:alice' }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      packSigned({ ...MESSAGE, from: 'did:example:bob' }, { ...asAlice, signFrom: 'did:example:alice' }),
    ).rejects.toMatchObject({ code: 'inconsistent-layers' });
    await expect(packSigned(withoutTo, { ...asAlice, signFrom: 'did:example:alice' })).resolves.toBeDefined();
    await expect(
      packSigned({ ...withoutTo, from: undefined }, { ...asAlice, signFrom: 'did:example:alice' }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('refuses a recipient with no usable key-agreement key, and one that does not exist', async () => {
    const lonely = generateDidKeyIdentity();
    const aliceOnly = new StaticDidResolver([aliceDoc, parseDidDocument({ id: 'did:example:empty' })]);

    await expect(
      packEncrypted(
        { ...MESSAGE, to: ['did:example:empty'] },
        { resolver: aliceOnly, secrets: secretsOf(lonely), to: 'did:example:empty' },
      ),
    ).rejects.toMatchObject({ code: 'key-not-found' });
    await expect(
      packEncrypted(
        { ...MESSAGE, to: ['did:example:ghost'] },
        { resolver: aliceOnly, secrets: secretsOf(lonely), to: 'did:example:ghost' },
      ),
    ).rejects.toMatchObject({ code: 'did-resolution-failed' });
  });

  it('does not use a secret that is not the key the DID document lists', async () => {
    // A store whose key under Alice\'s kid is some other key must not be used to authcrypt as Alice.
    const impostor = new InMemorySecretsResolver([
      { ...generateDidKeyIdentity().secrets[1], kid: 'did:example:alice#key-x25519-1' },
    ]);

    await expect(
      packEncrypted(MESSAGE, {
        resolver: specResolver,
        secrets: impostor,
        to: 'did:example:bob',
        from: 'did:example:alice',
      }),
    ).rejects.toMatchObject({ code: 'secret-not-found' });
    await expect(
      packSigned(MESSAGE, { resolver: specResolver, secrets: impostor, signFrom: 'did:example:alice' }),
    ).rejects.toMatchObject({ code: 'secret-not-found' });
  });
});
