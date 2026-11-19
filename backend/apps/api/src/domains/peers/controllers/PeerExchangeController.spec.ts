import { generateKeyPairSync } from 'node:crypto';

import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { InMemoryConsumptionStore } from '@ci/domains/consumption';

import { didKeyIdFor } from '../didKeyId';
import { newIdentityChallenge, verifyIdentityProof } from '../identityProof';
import { PeerSignatureService } from '../services/PeerSignatureService';

import { PeerExchangeController } from './PeerExchangeController';

// Created on first read: the configuration is read while modules load, before
// this file's own top-level statements run.
const shared = globalThis as { __peerExchangeConfig?: Record<string, unknown> };
const peersConfig: Record<string, unknown> = (shared.__peerExchangeConfig ??= {});

jest.mock('@ci/configuration', () => ({
  __esModule: true,
  default: new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'peers') {
          return ((globalThis as { __peerExchangeConfig?: Record<string, unknown> }).__peerExchangeConfig ??=
            {});
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

function makeController(
  identities: Array<ReturnType<typeof person>> = [],
  askEnabled = true,
  inviteService: Record<string, jest.Mock> = {
    receive: jest.fn().mockResolvedValue({ v: 1, didKey: 'x', name: 'A' }),
  },
) {
  const identityService = {
    findActiveByDidKey: jest.fn(
      async (didKey: string) => identities.find((i) => i.didKey === didKey) ?? null,
    ),
  };
  const rateLimitService = { consumeExchange: jest.fn() };
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(askEnabled) };
  const logger = { setContext: jest.fn(), warn: jest.fn(), log: jest.fn() };
  const signatureService = new PeerSignatureService(new InMemoryConsumptionStore(), logger as never);
  const controller = new PeerExchangeController(
    identityService as never,
    inviteService as never,
    signatureService,
    rateLimitService as never,
    featureService as never,
    logger as never,
  );

  return { controller, identityService, rateLimitService, inviteService };
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
    expect(rateLimitService.consumeExchange).toHaveBeenCalledWith({
      issuer: 'identity',
      subject: alice.didKey,
    });
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

/** A request to `path` signed by `signer`, as `PeerExchangeClient.postSigned` sends it. */
function signedRequest(
  signer: ReturnType<typeof person>,
  path: string,
  body: unknown,
  signedFor = `${ENDPOINT}${path}`,
) {
  const logger = { setContext: jest.fn(), warn: jest.fn() };
  const raw = JSON.stringify(body);
  const headers = new PeerSignatureService(new InMemoryConsumptionStore(), logger as never).signOutbound(
    { method: 'POST', targetUri: signedFor, body: raw },
    signer.signer,
  ) as Record<string, string>;

  return {
    method: 'POST',
    originalUrl: `/agent/v1${path}`,
    url: `/agent/v1${path}`,
    headers: {
      ...headers,
      'content-type': 'application/json',
      'content-length': String(raw.length),
      authorization: 'Bearer keri',
    },
    rawBody: raw,
  } as never;
}

describe('POST /agent/v1/invites/accept', () => {
  it('hands the body to the invite service as from the key that signed it', async () => {
    const bob = person();
    const { controller, inviteService } = makeController();
    const body = { v: 1, didKey: bob.didKey };

    await controller.acceptInvite(signedRequest(bob, '/invites/accept', body));

    expect(inviteService.receive).toHaveBeenCalledWith(bob.didKey, body);
  });

  it('refuses a body that was not the one signed', async () => {
    const bob = person();
    const { controller, inviteService } = makeController();
    const request = signedRequest(bob, '/invites/accept', { v: 1 }) as unknown as { rawBody: string };
    request.rawBody = '{"v":1,"other":true}';

    await expect(controller.acceptInvite(request as never)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(inviteService.receive).not.toHaveBeenCalled();
  });

  it('refuses a signature made for another box’s address', async () => {
    const bob = person();
    const { controller, inviteService } = makeController();

    await expect(
      controller.acceptInvite(
        signedRequest(
          bob,
          '/invites/accept',
          { v: 1 },
          'https://elsewhere.example/api/agent/v1/invites/accept',
        ),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(inviteService.receive).not.toHaveBeenCalled();
  });

  it('refuses an unsigned request', async () => {
    const { controller } = makeController();

    await expect(
      controller.acceptInvite({
        method: 'POST',
        url: '/agent/v1/invites/accept',
        headers: {},
        rawBody: '{}',
      } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a replay of the same signed request', async () => {
    const bob = person();
    const { controller } = makeController();
    const request = signedRequest(bob, '/invites/accept', { v: 1 });

    await controller.acceptInvite(request);
    await expect(controller.acceptInvite(request)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
