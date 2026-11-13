import { NotFoundException } from '@nestjs/common';

import { DidcommAgent } from './agent';
import { DidcommController } from './DidcommController';
import { DISCOVER_FEATURES_PROTOCOL, DISCLOSE_TYPE, QUERIES_TYPE } from './discoverFeatures';
import { generateDidKeyIdentity, secretsOf } from './identity';
import { createMessage } from './message';
import { createDidResolver } from './resolver';
import { buildPing, PING_RESPONSE_TYPE, TRUST_PING_PROTOCOL } from './trustPing';

describe('DidcommController', () => {
  it('throws NotFoundException on both GET /didcomm/did and POST /didcomm/message when disabled', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(false),
    } as never;
    const controller = new DidcommController(mockFeatures);

    await expect(controller.getDid()).rejects.toThrow(NotFoundException);
    await expect(controller.handleMessage({})).rejects.toThrow(NotFoundException);
  });

  it('exposes agent did:peer, unpacks encrypted Trust Ping, returns decryptable pong reply, and blocks replays', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    } as never;
    const controller = new DidcommController(mockFeatures);
    const { did: serverDid } = await controller.getDid();
    expect(serverDid).toMatch(/^did:peer:2\./);

    const alice = generateDidKeyIdentity();
    const aliceAgent = new DidcommAgent({
      did: alice.did,
      resolver: createDidResolver(),
      secrets: secretsOf(alice),
    });

    const ping = buildPing({ from: alice.did, to: [serverDid] });
    const { packed } = await aliceAgent.pack(ping, { to: serverDid });
    const envelope = JSON.parse(packed) as Record<string, unknown>;

    const result = await controller.handleMessage(envelope);
    expect(result.handled).toBe(true);
    expect(result.messageId).toBe(ping.id);
    expect(result.repliesCount).toBe(1);
    expect(result.replies).toHaveLength(1);
    expect(result.replies![0]!.to).toBe(alice.did);
    expect(result.replies![0]!.type).toBe(PING_RESPONSE_TYPE);

    // Alice decrypts and verifies the encrypted pong reply returned by the controller
    const pongResult = await aliceAgent.receive(result.replies![0]!.packed);
    expect(pongResult.message.type).toBe(PING_RESPONSE_TYPE);
    expect(pongResult.message.thid).toBe(ping.id);
    expect(pongResult.metadata.authenticated).toBe(true);
    expect(pongResult.metadata.senderDid).toBe(serverDid);

    // Replaying the exact same encrypted envelope fails closed via InMemoryReplayGuard
    const replayResult = await controller.handleMessage(envelope);
    expect(replayResult.handled).toBe(false);
    expect(replayResult.error).toMatch(/already received/i);
  });

  it('responds to Discover Features 2.0 queries and fails safely on malformed payloads', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    } as never;
    const controller = new DidcommController(mockFeatures);
    const { did: serverDid } = await controller.getDid();

    const alice = generateDidKeyIdentity();
    const aliceAgent = new DidcommAgent({
      did: alice.did,
      resolver: createDidResolver(),
      secrets: secretsOf(alice),
    });

    const query = createMessage({
      type: QUERIES_TYPE,
      from: alice.did,
      to: [serverDid],
      body: { queries: [{ 'feature-type': 'protocol', match: 'https://didcomm.org/*' }] },
    });
    const { packed } = await aliceAgent.pack(query, { to: serverDid });
    const result = await controller.handleMessage(JSON.parse(packed));

    expect(result.handled).toBe(true);
    expect(result.replies![0]!.type).toBe(DISCLOSE_TYPE);

    const disclosed = await aliceAgent.receive(result.replies![0]!.packed);
    const disclosures = (disclosed.message.body as { disclosures: Array<{ id: string }> }).disclosures.map(
      (d) => d.id,
    );
    expect(disclosures).toContain(TRUST_PING_PROTOCOL);
    expect(disclosures).toContain(DISCOVER_FEATURES_PROTOCOL);

    // Malformed / unparseable envelopes do not throw unhandled errors
    const malformed = await controller.handleMessage('not-json');
    expect(malformed.handled).toBe(false);
    expect(malformed.error).toBeDefined();
  });
});
