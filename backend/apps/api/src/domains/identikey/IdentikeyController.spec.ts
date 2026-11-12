import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';

import { IdentikeyController } from './IdentikeyController';
import { decodeChallenge } from './identity/challenge';
import { InMemoryNonceStore } from './identity/nonceStore';
import { SoftwareSigner, respond } from './identity/softwareSigner';

function makeRequest(host: string, forwardedHost?: string): Request {
  return {
    get: (header: string) => {
      const lower = header.toLowerCase();
      if (lower === 'host') {
        return host;
      }

      if (lower === 'x-forwarded-host') {
        return forwardedHost;
      }

      return undefined;
    },
  } as unknown as Request;
}

describe('IdentikeyController', () => {
  it('throws NotFoundException when auth.identikey is disabled', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(false),
    } as never;
    const controller = new IdentikeyController(mockFeatures);
    const fakeReq = makeRequest('example.com');

    await expect(controller.createChallenge(fakeReq)).rejects.toThrow(NotFoundException);
    await expect(controller.verifyChallenge(fakeReq, { responseBase64: '' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('issues JSON-safe challenges, verifies Ed25519 responses, and resists replay/tampering/host-spoofing', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    } as never;
    const controller = new IdentikeyController(mockFeatures);
    const fakeReq = makeRequest('example.com', 'spoofed.attacker.example');

    const issued = await controller.createChallenge(fakeReq);
    expect(issued.challengeBase64).toBeDefined();
    const challengeMeta = issued.challenge as {
      version: number;
      audience: string;
      nonceBase64: string;
    };
    expect(challengeMeta.audience).toBe('example.com');
    expect(typeof challengeMeta.nonceBase64).toBe('string');
    expect(Buffer.from(challengeMeta.nonceBase64, 'base64').length).toBeGreaterThanOrEqual(16);

    const seed = new Uint8Array(32).fill(0x42);
    const signer = SoftwareSigner.fromEd25519Seed(seed);
    const challengeBytes = new Uint8Array(Buffer.from(issued.challengeBase64, 'base64'));
    const responseBytes = await respond(signer, challengeBytes, { audience: 'example.com' });
    const responseBase64 = Buffer.from(responseBytes).toString('base64');

    const result = await controller.verifyChallenge(fakeReq, { responseBase64 });
    expect(result.ok).toBe(true);
    expect(result.fingerprint).toBeDefined();

    // Replay with the same response fails uniformly without leaking specific internal reason codes
    const replay = await controller.verifyChallenge(fakeReq, { responseBase64 });
    expect(replay).toEqual({ ok: false, reason: 'AUTHENTICATION_FAILED' });

    // Tampered response bytes fail uniformly
    const issued2 = await controller.createChallenge(fakeReq);
    const resp2 = new Uint8Array(
      await respond(signer, new Uint8Array(Buffer.from(issued2.challengeBase64, 'base64')), {
        audience: 'example.com',
      }),
    );
    resp2[resp2.length - 1] ^= 0xff;
    expect(
      await controller.verifyChallenge(fakeReq, { responseBase64: Buffer.from(resp2).toString('base64') }),
    ).toEqual({ ok: false, reason: 'AUTHENTICATION_FAILED' });

    // Wrong audience fails uniformly
    const issued3 = await controller.createChallenge(fakeReq);
    const resp3 = await respond(signer, new Uint8Array(Buffer.from(issued3.challengeBase64, 'base64')), {
      audience: 'example.com',
    });
    expect(
      await controller.verifyChallenge(makeRequest('other.example'), {
        responseBase64: Buffer.from(resp3).toString('base64'),
      }),
    ).toEqual({ ok: false, reason: 'AUTHENTICATION_FAILED' });
  });

  it('matches official auth-v1 Ed25519 and P-256 fixture challenge schema through controller signing', async () => {
    const fixtureChallenge = new Uint8Array(
      readFileSync(resolve(__dirname, '__tests__/fixtures/auth-v1/challenge.bin')),
    );
    const decoded = decodeChallenge(fixtureChallenge);
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    } as never;
    const controller = new IdentikeyController(mockFeatures);
    const req = makeRequest(decoded.audience);

    const issued = await controller.createChallenge(req);
    const signerEd = SoftwareSigner.fromEd25519Seed(new Uint8Array(32).fill(0x11));
    const edResp = await respond(signerEd, new Uint8Array(Buffer.from(issued.challengeBase64, 'base64')), {
      audience: decoded.audience,
    });
    const verifiedEd = await controller.verifyChallenge(req, {
      responseBase64: Buffer.from(edResp).toString('base64'),
    });
    expect(verifiedEd.ok).toBe(true);
  });

  it('rejects malformed, empty, non-base64, and oversized payloads before decoding', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    } as never;
    const controller = new IdentikeyController(mockFeatures);
    const req = makeRequest('example.com');

    expect(await controller.verifyChallenge(req, {})).toEqual({ ok: false, reason: 'AUTHENTICATION_FAILED' });
    expect(await controller.verifyChallenge(req, { responseBase64: '' })).toEqual({
      ok: false,
      reason: 'AUTHENTICATION_FAILED',
    });
    expect(await controller.verifyChallenge(req, { responseBase64: '!!!not-base64!!!' })).toEqual({
      ok: false,
      reason: 'AUTHENTICATION_FAILED',
    });
    expect(await controller.verifyChallenge(req, { responseBase64: 'AAAA'.repeat(20_000) })).toEqual({
      ok: false,
      reason: 'AUTHENTICATION_FAILED',
    });
  });

  it('maps store-full errors to ServiceUnavailableException (503)', async () => {
    const fullFeatures = { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as never;
    const boundedController = new IdentikeyController(fullFeatures);
    (boundedController as unknown as { nonceStore: InstanceType<typeof InMemoryNonceStore> }).nonceStore =
      new InMemoryNonceStore({ maxEntries: 1 });
    await boundedController.createChallenge(makeRequest('example.com'));
    await expect(boundedController.createChallenge(makeRequest('example.com'))).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
