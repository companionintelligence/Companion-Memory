import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import { InMemoryConsumptionStore } from '@ci/domains/consumption';

import { didKeyIdFor } from '../didKeyId';
import {
  BODY_COMPONENT,
  PEER_SIGNATURE_ALG,
  buildSignatureBase,
  contentDigest,
  formatSignatureParams,
  signSignatureBase,
  type SignatureParams,
} from '../httpSignature';
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

/**
 * A valid signature under ANY keyid, odd ones included. `PeerSignatureService.signOutbound` only ever
 * signs under a thumbprint or the sender's own self-certifying identifier, so it cannot make these; a
 * test that re-labels the keyid of an already signed request proves nothing, because the signature
 * fails whatever the identity layer decides.
 */
function signUnder(keyid: string, rawBody: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const created = Math.floor(Date.now() / 1000);
  const params: SignatureParams = {
    components: ['@method', '@target-uri', BODY_COMPONENT],
    created,
    expires: created + 60,
    keyid,
    alg: PEER_SIGNATURE_ALG,
    nonce: randomBytes(16).toString('base64url'),
  };
  const rawParams = formatSignatureParams(params);
  const base = buildSignatureBase({
    components: params.components,
    method: 'POST',
    targetUri: `${ENDPOINT}/ask`,
    contentDigestHeader: contentDigest(rawBody),
    rawParams,
  });

  return {
    publicJwk: publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
    headers: {
      'signature-input': `ci=${rawParams}`,
      signature: `ci=:${signSignatureBase(base, privateKey).toString('base64')}:`,
      'content-digest': contentDigest(rawBody),
    } as Record<string, string>,
  };
}

function makeController(links: unknown[] = [], askEnabled = true) {
  const portalTokenVerifier = { verifyClaims: jest.fn().mockResolvedValue(IDENTITY) };
  const peerAskService = {
    handle: jest.fn().mockResolvedValue({ askId: 'abc12345', status: 'pending' }),
    result: jest.fn().mockResolvedValue({ askId: 'abc12345', status: 'pending' }),
  };
  const peerLinkService = { findActiveByKeyThumbprint: jest.fn().mockResolvedValue(links) };
  const rateLimitService = { consume: jest.fn(), consumePoll: jest.fn() };
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(askEnabled) };
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

  return { controller, peerAskService, peerLinkService, portalTokenVerifier, featureService };
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
      const { controller, peerAskService, peerLinkService, portalTokenVerifier } = makeController([
        sovereignLink(peer.aid, peer.publicJwk),
      ]);

      await expect(controller.ask('Bearer keri', request(peer.headers, raw), BODY)).resolves.toEqual({
        askId: 'abc12345',
        status: 'pending',
      });
      expect(portalTokenVerifier.verifyClaims).not.toHaveBeenCalled();
      // The link is looked up by the keyid that was SIGNED UNDER, not by anything else on the request.
      expect(peerLinkService.findActiveByKeyThumbprint).toHaveBeenCalledWith(peer.aid);
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
      const eAid = 'did:keri:EAskerSovereignAID_0000000000000000000000000';
      // SIGNED under the E AID, with a link that names it and records the signer's key: the most
      // permissive setup there is. Only the identity layer's refusal of the form is left to stop it.
      const peer = signUnder(eAid, raw);
      const { controller, peerAskService } = makeController([sovereignLink(eAid, peer.publicJwk)]);

      await expect(controller.ask('Bearer keri', request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });
  });

  describe('a did:key peer: no Portal token, a did:key:z6Mk… keyid', () => {
    /** A peer key, its did:key, and the headers a peer signing under that did:key sends. */
    function signDidKey(rawBody: string | undefined, method = 'POST', targetUri = `${ENDPOINT}/ask`) {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
      const did = didKeyIdFor(publicJwk) as string;
      peersConfig.signingKeyJwk = JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid: did });
      const signer = new PeerSignatureService(new InMemoryConsumptionStore(), logger() as never);
      const headers = signer.signOutbound({ method, targetUri, body: rawBody }) as Record<string, string>;
      delete peersConfig.signingKeyJwk;

      return { publicJwk, did, headers };
    }

    function didKeyLink(did: string, peerKeyJwk: Record<string, unknown> | null, peerIssuer = 'did:key') {
      return { peerHandle: 'did-key-peer', peerIssuer, peerSubject: did, peerKeyJwk };
    }

    it('is authenticated by its signature, against the key its link records', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signDidKey(raw);
      expect(peer.headers['signature-input']).toContain(`keyid="${peer.did}"`);
      const { controller, peerAskService, peerLinkService, portalTokenVerifier } = makeController([
        didKeyLink(peer.did, peer.publicJwk),
      ]);

      await expect(controller.ask(undefined, request(peer.headers, raw), BODY)).resolves.toEqual({
        askId: 'abc12345',
        status: 'pending',
      });
      expect(portalTokenVerifier.verifyClaims).not.toHaveBeenCalled();
      // The link is looked up by the keyid that was SIGNED UNDER, not by anything else on the request.
      expect(peerLinkService.findActiveByKeyThumbprint).toHaveBeenCalledWith(peer.did);
      expect(peerAskService.handle).toHaveBeenCalledWith(
        { issuer: 'did:key', subject: peer.did },
        BODY,
        expect.objectContaining({ covered: expect.any(Array) }),
      );
    });

    it('verifies against the key the did:key spells out when its link records none', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signDidKey(raw);
      const { controller, peerAskService } = makeController([didKeyLink(peer.did, null)]);

      await controller.ask('Bearer keri', request(peer.headers, raw), BODY);

      expect(peerAskService.handle).toHaveBeenCalledTimes(1);
    });

    it('authenticates the collect route the same way', async () => {
      const url = '/agent/v1/ask/abc12345';
      const peer = signDidKey(undefined, 'GET', `${ENDPOINT}/ask/abc12345`);
      const { controller, peerAskService } = makeController([didKeyLink(peer.did, null)]);

      await controller.result(undefined, request(peer.headers, undefined, url, 'GET'), 'abc12345');

      expect(peerAskService.result).toHaveBeenCalledWith(
        { issuer: 'did:key', subject: peer.did },
        'abc12345',
      );
    });

    it('refuses a tampered signature', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signDidKey(raw);
      const signature = peer.headers.signature;
      const at = signature.indexOf(':') + 5;
      const flipped = signature[at] === 'A' ? 'B' : 'A';
      const tampered = {
        ...peer.headers,
        signature: `${signature.slice(0, at)}${flipped}${signature.slice(at + 1)}`,
      };
      const { controller, peerAskService } = makeController([didKeyLink(peer.did, null)]);

      await expect(controller.ask(undefined, request(tampered, raw), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });

    it('refuses a body that is not the one that was signed', async () => {
      const peer = signDidKey(JSON.stringify(BODY));
      const other = JSON.stringify({ ...BODY, prompt: 'something else' });
      const { controller, peerAskService } = makeController([didKeyLink(peer.did, null)]);

      await expect(controller.ask(undefined, request(peer.headers, other), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });

    it('refuses a did:key nobody linked', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signDidKey(raw);
      const { controller, peerAskService } = makeController([]);

      await expect(controller.ask(undefined, request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });

    it('refuses a did:key whose link records a different key, rather than trusting the did:key own', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signDidKey(raw);
      const recorded = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<
        string,
        unknown
      >;
      const { controller, peerAskService } = makeController([didKeyLink(peer.did, recorded)]);

      await expect(controller.ask(undefined, request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });

    /**
     * ═══ THE ISSUER IS PART OF THE IDENTITY, IN EVERY DIRECTION ═══
     *
     * A link answers an inbound ask only when its (issuer, subject) is the identity the ask proved. The
     * predicate is `candidate.peerIssuer === identity.issuer && candidate.peerSubject === identity.subject`
     * in `PeerAskController.assertSignature`, and each half has its own cases:
     *
     *   - the ISSUER half: four links that name an identifier under the WRONG issuer, in each direction.
     *     The subject is the identity's own in all four, so they fail only if the issuer half is dropped;
     *   - the SUBJECT half: a link under the RIGHT issuer that names a different subject, for each of the
     *     two bare issuers, with the signer's key recorded so nothing else stops it.
     */
    function signKeri(rawBody: string) {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
      const aid = `did:keri:D${publicJwk.x as string}`;
      peersConfig.signingKeyJwk = JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid: aid });
      const signer = new PeerSignatureService(new InMemoryConsumptionStore(), logger() as never);
      const headers = signer.signOutbound({
        method: 'POST',
        targetUri: `${ENDPOINT}/ask`,
        body: rawBody,
      }) as Record<string, string>;
      delete peersConfig.signingKeyJwk;

      return { publicJwk, aid, headers };
    }

    it('is never answered by a did:keri link naming the same did:key string', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signDidKey(raw);
      const { controller, peerAskService } = makeController([
        didKeyLink(peer.did, peer.publicJwk, 'did:keri'),
        link(peer.publicJwk),
      ]);

      await expect(controller.ask(undefined, request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });

    it('never answers a did:keri request from a did:key link that names the did:keri string', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signKeri(raw);
      const { controller, peerAskService } = makeController([
        didKeyLink(peer.aid, peer.publicJwk, 'did:key'),
      ]);

      await expect(controller.ask(undefined, request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });

    it('never answers a Portal identity from a did:key link that names the Portal subject', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signAs(raw, 'POST', `${ENDPOINT}/ask`);
      const { controller, peerAskService } = makeController([
        didKeyLink(IDENTITY.subject, peer.publicJwk, 'did:key'),
      ]);

      await expect(controller.ask('Bearer t', request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });

    it('never answers a did:key request from a Portal link that names the did:key string', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signDidKey(raw);
      const { controller, peerAskService } = makeController([
        {
          peerHandle: 'portal-peer',
          peerIssuer: IDENTITY.issuer,
          peerSubject: peer.did,
          peerKeyJwk: peer.publicJwk,
        },
      ]);

      await expect(controller.ask(undefined, request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });

    it.each([
      [
        'did:key',
        () =>
          didKeyIdFor(
            generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
          ) as string,
      ],
      [
        'did:keri',
        () =>
          `did:keri:D${(generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as { x: string }).x}`,
      ],
    ])(
      'never answers from a %s link that names a DIFFERENT subject, whatever key it records',
      async (issuer, other) => {
        const raw = JSON.stringify(BODY);
        const peer = signDidKey(raw);
        const { controller, peerAskService } = makeController([didKeyLink(other(), peer.publicJwk, issuer)]);

        await expect(controller.ask(undefined, request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
        expect(peerAskService.handle).not.toHaveBeenCalled();
      },
    );

    it('never verifies a Portal identity against the key a request happens to be signed under', async () => {
      // The bearer token says this is the Portal peer; the link for that peer records NO key; the request
      // is signed under some did:key. Verifying against the key the did:key spells out would let anyone
      // holding a token for that peer sign with a key of their own choosing. Only a self-certifying
      // identity may fall back to the key its identifier spells out.
      const raw = JSON.stringify(BODY);
      const stranger = signDidKey(raw);
      const { controller, peerAskService } = makeController([link({}, { peerKeyJwk: null })]);

      await expect(controller.ask('Bearer t', request(stranger.headers, raw), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });

    it('does answer when the issuer AND the subject both match (the control for the cases above)', async () => {
      const raw = JSON.stringify(BODY);
      const peer = signDidKey(raw);
      const { controller, peerAskService } = makeController([didKeyLink(peer.did, peer.publicJwk)]);

      await controller.ask(undefined, request(peer.headers, raw), BODY);

      expect(peerAskService.handle).toHaveBeenCalledTimes(1);
    });

    it('refuses a did:key keyid in any other form (a DID URL, another key type): no bare signature for those', async () => {
      const raw = JSON.stringify(BODY);
      const x25519 = 'did:key:z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc';
      const own = signDidKey(raw).did;

      for (const odd of [`${own}#${own.slice('did:key:'.length)}`, `${own}?versionId=1`, x25519]) {
        // SIGNED under the odd keyid, with a link that names it and records the signer's key.
        const peer = signUnder(odd, raw);
        const { controller, peerAskService } = makeController([didKeyLink(odd, peer.publicJwk)]);

        await expect(controller.ask(undefined, request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
        expect(peerAskService.handle).not.toHaveBeenCalled();
      }
    });

    describe('the ask feature gates every peer route, whatever the identity', () => {
      it('is dark for a signed did:key ask while the feature is off, and asks for it by name', async () => {
        const raw = JSON.stringify(BODY);
        const peer = signDidKey(raw);
        const { controller, peerAskService, peerLinkService, featureService } = makeController(
          [didKeyLink(peer.did, null)],
          false,
        );

        await expect(controller.ask(undefined, request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        expect(featureService.isFeatureEnabled).toHaveBeenCalledWith('ask');
        expect(peerLinkService.findActiveByKeyThumbprint).not.toHaveBeenCalled();
        expect(peerAskService.handle).not.toHaveBeenCalled();
      });

      it('is dark for a Portal-token ask while the feature is off', async () => {
        const { controller, portalTokenVerifier, peerAskService } = makeController([], false);

        await expect(controller.ask('Bearer t', request({}), BODY)).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        expect(portalTokenVerifier.verifyClaims).not.toHaveBeenCalled();
        expect(peerAskService.handle).not.toHaveBeenCalled();
      });
    });

    it('refuses a signed request that names no identity: a thumbprint keyid and no bearer token', async () => {
      // Only a self-certifying keyid can stand in for the token. A plain thumbprint cannot, and the refusal
      // comes BEFORE any link lookup.
      const raw = JSON.stringify(BODY);
      const peer = signAs(raw, 'POST', `${ENDPOINT}/ask`);
      const { controller, peerLinkService, peerAskService } = makeController([link(peer.publicJwk)]);

      await expect(controller.ask(undefined, request(peer.headers, raw), BODY)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(peerLinkService.findActiveByKeyThumbprint).not.toHaveBeenCalled();
      expect(peerAskService.handle).not.toHaveBeenCalled();
    });

    describe('peers.audience belongs to the Portal-token path, not to this one', () => {
      it('serves a signed did:key ask on a box with no audience bound', async () => {
        delete peersConfig.audience;
        const raw = JSON.stringify(BODY);
        const peer = signDidKey(raw);
        const { controller, peerAskService } = makeController([didKeyLink(peer.did, null)]);

        await controller.ask(undefined, request(peer.headers, raw), BODY);

        expect(peerAskService.handle).toHaveBeenCalledTimes(1);
      });

      it('still refuses a Portal token on that box, as before', async () => {
        delete peersConfig.audience;
        const { controller, peerAskService } = makeController();

        await expect(controller.ask('Bearer t', request({}), BODY)).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        expect(peerAskService.handle).not.toHaveBeenCalled();
      });
    });
  });
});
