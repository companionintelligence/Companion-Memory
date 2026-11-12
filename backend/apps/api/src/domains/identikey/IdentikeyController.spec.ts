import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';

import { IdentikeyController } from './IdentikeyController';
import { SoftwareSigner, respond } from './identity/softwareSigner';

describe('IdentikeyController', () => {
  it('throws NotFoundException when auth.identikey is disabled', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(false),
    } as never;
    const controller = new IdentikeyController(mockFeatures);
    const fakeReq = { get: () => 'example.com' } as unknown as Request;

    await expect(controller.createChallenge(fakeReq)).rejects.toThrow(NotFoundException);
    await expect(controller.verifyChallenge(fakeReq, { responseBase64: '' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('issues and verifies a challenge when auth.identikey is enabled', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    } as never;
    const controller = new IdentikeyController(mockFeatures);
    const fakeReq = { get: () => 'example.com' } as unknown as Request;

    const issued = await controller.createChallenge(fakeReq);
    expect(issued.challengeBase64).toBeDefined();

    // Sign the challenge using SoftwareSigner
    const seed = new Uint8Array(32);
    seed.fill(0x42);
    const signer = SoftwareSigner.fromEd25519Seed(seed);
    const challengeBytes = new Uint8Array(Buffer.from(issued.challengeBase64, 'base64'));

    const responseBytes = await respond(signer, challengeBytes, { audience: 'example.com' });
    const responseBase64 = Buffer.from(responseBytes).toString('base64');

    const result = await controller.verifyChallenge(fakeReq, { responseBase64 });
    expect(result.ok).toBe(true);
    expect(result.fingerprint).toBeDefined();
  });
});
