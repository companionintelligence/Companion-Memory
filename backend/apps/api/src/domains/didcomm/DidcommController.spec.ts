import { NotFoundException } from '@nestjs/common';

import { DidcommAgent } from './agent';
import { DidcommController } from './DidcommController';
import { generateDidKeyIdentity, secretsOf } from './identity';
import { createDidResolver } from './resolver';
import { buildPing } from './trustPing';

describe('DidcommController', () => {
  it('throws NotFoundException when didcomm.messaging is disabled', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(false),
    } as never;
    const controller = new DidcommController(mockFeatures);

    await expect(controller.handleMessage({})).rejects.toThrow(NotFoundException);
  });

  it('unpacks and handles a DIDComm ping message when didcomm.messaging is enabled', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    } as never;
    const controller = new DidcommController(mockFeatures);
    const serverDid = controller.getAgentDid();

    // Alice sends a ping to the controller agent
    const alice = generateDidKeyIdentity();
    const aliceAgent = new DidcommAgent({
      did: alice.did,
      resolver: createDidResolver(),
      secrets: secretsOf(alice),
    });

    const ping = buildPing({ from: alice.did, to: [serverDid] });
    const { packed } = await aliceAgent.pack(ping, { to: serverDid });

    const result = await controller.handleMessage(JSON.parse(packed));

    expect(result.handled).toBe(true);
    expect(result.messageId).toBe(ping.id);
    expect(result.repliesCount).toBe(1);
  });
});
