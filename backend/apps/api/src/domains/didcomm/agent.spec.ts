import { DidcommAgent } from './agent';
import { buildQueries, DISCLOSE_TYPE } from './discoverFeatures';
import { DidcommError } from './errors';
import { generateDidKeyIdentity, generateDidPeerIdentity, secretsOf } from './identity';
import { createMessage, parseMessage } from './message';
import { packEncrypted, packPlaintext, unpack } from './pack';
import { InMemoryReplayGuard } from './replayGuard';
import { createDidResolver } from './resolver';
import { buildPing, PING_RESPONSE_TYPE } from './trustPing';

const resolver = createDidResolver();
const LUNCH = 'https://example.com/protocols/lets_do_lunch/1.0';

function world() {
  const alice = generateDidKeyIdentity(); // a bare did:key: no endpoint, so it can send but cannot be POSTed to
  const bob = generateDidPeerIdentity({ uri: 'https://bob.example/didcomm', accept: ['didcomm/v2'] });
  const aliceAgent = new DidcommAgent({
    did: alice.did,
    resolver,
    secrets: secretsOf(alice),
    replayGuard: new InMemoryReplayGuard(),
  });
  const bobAgent = new DidcommAgent({
    did: bob.did,
    resolver,
    secrets: secretsOf(bob),
    replayGuard: new InMemoryReplayGuard(),
  });

  return { alice, bob, aliceAgent, bobAgent };
}

describe('trust ping through two agents', () => {
  it('sends to the endpoint the recipient publishes, and the recipient answers inside the thread', async () => {
    const { alice, bob, aliceAgent, bobAgent } = world();
    const ping = buildPing({ from: alice.did, to: [bob.did] });
    const delivery = await aliceAgent.send(ping, { to: bob.did });

    expect(delivery.uri).toBe('https://bob.example/didcomm');
    expect(delivery.contentType).toBe('application/didcomm-encrypted+json');

    const received = await bobAgent.receive(delivery.packed);

    expect(received).toMatchObject({
      handled: true,
      skippedReplies: 0,
      metadata: { authenticated: true, senderDid: alice.did, recipientDid: bob.did },
    });
    expect(received.replies).toHaveLength(1);

    const [reply] = received.replies;

    expect(reply.message).toMatchObject({
      type: PING_RESPONSE_TYPE,
      from: bob.did,
      to: [alice.did],
      thid: ping.id,
    });
    // Alice published nothing to POST to, so the reply carries no delivery; it travels on whatever channel Alice opened.
    expect(reply.delivery).toBeUndefined();

    const back = await aliceAgent.receive(reply.packed);

    expect(back).toMatchObject({ handled: true, replies: [], metadata: { senderDid: bob.did } });
  });

  it('sends the answer to an endpoint when the asker has one', async () => {
    const { alice, bob } = world();
    const carol = generateDidPeerIdentity({ uri: 'https://carol.example/in' });
    const carolAgent = new DidcommAgent({ did: carol.did, resolver, secrets: secretsOf(carol) });
    const bobAgent = new DidcommAgent({ did: bob.did, resolver, secrets: secretsOf(bob, alice) });
    const delivery = await carolAgent.send(buildPing({ from: carol.did, to: [bob.did] }), { to: bob.did });
    const { replies } = await bobAgent.receive(delivery.packed);

    expect(replies[0].delivery).toMatchObject({ uri: 'https://carol.example/in', hops: [] });
  });

  it('does not answer a ping that asks for no response', async () => {
    const { alice, bob, aliceAgent, bobAgent } = world();
    const { packed } = await aliceAgent.pack(
      buildPing({ from: alice.did, to: [bob.did], responseRequested: false }),
      { to: bob.did },
    );

    await expect(bobAgent.receive(packed)).resolves.toMatchObject({ handled: true, replies: [] });
  });

  it('handles an anonymous ping but cannot answer it: there is nobody to answer', async () => {
    const { bob, bobAgent } = world();
    const { packed } = await packEncrypted(
      createMessage({
        type: 'https://didcomm.org/trust-ping/2.0/ping',
        to: [bob.did],
        body: { response_requested: true },
      }),
      {
        resolver,
        secrets: secretsOf(),
        to: bob.did,
      },
    );

    await expect(bobAgent.receive(packed)).resolves.toMatchObject({
      handled: true,
      replies: [],
      skippedReplies: 0,
      metadata: { anonymousSender: true },
    });
  });

  it('refuses the same message twice when a replay guard is set, and not otherwise', async () => {
    const { alice, bob, aliceAgent, bobAgent } = world();
    const { packed } = await aliceAgent.pack(buildPing({ from: alice.did, to: [bob.did] }), { to: bob.did });
    const unguarded = new DidcommAgent({ did: bob.did, resolver, secrets: secretsOf(bob) });

    await expect(bobAgent.receive(packed)).resolves.toMatchObject({ handled: true });
    await expect(bobAgent.receive(packed)).rejects.toMatchObject({ code: 'replayed' });
    await expect(unguarded.receive(packed)).resolves.toMatchObject({ handled: true });
    await expect(unguarded.receive(packed)).resolves.toMatchObject({ handled: true });
  });

  it('forgets a message id once its window has passed', async () => {
    const { alice, bob, aliceAgent } = world();
    let now = 1_700_000_000;
    const bobAgent = new DidcommAgent({
      did: bob.did,
      resolver,
      secrets: secretsOf(bob),
      replayGuard: new InMemoryReplayGuard(),
      clock: () => now,
      replayWindowSeconds: 100,
    });
    const { packed } = await aliceAgent.pack(buildPing({ from: alice.did, to: [bob.did] }, now), {
      to: bob.did,
    });

    await bobAgent.receive(packed);
    now += 50;
    await expect(bobAgent.receive(packed)).rejects.toMatchObject({ code: 'replayed' });
    now += 200;
    await expect(bobAgent.receive(packed)).resolves.toMatchObject({ handled: true });
  });
});

describe('discover features', () => {
  it('discloses exactly the registered protocols, to an authenticated asker who matches them', async () => {
    const { alice, bob, aliceAgent, bobAgent } = world();

    bobAgent.register(LUNCH, () => undefined, { roles: ['host'] });

    const query = buildQueries([{ 'feature-type': 'protocol', match: 'https://example.com/*' }], {
      from: alice.did,
      to: [bob.did],
    });
    const { packed } = await aliceAgent.pack(query, { to: bob.did });
    const { replies } = await bobAgent.receive(packed);

    expect(replies).toHaveLength(1);
    expect(replies[0].message).toMatchObject({
      type: DISCLOSE_TYPE,
      thid: query.id,
      body: { disclosures: [{ 'feature-type': 'protocol', id: LUNCH, roles: ['host'] }] },
    });

    const wide = buildQueries([{ 'feature-type': 'protocol', match: '*' }], {
      from: alice.did,
      to: [bob.did],
    });
    const everything = await bobAgent.receive((await aliceAgent.pack(wide, { to: bob.did })).packed);

    const body = everything.replies[0].message.body as { disclosures: Array<{ id: string }> };

    expect(body.disclosures.map((entry) => entry.id)).toEqual([
      'https://didcomm.org/trust-ping/2.0',
      'https://didcomm.org/discover-features/2.0',
      LUNCH,
    ]);
  });

  it('does not answer an anonymous query', async () => {
    const { bob, bobAgent } = world();
    const query = buildQueries([{ 'feature-type': 'protocol', match: '*' }], { to: [bob.did] });
    const { packed } = await packEncrypted(query, { resolver, secrets: secretsOf(), to: bob.did });

    await expect(bobAgent.receive(packed)).resolves.toMatchObject({ handled: true, replies: [] });
  });
});

describe('application protocols', () => {
  it("runs a registered handler with the verified metadata and defaults the reply's sender, recipient and thread", async () => {
    const { alice, bob, aliceAgent, bobAgent } = world();
    const seen: string[] = [];

    bobAgent.register(LUNCH, ({ message, metadata }) => {
      seen.push(`${metadata.senderDid}:${message.type}`);

      return [createMessage({ type: `${LUNCH}/accept`, body: { time: 'noon' } })];
    });

    const proposal = createMessage({
      type: `${LUNCH}/proposal`,
      from: alice.did,
      to: [bob.did],
      body: { where: 'cafe' },
    });
    const { replies } = await bobAgent.receive((await aliceAgent.pack(proposal, { to: bob.did })).packed);

    expect(seen).toEqual([`${alice.did}:${LUNCH}/proposal`]);
    expect(replies[0].message).toMatchObject({
      type: `${LUNCH}/accept`,
      from: bob.did,
      to: [alice.did],
      thid: proposal.id,
      body: { time: 'noon' },
    });

    const accepted = await aliceAgent.receive(replies[0].packed);

    expect(accepted.metadata).toMatchObject({ senderDid: bob.did, authenticated: true });
  });

  it('matches handlers by major version', async () => {
    const { alice, bob, aliceAgent, bobAgent } = world();
    let calls = 0;

    bobAgent.register(LUNCH, () => {
      calls += 1;
    });

    const send = async (type: string) =>
      bobAgent.receive(
        (await aliceAgent.pack(createMessage({ type, from: alice.did, to: [bob.did] }), { to: bob.did }))
          .packed,
      );

    await expect(send('https://example.com/protocols/lets_do_lunch/1.3/proposal')).resolves.toMatchObject({
      handled: true,
    });
    await expect(send('https://example.com/protocols/lets_do_lunch/2.0/proposal')).resolves.toMatchObject({
      handled: false,
    });
    await expect(send('https://example.com/protocols/other/1.0/m')).resolves.toMatchObject({
      handled: false,
      replies: [],
    });
    expect(calls).toBe(1);
  });

  it('lets a handler failure propagate instead of turning it into a reply', async () => {
    const { alice, bob, aliceAgent, bobAgent } = world();

    bobAgent.register(LUNCH, () => {
      throw new Error('database is down');
    });

    const message = createMessage({ type: `${LUNCH}/proposal`, from: alice.did, to: [bob.did] });

    await expect(bobAgent.receive((await aliceAgent.pack(message, { to: bob.did })).packed)).rejects.toThrow(
      'database is down',
    );
  });

  it('hides the sender key id from the outer envelope on request', async () => {
    const { alice, bob, aliceAgent, bobAgent } = world();
    const { packed } = await aliceAgent.pack(buildPing({ from: alice.did, to: [bob.did] }), {
      to: bob.did,
      protectSender: true,
    });

    expect(Buffer.from(JSON.parse(packed).protected, 'base64url').toString()).not.toContain('skid');
    await expect(bobAgent.receive(packed)).resolves.toMatchObject({
      metadata: { protectedSender: true, senderDid: alice.did },
    });
  });
});

describe('what an agent refuses', () => {
  it('unprotected input unless asked to accept it', async () => {
    const { alice, bob, bobAgent } = world();
    const plain = packPlaintext(buildPing({ from: alice.did, to: [bob.did] }));

    await expect(bobAgent.receive(plain)).rejects.toMatchObject({ code: 'policy-violation' });
    await expect(bobAgent.receive(plain, { require: { encrypted: false } })).resolves.toMatchObject({
      handled: true,
      metadata: { encrypted: false, authenticated: false },
    });
  });

  it("a message encrypted to a DID it does not act as, even if it holds that DID's keys", async () => {
    const { alice, bob } = world();
    const confused = new DidcommAgent({ did: alice.did, resolver, secrets: secretsOf(alice, bob) });
    const sender = new DidcommAgent({ did: alice.did, resolver, secrets: secretsOf(alice) });
    const { packed } = await sender.pack(buildPing({ from: alice.did, to: [bob.did] }), { to: bob.did });

    await expect(confused.receive(packed)).rejects.toMatchObject({ code: 'not-authorized' });
  });

  it('to send as any DID but its own', async () => {
    const { alice, bob, aliceAgent } = world();

    await expect(
      aliceAgent.pack(buildPing({ from: bob.did, to: [alice.did] }), { to: bob.did }),
    ).rejects.toBeInstanceOf(DidcommError);
  });

  it('a recipient that publishes no endpoint, when sending (receiving is unaffected)', async () => {
    const { alice, aliceAgent } = world();
    const nobody = generateDidKeyIdentity();
    const message = parseMessage(buildPing({ from: alice.did, to: [nobody.did] }));

    await expect(aliceAgent.send(message, { to: nobody.did })).rejects.toMatchObject({
      code: 'routing-failed',
    });
  });

  it('input that is not an envelope', async () => {
    const { bobAgent } = world();

    await expect(bobAgent.receive('not json')).rejects.toBeInstanceOf(DidcommError);
    await expect(bobAgent.receive(Buffer.from('{}'))).rejects.toBeInstanceOf(DidcommError);
  });
});

describe('disclosures', () => {
  it('start with the two built-in protocols, in registration order', () => {
    const { bobAgent } = world();

    expect(bobAgent.disclosures()).toEqual([
      { 'feature-type': 'protocol', id: 'https://didcomm.org/trust-ping/2.0' },
      { 'feature-type': 'protocol', id: 'https://didcomm.org/discover-features/2.0' },
    ]);
  });
});

describe("unpacking an agent's own output with a third party's eyes", () => {
  it('the envelope reveals nothing about the message but the recipient key ids', async () => {
    const { alice, bob, aliceAgent } = world();
    const { packed } = await aliceAgent.pack(
      createMessage({
        type: `${LUNCH}/proposal`,
        from: alice.did,
        to: [bob.did],
        body: { where: 'a very specific cafe' },
      }),
      { to: bob.did },
    );

    expect(packed).not.toContain('cafe');
    expect(packed).not.toContain(LUNCH);
    expect(JSON.parse(packed).recipients[0].header.kid).toBe(bob.agreementKid);
    await expect(unpack(packed, { resolver, secrets: secretsOf(alice) })).rejects.toMatchObject({
      code: 'secret-not-found',
    });
  });
});
