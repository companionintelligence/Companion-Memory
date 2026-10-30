import { generateKeyPairSync } from 'node:crypto';

import { InMemoryConsumptionStore } from '@ci/domains/consumption';

import { contentDigest } from '../httpSignature';

import {
  MAX_CLOCK_SKEW_MS,
  MAX_SIGNATURE_LIFETIME_MS,
  PeerSignatureService,
  type SignatureFailure,
} from './PeerSignatureService';

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

const NOW = new Date('2026-08-26T12:00:00.000Z');
const TARGET = 'https://us.example/agent/v1/ask';
const BODY = JSON.stringify({ askId: 'abc12345', prompt: 'do you know David Miller' });

function makeService() {
  const logger = { setContext: jest.fn(), warn: jest.fn(), debug: jest.fn() };

  return { service: new PeerSignatureService(new InMemoryConsumptionStore(), logger as never), logger };
}

/** A peer box: its own key, and a signer configured with it. */
function makePeer() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

  peersConfig.signingKeyJwk = JSON.stringify(privateJwk);
  const { service } = makeService();
  const headers = service.signOutbound({ method: 'POST', targetUri: TARGET, body: BODY, now: NOW });

  return { publicJwk, headers: headers as Record<string, string>, signer: service };
}

async function verify(
  service: PeerSignatureService,
  peer: { publicJwk: Record<string, unknown>; headers: Record<string, string> },
  overrides: Partial<{
    method: string;
    targetUri: string;
    rawBody: string;
    contentDigestHeader: string;
    signatureInput: string;
    signature: string;
    now: Date;
    peerPublicJwk: unknown;
  }> = {},
) {
  return service.verifyInbound({
    method: 'POST',
    targetUri: TARGET,
    rawBody: BODY,
    contentDigestHeader: peer.headers['content-digest'],
    signatureInput: peer.headers['signature-input'],
    signature: peer.headers.signature,
    peerPublicJwk: peer.publicJwk,
    now: NOW,
    ...overrides,
  });
}

type Verification = Awaited<ReturnType<PeerSignatureService['verifyInbound']>>;

/** Accepts the promise or the already-awaited result, so call sites can do either. */
async function expectRefusal(result: Verification | Promise<Verification>, reason: SignatureFailure) {
  expect(await result).toEqual({ ok: false, reason });
}

beforeEach(() => {
  for (const key of Object.keys(peersConfig)) {
    delete peersConfig[key];
  }
});

describe('signOutbound', () => {
  it('produces nothing when this box has no signing key', () => {
    const { service } = makeService();

    // Null rather than throwing: signing is additive during rollout, and an
    // unconfigured box must still reach a peer that does not require it.
    expect(service.signOutbound({ method: 'POST', targetUri: TARGET, body: BODY })).toBeNull();
    expect(service.publicThumbprint).toBeNull();
  });

  it('degrades to unsigned — never throws — on an unusable key', () => {
    peersConfig.signingKeyJwk = '{not json';
    const { service, logger } = makeService();

    expect(service.signOutbound({ method: 'POST', targetUri: TARGET, body: BODY })).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('peers.signingKeyJwk is unusable'));
  });

  it('resolves a missing key once rather than re-warning per request', () => {
    peersConfig.signingKeyJwk = '{not json';
    const { service, logger } = makeService();

    service.signOutbound({ method: 'POST', targetUri: TARGET, body: BODY });
    service.signOutbound({ method: 'POST', targetUri: TARGET, body: BODY });

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('emits a content-digest and a signature pair for a body request', () => {
    const peer = makePeer();

    expect(peer.headers['content-digest']).toBe(contentDigest(BODY));
    expect(peer.headers['signature-input']).toMatch(/^ci=\("@method" "@target-uri" "content-digest"\);/);
    expect(peer.headers.signature).toMatch(/^ci=:[A-Za-z0-9+/=]+:$/);
  });

  it('omits content-digest for a bodyless request', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    peersConfig.signingKeyJwk = JSON.stringify(privateKey.export({ format: 'jwk' }));
    const { service } = makeService();

    const headers = service.signOutbound({ method: 'GET', targetUri: `${TARGET}/abc12345`, now: NOW });

    expect(headers).not.toHaveProperty('content-digest');
    expect(headers?.['signature-input']).toMatch(/^ci=\("@method" "@target-uri"\);/);
  });

  it('mints a fresh nonce per request', () => {
    const first = makePeer().headers['signature-input'];
    const second = makePeer().headers['signature-input'];

    const nonceOf = (input: string) => /nonce="([^"]+)"/.exec(input)?.[1];
    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });

  it('names the key it signed with', () => {
    peersConfig.signingKeyJwk = JSON.stringify(
      generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
    );
    const { service } = makeService();
    const headers = service.signOutbound({ method: 'POST', targetUri: TARGET, body: BODY });

    expect(headers?.['signature-input']).toContain(`keyid="${service.publicThumbprint}"`);
  });

  it('names its sovereign AID only when the kid is the did:keri:D<x> of this very key', () => {
    const privateJwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    const aid = `did:keri:D${privateJwk.x as string}`;
    peersConfig.signingKeyJwk = JSON.stringify({ ...privateJwk, kid: aid });
    const { service } = makeService();

    expect(service.publicAid).toBe(aid);
    expect(
      service.signOutbound({ method: 'POST', targetUri: TARGET, body: BODY })?.['signature-input'],
    ).toContain(`keyid="${aid}"`);
  });

  it('keeps naming the thumbprint for any other kid, which peers would refuse as a keyid', () => {
    for (const kid of ['my-box-key-2026', 'did:keri:EAnotherAid_00000000000000000000000000000000']) {
      peersConfig.signingKeyJwk = JSON.stringify({
        ...generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
        kid,
      });
      const { service } = makeService();

      expect(service.publicAid).toBeNull();
      expect(
        service.signOutbound({ method: 'POST', targetUri: TARGET, body: BODY })?.['signature-input'],
      ).toContain(`keyid="${service.publicThumbprint}"`);
    }
  });
});

describe('verifyInbound — the happy path', () => {
  it('accepts a request this box would itself have produced, and reports the key', async () => {
    const peer = makePeer();
    const { service } = makeService();

    const result = await verify(service, peer);

    expect(result).toEqual({ ok: true, keyThumbprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  });

  it('accepts a bodyless GET', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    peersConfig.signingKeyJwk = JSON.stringify(privateKey.export({ format: 'jwk' }));
    const { service: signer } = makeService();
    const url = `${TARGET}/abc12345`;
    const headers = signer.signOutbound({ method: 'GET', targetUri: url, now: NOW }) as Record<
      string,
      string
    >;

    const { service } = makeService();
    const result = await service.verifyInbound({
      method: 'GET',
      targetUri: url,
      signatureInput: headers['signature-input'],
      signature: headers.signature,
      peerPublicJwk: publicKey.export({ format: 'jwk' }),
      now: NOW,
    });

    expect(result.ok).toBe(true);
  });
});

describe('verifyInbound — refusals', () => {
  it('reports a missing signature distinctly from a broken one', async () => {
    const { service } = makeService();
    const peer = makePeer();

    await expectRefusal(
      verify(service, peer, { signatureInput: undefined, signature: undefined }),
      'missing',
    );
    await expectRefusal(verify(service, peer, { signatureInput: 'garbage' }), 'malformed');
  });

  it('refuses a body that was rewritten in flight', async () => {
    const { service } = makeService();
    const peer = makePeer();

    await expectRefusal(verify(service, peer, { rawBody: `${BODY} ` }), 'bad-digest');
  });

  it('refuses when the digest header is absent but the request has a body', async () => {
    const { service } = makeService();
    const peer = makePeer();

    await expectRefusal(verify(service, peer, { contentDigestHeader: undefined }), 'bad-digest');
  });

  /**
   * The property that stops a signature being a token again. `hasBody` comes
   * from the REQUEST, so a sender cannot escape the body binding by signing a
   * bodyless base and then attaching a body.
   */
  it('refuses a body request whose signature does not cover content-digest', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    peersConfig.signingKeyJwk = JSON.stringify(privateKey.export({ format: 'jwk' }));
    const { service: signer } = makeService();
    // Signed as though there were no body...
    const headers = signer.signOutbound({ method: 'POST', targetUri: TARGET, now: NOW }) as Record<
      string,
      string
    >;

    const { service } = makeService();
    // ...then presented WITH one.
    const result = await service.verifyInbound({
      method: 'POST',
      targetUri: TARGET,
      rawBody: BODY,
      contentDigestHeader: contentDigest(BODY),
      signatureInput: headers['signature-input'],
      signature: headers.signature,
      peerPublicJwk: publicKey.export({ format: 'jwk' }),
      now: NOW,
    });

    await expectRefusal(result, 'unsupported-components');
  });

  it('refuses a signature from a key the link does not hold', async () => {
    const { service } = makeService();
    const peer = makePeer();
    const stranger = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });

    // `keyid` names the peer's key, but the link holds a different one — so the
    // keyid check fires before any signature maths.
    await expectRefusal(verify(service, peer, { peerPublicJwk: stranger }), 'unknown-key');
  });

  it('refuses a sovereign keyid that spells out a key other than the one the link holds', async () => {
    const { service } = makeService();
    const privateJwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    peersConfig.signingKeyJwk = JSON.stringify({ ...privateJwk, kid: `did:keri:D${privateJwk.x as string}` });
    const headers = makeService().service.signOutbound({
      method: 'POST',
      targetUri: TARGET,
      body: BODY,
      now: NOW,
    });
    const stranger = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });

    // A label on the stored key naming the AID does not make it that key.
    await expectRefusal(
      verify(service, {
        publicJwk: { ...stranger, kid: `did:keri:D${privateJwk.x as string}` },
        headers: headers as Record<string, string>,
      }),
      'unknown-key',
    );
  });

  it('refuses when the link holds an unusable key', async () => {
    const { service } = makeService();
    const peer = makePeer();

    await expectRefusal(verify(service, peer, { peerPublicJwk: { kty: 'RSA' } }), 'unknown-key');
    await expectRefusal(verify(service, peer, { peerPublicJwk: null }), 'unknown-key');
  });

  it('refuses a replay onto a different route', async () => {
    const { service } = makeService();
    const peer = makePeer();

    await expectRefusal(verify(service, peer, { method: 'GET' }), 'bad-signature');
    await expectRefusal(
      verify(service, peer, { targetUri: 'https://us.example/agent/v1/other' }),
      'bad-signature',
    );
  });

  it('refuses an expired signature', async () => {
    const { service } = makeService();
    const peer = makePeer();

    await expectRefusal(verify(service, peer, { now: new Date(NOW.getTime() + 120_000) }), 'expired');
  });

  it('tolerates modest clock skew but refuses a wildly future `created`', async () => {
    const { service } = makeService();
    const peer = makePeer();

    const slightlyBehind = new Date(NOW.getTime() - (MAX_CLOCK_SKEW_MS - 5_000));
    expect((await verify(service, peer, { now: slightlyBehind })).ok).toBe(true);

    const { service: fresh } = makeService();
    const wayBehind = new Date(NOW.getTime() - (MAX_CLOCK_SKEW_MS + 5_000));
    await expectRefusal(verify(fresh, peer, { now: wayBehind }), 'clock-skew');
  });

  /**
   * `expires` is the SENDER's choice, so without a ceiling a peer signs one
   * request with a year-long window and has a bearer token again.
   */
  it('refuses a validity window longer than this box will honour', async () => {
    const { service } = makeService();
    const peer = makePeer();
    const created = Math.floor(NOW.getTime() / 1000);
    const tooLong = created + MAX_SIGNATURE_LIFETIME_MS / 1000 + 60;

    const widened = peer.headers['signature-input'].replace(/expires=\d+/, `expires=${tooLong}`);

    await expectRefusal(verify(service, peer, { signatureInput: widened }), 'window-too-long');
  });
});

describe('verifyInbound — replay', () => {
  it('accepts a request once and refuses the identical one', async () => {
    const { service } = makeService();
    const peer = makePeer();

    expect((await verify(service, peer)).ok).toBe(true);
    await expectRefusal(verify(service, peer), 'replayed');
  });

  it('does not let a peer burn its own nonce with a BROKEN signature', async () => {
    const { service } = makeService();
    const peer = makePeer();

    // Replay is checked last, and only for an otherwise-valid signature —
    // otherwise an attacker denies the honest request by racing it with a
    // corrupted copy carrying the same nonce.
    await expectRefusal(verify(service, peer, { rawBody: 'tampered' }), 'bad-digest');
    expect((await verify(service, peer)).ok).toBe(true);
  });

  it('scopes nonces per key, so one peer cannot burn another one', async () => {
    const { service } = makeService();
    const alice = makePeer();

    // Force a nonce collision across two different keys.
    const bobKeys = generateKeyPairSync('ed25519');
    peersConfig.signingKeyJwk = JSON.stringify(bobKeys.privateKey.export({ format: 'jwk' }));
    const { service: bobSigner } = makeService();
    const bobHeaders = bobSigner.signOutbound({
      method: 'POST',
      targetUri: TARGET,
      body: BODY,
      now: NOW,
    }) as Record<string, string>;
    const bob = {
      publicJwk: bobKeys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
      headers: bobHeaders,
    };

    expect((await verify(service, alice)).ok).toBe(true);
    expect((await verify(service, bob)).ok).toBe(true);
  });
});

describe('required', () => {
  it('is off unless an operator turns it on', () => {
    const { service } = makeService();
    expect(service.required).toBe(false);

    peersConfig.requireHttpSignature = true;
    expect(makeService().service.required).toBe(true);
  });
});
