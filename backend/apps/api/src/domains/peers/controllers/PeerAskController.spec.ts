import { generateKeyPairSync } from 'node:crypto';

import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import { InMemoryConsumptionStore } from '@ci/domains/consumption';

import { PeerSignatureService } from '../services/PeerSignatureService';

import { PeerAskController } from './PeerAskController';

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

const IDENTITY = { issuer: 'https://hub.ci.computer', subject: 'peer-sub-1' };
const ENDPOINT = 'https://us.example/agent/v1';
const BODY = {
  askId: 'abc12345',
  askerHandle: 'them',
  prompt: 'hi',
  request: { archetype: 'relationship', subject: 'X' },
};

/** A peer link as the controller reads it: OIDC identity plus the recorded key. */
function link(publicJwk: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    peerHandle: 'them',
    peerIssuer: IDENTITY.issuer,
    peerSubject: IDENTITY.subject,
    peerKeyJwk: publicJwk,
    ...overrides,
  };
}

function logger() {
  return { setContext: jest.fn(), warn: jest.fn(), log: jest.fn(), debug: jest.fn() };
}

/** A peer key, and the headers a peer holding it would send for this request. */
function signAs(rawBody: string | undefined, method: string, targetUri: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  peersConfig.signingKeyJwk = JSON.stringify(privateKey.export({ format: 'jwk' }));
  const signer = new PeerSignatureService(new InMemoryConsumptionStore(), logger() as never);
  const headers = signer.signOutbound({ method, targetUri, body: rawBody }) as Record<string, string>;
  delete peersConfig.signingKeyJwk;

  return { publicJwk: publicKey.export({ format: 'jwk' }) as Record<string, unknown>, headers };
}

function makeController(links: unknown[] = []) {
  const portalTokenVerifier = { verifyClaims: jest.fn().mockResolvedValue(IDENTITY) };
  const peerAskService = {
    handle: jest.fn().mockResolvedValue({ askId: 'abc12345', status: 'pending' }),
    result: jest.fn().mockResolvedValue({ askId: 'abc12345', status: 'pending' }),
  };
  const peerLinkService = { findActiveByKeyThumbprint: jest.fn().mockResolvedValue(links) };
  const rateLimitService = { consume: jest.fn(), consumePoll: jest.fn() };
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(true) };
  const signatureService = new PeerSignatureService(new InMemoryConsumptionStore(), logger() as never);

  const controller = new PeerAskController(
    portalTokenVerifier as never,
    peerAskService as never,
    peerLinkService as never,
    signatureService as never,
    rateLimitService as never,
    featureService as never,
    logger() as never,
  );

  return { controller, peerAskService, peerLinkService, portalTokenVerifier };
}

function request(headers: Record<string, string>, rawBody?: string, url = '/agent/v1/ask', method = 'POST') {
  return { method, originalUrl: url, url, headers, rawBody } as never;
}

beforeEach(() => {
  for (const key of Object.keys(peersConfig)) {
    delete peersConfig[key];
  }

  peersConfig.audience = 'ci-server-us';
  peersConfig.memoryEndpoint = ENDPOINT;
});

describe('PeerAskController — signatures not required', () => {
  it('accepts an unsigned request, without looking up any key', async () => {
    const { controller, peerAskService, peerLinkService } = makeController();

    await controller.ask('Bearer t', request({}), BODY);

    expect(peerAskService.handle).toHaveBeenCalledTimes(1);
    expect(peerLinkService.findActiveByKeyThumbprint).not.toHaveBeenCalled();
  });

  it('still VERIFIES a signature that is offered', async () => {
    // Honouring an offered signature before requiring one is what lets an
    // operator confirm both sides interoperate before flipping the switch. A
    // broken signature must fail here, or the rollout proves nothing.
    const raw = JSON.stringify(BODY);
    const peer = signAs(raw, 'POST', `${ENDPOINT}/ask`);
    const { controller } = makeController([link(peer.publicJwk)]);

    await expect(
      controller.ask(
        'Bearer t',
        request({ ...peer.headers, 'content-digest': 'sha-256=:bogus:' }, raw),
        BODY,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('PeerAskController — signatures required', () => {
  beforeEach(() => {
    peersConfig.requireHttpSignature = true;
  });

  it('refuses an unsigned request', async () => {
    const { controller, peerAskService } = makeController();

    await expect(controller.ask('Bearer t', request({}), BODY)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(peerAskService.handle).not.toHaveBeenCalled();
  });

  it('accepts a request signed by the key the owner recorded on the link', async () => {
    const raw = JSON.stringify(BODY);
    const peer = signAs(raw, 'POST', `${ENDPOINT}/ask`);
    const { controller, peerAskService } = makeController([link(peer.publicJwk)]);

    await controller.ask('Bearer t', request(peer.headers, raw), BODY);

    expect(peerAskService.handle).toHaveBeenCalledTimes(1);
  });

  it('refuses a signature naming a key no link holds', async () => {
    const raw = JSON.stringify(BODY);
    const peer = signAs(raw, 'POST', `${ENDPOINT}/ask`);
    const { controller } = makeController([]);

    await expect(controller.ask('Bearer t', request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  /**
   * THE BINDING. Peer A's signature must not authorize a request carrying peer
   * B's token: accepting any link that merely holds the key would let two
   * halves of two different identities combine into one neither party holds.
   */
  it('refuses when the key belongs to a different peer than the token', async () => {
    const raw = JSON.stringify(BODY);
    const peer = signAs(raw, 'POST', `${ENDPOINT}/ask`);
    const { controller } = makeController([
      // The link holds the key, but names somebody else.
      link(peer.publicJwk, { peerSubject: 'somebody-else', peerHandle: 'other' }),
    ]);

    await expect(controller.ask('Bearer t', request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses a replay of the very same signed request', async () => {
    const raw = JSON.stringify(BODY);
    const peer = signAs(raw, 'POST', `${ENDPOINT}/ask`);
    const { controller } = makeController([link(peer.publicJwk)]);

    await controller.ask('Bearer t', request(peer.headers, raw), BODY);
    await expect(controller.ask('Bearer t', request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  /**
   * `@target-uri` is a SIGNED component, so whatever this box reconstructs is
   * what the signature is checked against. Building it from `Host` would let a
   * caller pick the authority half of the string.
   */
  it('reconstructs the target from CONFIG, so a spoofed Host cannot match', async () => {
    const raw = JSON.stringify(BODY);
    // The peer signed for evil.example; the box only ever builds its own.
    const peer = signAs(raw, 'POST', 'https://evil.example/agent/v1/ask');
    const { controller } = makeController([link(peer.publicJwk)]);

    await expect(
      controller.ask('Bearer t', request({ ...peer.headers, host: 'evil.example' }, raw), BODY),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses to verify at all when no authority is published to sign against', async () => {
    delete peersConfig.memoryEndpoint;
    const raw = JSON.stringify(BODY);
    const peer = signAs(raw, 'POST', `${ENDPOINT}/ask`);
    const { controller } = makeController([link(peer.publicJwk)]);

    await expect(controller.ask('Bearer t', request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('covers the collect route too, not only the ask route', async () => {
    const url = '/agent/v1/ask/abc12345';
    const peer = signAs(undefined, 'GET', `${ENDPOINT}/ask/abc12345`);
    const { controller } = makeController([link(peer.publicJwk)]);

    await controller.result('Bearer t', request(peer.headers, undefined, url, 'GET'), 'abc12345');

    // And an unsigned collect is refused — a second route with a weaker gate is
    // how the poll endpoint would have become the way in.
    await expect(
      controller.result('Bearer t', request({}, undefined, url, 'GET'), 'abc12345'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('authenticates sovereign KERI peer directly without Portal token', async () => {
    const raw = JSON.stringify(BODY);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pubJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const keriAid = `did:keri:D${pubJwk.x}`;
    const privJwk = { ...privateKey.export({ format: 'jwk' }), kid: keriAid };

    peersConfig.signingKeyJwk = JSON.stringify(privJwk);
    const signer = new PeerSignatureService(new InMemoryConsumptionStore(), logger() as never);
    const headers = signer.signOutbound({ method: 'POST', targetUri: `${ENDPOINT}/ask`, body: raw }) as Record<string, string>;
    delete peersConfig.signingKeyJwk;

    const keriLink = {
      peerHandle: 'sovereign-peer',
      peerIssuer: 'did:keri',
      peerSubject: keriAid,
      peerKeyJwk: pubJwk,
    };

    const { controller, peerAskService, portalTokenVerifier } = makeController([keriLink]);

    const res = await controller.ask('Bearer keri', request(headers, raw), BODY);
    expect(res).toEqual({ askId: 'abc12345', status: 'pending' });
    expect(portalTokenVerifier.verifyClaims).not.toHaveBeenCalled();
    expect(peerAskService.handle).toHaveBeenCalledWith(
      { issuer: 'did:keri', subject: keriAid },
      BODY,
      expect.objectContaining({ covered: expect.any(Array) }),
    );
  });
});
