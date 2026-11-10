import { createDidPeer2 } from './didPeer';
import { DidcommError } from './errors';
import { generateDidKeyIdentity, generateDidPeerIdentity, secretsOf } from './identity';
import { generateKeyPair } from './jwk';
import { createMessage, MEDIA_TYPE, parseMessage } from './message';
import { packEncrypted, unpack } from './pack';
import { createDidResolver, firstOf, StaticDidResolver } from './resolver';
import { buildForwardMessage, FORWARD_TYPE, parseForward, prepareDelivery } from './routing';
import { InMemorySecretsResolver } from './secrets';

const resolver = createDidResolver();

function endpointDid(uri: string, routingKeys?: string[], accept?: string[]) {
  const agreement = generateKeyPair('X25519');
  const signing = generateKeyPair('Ed25519');
  const did = createDidPeer2({
    keys: [
      { purpose: 'keyAgreement', jwk: agreement.publicJwk },
      { purpose: 'authentication', jwk: signing.publicJwk },
    ],
    services: [{ uri, routingKeys, accept }],
  });

  return {
    did,
    agreementKid: `${did}#key-1`,
    signingKid: `${did}#key-2`,
    secrets: [
      { ...agreement.privateJwk, kid: `${did}#key-1` },
      { ...signing.privateJwk, kid: `${did}#key-2` },
    ],
  };
}

describe('forward messages', () => {
  it('builds the routing/2.0 forward the specification shows', () => {
    const forward = buildForwardMessage(
      {
        to: 'did:example:mediator',
        next: 'did:example:bob',
        payload: { ciphertext: 'x' },
        expiresTime: 1700000500,
      },
      1700000000,
    );

    expect(forward).toMatchObject({
      type: FORWARD_TYPE,
      to: ['did:example:mediator'],
      expires_time: 1700000500,
      body: { next: 'did:example:bob' },
    });
    expect(forward.attachments).toHaveLength(1);
    expect(forward.attachments?.[0]).toMatchObject({
      media_type: MEDIA_TYPE.encrypted,
      data: { json: { ciphertext: 'x' } },
    });
  });

  it('parses what it builds, and the base64 attachment form', () => {
    const forward = buildForwardMessage({
      to: 'did:example:m',
      next: 'did:example:bob#key-1',
      payload: { a: 1 },
    });

    expect(parseForward(forward)).toEqual({ next: 'did:example:bob#key-1', payloads: [{ a: 1 }] });

    const encoded = Buffer.from('{"b":2}').toString('base64');

    expect(
      parseForward(parseMessage({ ...forward, attachments: [{ id: 'x', data: { base64: encoded } }] }))
        .payloads,
    ).toEqual([{ b: 2 }]);
  });

  it.each([
    ['another message type', { type: 'https://didcomm.org/trust-ping/2.0/ping' }],
    ['no next', { body: {} }],
    ['a next that is not a DID', { body: { next: 'bob' } }],
    ['no attachments', { attachments: undefined }],
    ['an attachment without an envelope', { attachments: [{ id: 'x', data: { hash: 'QmHash' } }] }],
    [
      'an attachment that is not JSON',
      { attachments: [{ id: 'x', data: { base64: Buffer.from('nope').toString('base64') } }] },
    ],
  ])('rejects a forward with %s', (_name, overrides) => {
    const good = buildForwardMessage({ to: 'did:example:m', next: 'did:example:bob', payload: { a: 1 } });
    const bad = { ...good, ...overrides } as Record<string, unknown>;

    for (const key of Object.keys(bad)) {
      if (bad[key] === undefined) {
        delete bad[key];
      }
    }

    expect(() => parseForward(parseMessage(bad))).toThrow(DidcommError);
  });
});

describe('prepareDelivery', () => {
  it('delivers straight to a URL endpoint when there are no routing keys', async () => {
    const sender = generateDidKeyIdentity();
    const recipient = endpointDid('https://recipient.example/didcomm');
    const secrets = secretsOf(sender);
    const { packed } = await packEncrypted(
      createMessage({ type: 'https://example.com/p/1.0/m', from: sender.did, to: [recipient.did] }),
      { resolver, secrets, to: recipient.did, from: sender.did },
    );

    const delivery = await prepareDelivery(packed, { resolver, secrets, to: recipient.did });

    expect(delivery).toEqual({
      uri: 'https://recipient.example/didcomm',
      packed,
      contentType: 'application/didcomm-encrypted+json',
      hops: [],
      endpointId: `${recipient.did}#service`,
    });
  });

  it('wraps a message for a recipient behind a mediator DID and one more routing key, and each hop can unwrap only its own layer', async () => {
    const sender = generateDidKeyIdentity();
    const m1 = endpointDid('https://m1.example/inbox');
    const m2 = generateDidKeyIdentity();
    const recipient = endpointDid(m1.did, [m2.agreementKid]);
    const message = createMessage({
      type: 'https://example.com/p/1.0/m',
      from: sender.did,
      to: [recipient.did],
      body: { secret: 'for the recipient only' },
    });
    const { packed } = await packEncrypted(message, {
      resolver,
      secrets: secretsOf(sender),
      to: recipient.did,
      from: sender.did,
    });
    const createdAt = message.created_time as number;
    const delivery = await prepareDelivery(packed, {
      resolver,
      secrets: secretsOf(sender),
      to: recipient.did,
      expiresTime: createdAt + 600,
    });

    expect(delivery.uri).toBe('https://m1.example/inbox');
    expect(delivery.hops).toEqual([m1.did, m2.agreementKid]);
    expect(delivery.packed).not.toContain('for the recipient only');

    const mediator1 = new InMemorySecretsResolver(m1.secrets);
    const mediator2 = secretsOf(m2);
    const recipientStore = new InMemorySecretsResolver(recipient.secrets);

    // Hop 1: the mediator behind the recipient's service URI.
    const first = await unpack(delivery.packed, {
      resolver,
      secrets: mediator1,
      require: { encrypted: true },
    });
    const hop1 = parseForward(first.message);

    expect(first.metadata.layers).toEqual(['anoncrypt']);
    expect(first.message.expires_time).toBe(createdAt + 600);
    expect(hop1.next).toBe(m2.agreementKid);

    // Hop 2: the mediator named by the recipient's routing key.
    const second = await unpack(hop1.payloads[0], { resolver, secrets: mediator2 });
    const hop2 = parseForward(second.message);

    expect(hop2.next).toBe(recipient.did);

    // The recipient finally gets the original, authenticated, unchanged.
    const final = await unpack(hop2.payloads[0], { resolver, secrets: recipientStore });

    expect(final.message).toEqual(message);
    expect(final.metadata).toMatchObject({ authenticated: true, senderDid: sender.did });

    // A mediator cannot open the recipient's layer, nor the other mediator's.
    await expect(unpack(hop1.payloads[0], { resolver, secrets: mediator1 })).rejects.toMatchObject({
      code: 'secret-not-found',
    });
    await expect(unpack(hop2.payloads[0], { resolver, secrets: mediator2 })).rejects.toMatchObject({
      code: 'secret-not-found',
    });
  });

  it('uses only the routing keys when the endpoint is a plain URL', async () => {
    const sender = generateDidKeyIdentity();
    const m = generateDidKeyIdentity();
    const recipient = endpointDid('https://recipient.example/in', [m.agreementKid]);
    const secrets = secretsOf(sender);
    const { packed } = await packEncrypted(
      createMessage({ type: 'https://example.com/p/1.0/m', from: sender.did, to: [recipient.did] }),
      { resolver, secrets, to: recipient.did, from: sender.did },
    );

    const delivery = await prepareDelivery(packed, { resolver, secrets, to: recipient.did });

    expect(delivery.uri).toBe('https://recipient.example/in');
    expect(delivery.hops).toEqual([m.agreementKid]);
  });

  it('refuses endpoints it should not send to', async () => {
    const sender = generateDidKeyIdentity();
    const secrets = secretsOf(sender);
    const pack = async (to: string) =>
      (
        await packEncrypted(
          createMessage({ type: 'https://example.com/p/1.0/m', from: sender.did, to: [to] }),
          { resolver, secrets, to, from: sender.did },
        )
      ).packed;

    const plainHttp = endpointDid('http://recipient.example/in');
    await expect(
      prepareDelivery(await pack(plainHttp.did), { resolver, secrets, to: plainHttp.did }),
    ).rejects.toMatchObject({ code: 'routing-failed' });
    await expect(
      prepareDelivery(await pack(plainHttp.did), {
        resolver,
        secrets,
        to: plainHttp.did,
        allowedSchemes: ['http:', 'https:'],
      }),
    ).resolves.toMatchObject({ uri: 'http://recipient.example/in' });

    const credentials = endpointDid('https://user:pw@recipient.example/in');
    await expect(
      prepareDelivery(await pack(credentials.did), { resolver, secrets, to: credentials.did }),
    ).rejects.toMatchObject({ code: 'routing-failed' });

    const ftp = endpointDid('ftp://recipient.example/in');
    await expect(
      prepareDelivery(await pack(ftp.did), { resolver, secrets, to: ftp.did }),
    ).rejects.toMatchObject({ code: 'routing-failed' });

    const notAUrl = endpointDid('not a url');
    await expect(
      prepareDelivery(await pack(notAUrl.did), { resolver, secrets, to: notAUrl.did }),
    ).rejects.toMatchObject({ code: 'routing-failed' });
  });

  it('skips an endpoint that does not accept didcomm/v2, and fails when none does', async () => {
    const sender = generateDidKeyIdentity();
    const secrets = secretsOf(sender);
    const legacy = endpointDid('https://legacy.example/in', undefined, ['didcomm/aip2;env=rfc587']);
    const { packed } = await packEncrypted(
      createMessage({ type: 'https://example.com/p/1.0/m', from: sender.did, to: [legacy.did] }),
      { resolver, secrets, to: legacy.did, from: sender.did },
    );

    await expect(prepareDelivery(packed, { resolver, secrets, to: legacy.did })).rejects.toThrow(
      /publishes no DIDCommMessaging endpoint/,
    );

    const modern = endpointDid('https://modern.example/in', undefined, ['didcomm/v2']);
    const modernPacked = (
      await packEncrypted(
        createMessage({ type: 'https://example.com/p/1.0/m', from: sender.did, to: [modern.did] }),
        { resolver, secrets, to: modern.did, from: sender.did },
      )
    ).packed;

    await expect(prepareDelivery(modernPacked, { resolver, secrets, to: modern.did })).resolves.toMatchObject(
      { uri: 'https://modern.example/in' },
    );
  });

  it('refuses a mediator DID that publishes no URL endpoint, and a recipient with no endpoint at all', async () => {
    const sender = generateDidKeyIdentity();
    const secrets = secretsOf(sender);
    const bareMediator = generateDidKeyIdentity();
    const behindBare = endpointDid(bareMediator.did);
    const noService = generateDidPeerIdentity();

    for (const recipient of [behindBare, noService]) {
      const { packed } = await packEncrypted(
        createMessage({ type: 'https://example.com/p/1.0/m', from: sender.did, to: [recipient.did] }),
        { resolver, secrets, to: recipient.did, from: sender.did },
      );

      await expect(prepareDelivery(packed, { resolver, secrets, to: recipient.did })).rejects.toMatchObject({
        code: 'routing-failed',
      });
    }
  });

  it('resolves through a pinned document table in front of the network', async () => {
    const sender = generateDidKeyIdentity();
    const secrets = secretsOf(sender);
    const recipient = endpointDid('https://recipient.example/in');
    const chained = firstOf(new StaticDidResolver([]), resolver);
    const { packed } = await packEncrypted(
      createMessage({ type: 'https://example.com/p/1.0/m', from: sender.did, to: [recipient.did] }),
      { resolver: chained, secrets, to: recipient.did, from: sender.did },
    );

    await expect(
      prepareDelivery(packed, { resolver: chained, secrets, to: recipient.did }),
    ).resolves.toMatchObject({ uri: 'https://recipient.example/in' });
  });
});
