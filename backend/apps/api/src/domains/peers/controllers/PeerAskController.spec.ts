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

  describe('a sovereign peer: no Portal token, a did:keri:D<x> keyid', () => {
    /** A peer key, its self-certifying AID, and the headers a peer signing under that AID sends. */
    function signSovereign(rawBody: string | undefined, method = 'POST', targetUri = `${ENDPOINT}/ask`) {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
      const aid = `did:keri:D${publicJwk.x as string}`;
      peersConfig.signingKeyJwk = JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid: aid });
      const signer = new PeerSignatureService(new InMemoryConsumptionStore(), logger() as never);
      const headers = signer.signOutbound({ method, targetUri, body: rawBody }) as Record<string, string>;
      delete peersConfig.signingKeyJwk;

      return { publicJwk, aid, headers };
    }

    function sovereignLink(aid: string, peerKeyJwk: Record<string, unknown> | null) {
      return { peerHandle: 'sovereign-peer', peerIssuer: 'did:keri', peerSubject: aid, peerKeyJwk };
    }

    it('is authenticated by its signature, against the key its link records', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signSovereign(raw);
      expect(peer.headers['signature-input']).toContain(`keyid="${peer.aid}"`);
      const { controller, peerAskService, portalTokenVerifier } = makeController([
        sovereignLink(peer.aid, peer.publicJwk),
      ]);

      await expect(controller.ask('Bearer keri', request(peer.headers, raw), BODY)).resolves.toEqual({
        askId: 'abc12345',
        status: 'pending',
      });
      expect(portalTokenVerifier.verifyClaims).not.toHaveBeenCalled();
      expect(peerAskService.handle).toHaveBeenCalledWith(
        { issuer: 'did:keri', subject: peer.aid },
        BODY,
        expect.objectContaining({ covered: expect.any(Array) }),
      );
    });

    it('verifies against the key the AID spells out when its link records none', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signSovereign(raw);
      const { controller, peerAskService } = makeController([sovereignLink(peer.aid, null)]);

      await controller.ask(undefined, request(peer.headers, raw), BODY);

      expect(peerAskService.handle).toHaveBeenCalledTimes(1);
    });

    it('refuses a tampered signature', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signSovereign(raw);
      const signature = peer.headers.signature;
      // Flip one character inside the base64 signature, keeping it well-formed.
      const at = signature.indexOf(':') + 5;
      const flipped = signature[at] === 'A' ? 'B' : 'A';
      const tampered = {
        ...peer.headers,
        signature: `${signature.slice(0, at)}${flipped}${signature.slice(at + 1)}`,
      };
      const { controller, peerAskService } = makeController([sovereignLink(peer.aid, null)]);

      await expect(controller.ask('Bearer keri', request(tampered, raw), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });

    it('refuses an AID nobody linked', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signSovereign(raw);
      const { controller, peerAskService } = makeController([]);

      await expect(controller.ask('Bearer keri', request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });

    it("refuses an AID whose link records a different key, rather than trusting the AID's own", async () => {
      const raw = JSON.stringify(BODY);
      const peer = signSovereign(raw);
      const recorded = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<
        string,
        unknown
      >;
      const { controller, peerAskService } = makeController([sovereignLink(peer.aid, recorded)]);

      await expect(controller.ask('Bearer keri', request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });

    it('is never answered by a link the owner made for a Portal identity, even one holding the key', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signSovereign(raw);
      const { controller, peerAskService } = makeController([
        link(peer.publicJwk),
        link({}, { peerKeyJwk: null }),
      ]);

      await expect(controller.ask('Bearer keri', request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });

    it('refuses a did:keri keyid in any other form (a CESR prefix, an E AID): no bare signature for those', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signSovereign(raw);
      const eAid = 'did:keri:EAskerSovereignAID_0000000000000000000000000';
      const headers = {
        ...peer.headers,
        'signature-input': peer.headers['signature-input'].replace(peer.aid, eAid),
      };
      const { controller, peerAskService } = makeController([sovereignLink(eAid, peer.publicJwk)]);

      await expect(controller.ask('Bearer keri', request(headers, raw), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });
  });
});
