import { generateKeyPairSync } from 'node:crypto';

import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { didKeyIdFor } from '../didKeyId';
import { newIdentityChallenge, verifyIdentityProof } from '../identityProof';

import { PeerExchangeController } from './PeerExchangeController';

const peersConfig: Record<string, unknown> = {};

jest.mock('@ci/configuration', () => ({
  __esModule: true,
  default: new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'peers') {
          return peersConfig;
        }

        return (jest.requireActual('@ci/configuration').default as Record<string, unknown>)[prop];
      },
    },
  ),
}));

const ENDPOINT = 'https://us.example/api/agent/v1';

function person() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const didKey = didKeyIdFor(publicKey.export({ format: 'jwk' }) as Record<string, unknown>) as string;

  return { userId: 'user-1', didKey, publicJwk: {}, signer: { key: privateKey, keyid: didKey } };
}

function makeController(identities: Array<ReturnType<typeof person>> = [], askEnabled = true) {
  const identityService = {
    findActiveByDidKey: jest.fn(async (didKey: string) => identities.find((i) => i.didKey === didKey) ?? null),
  };
  const rateLimitService = { consumeExchange: jest.fn() };
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(askEnabled) };
  const logger = { setContext: jest.fn(), warn: jest.fn(), log: jest.fn() };
  const controller = new PeerExchangeController(
    identityService as never,
    rateLimitService as never,
    featureService as never,
    logger as never,
  );

  return { controller, identityService, rateLimitService };
}

beforeEach(() => {
  for (const key of Object.keys(peersConfig)) {
    delete peersConfig[key];
  }

  peersConfig.memoryEndpoint = ENDPOINT;
});

describe('GET /agent/v1/identity/:didKey', () => {
  it('proves the key at the published endpoint, for the caller’s challenge', async () => {
    const alice = person();
    const { controller, rateLimitService } = makeController([alice]);
    const challenge = newIdentityChallenge();

    const doc = await controller.identity(alice.didKey, challenge);

    expect(verifyIdentityProof(doc, { didKey: alice.didKey, endpoint: ENDPOINT, challenge })).toBe(true);
    expect(rateLimitService.consumeExchange).toHaveBeenCalledWith({ issuer: 'identity', subject: alice.didKey });
  });

  it('is a 404 for a did:key nobody here holds', async () => {
    const { controller } = makeController([]);

    await expect(controller.identity(person().didKey, newIdentityChallenge())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it.each([undefined, '', 'short', 'x'.repeat(200), 'has space in it and is long enough'])(
    'refuses challenge %j',
    async (challenge) => {
      const alice = person();
      const { controller, identityService } = makeController([alice]);

      await expect(controller.identity(alice.didKey, challenge)).rejects.toBeInstanceOf(BadRequestException);
      expect(identityService.findActiveByDidKey).not.toHaveBeenCalled();
    },
  );

  it('refuses something that is not a did:key before looking anything up', async () => {
    const { controller, identityService } = makeController([]);

    await expect(controller.identity('did:keri:Dabc', newIdentityChallenge())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(identityService.findActiveByDidKey).not.toHaveBeenCalled();
  });

  it('is closed while the ask feature is off', async () => {
    const alice = person();
    const { controller } = makeController([alice], false);

    await expect(controller.identity(alice.didKey, newIdentityChallenge())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('is closed on a box that publishes no endpoint, since every proof names one', async () => {
    delete peersConfig.memoryEndpoint;
    const alice = person();
    const { controller } = makeController([alice]);

    await expect(controller.identity(alice.didKey, newIdentityChallenge())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
