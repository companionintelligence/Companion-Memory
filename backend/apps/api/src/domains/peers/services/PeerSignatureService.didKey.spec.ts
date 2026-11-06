import { generateKeyPairSync } from 'node:crypto';

import { InMemoryConsumptionStore } from '@ci/domains/consumption';

import { didKeyIdFor } from '../didKeyId';

import { PeerSignatureService } from './PeerSignatureService';

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

  return new PeerSignatureService(new InMemoryConsumptionStore(), logger as never);
}

/** A peer box whose signing key carries `kid` (or none), and the headers it would send. */
function makePeer(kid?: (publicJwk: Record<string, unknown>) => string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

  peersConfig.signingKeyJwk = JSON.stringify(kid ? { ...privateJwk, kid: kid(publicJwk) } : privateJwk);
  const signer = makeService();
  const headers = signer.signOutbound({ method: 'POST', targetUri: TARGET, body: BODY, now: NOW });
  delete peersConfig.signingKeyJwk;

  return { publicJwk, headers: headers as Record<string, string>, signer };
}

function verify(
  service: PeerSignatureService,
  peer: { publicJwk: Record<string, unknown>; headers: Record<string, string> },
  peerPublicJwk: unknown = peer.publicJwk,
) {
  return service.verifyInbound({
    method: 'POST',
    targetUri: TARGET,
    rawBody: BODY,
    contentDigestHeader: peer.headers['content-digest'],
    signatureInput: peer.headers['signature-input'],
    signature: peer.headers.signature,
    peerPublicJwk,
    now: NOW,
  });
}

beforeEach(() => {
  for (const key of Object.keys(peersConfig)) {
    delete peersConfig[key];
  }
});

describe('PeerSignatureService — a did:key keyid', () => {
  it('signs under the did:key only when the kid is the did:key of this very key', () => {
    const peer = makePeer((jwk) => didKeyIdFor(jwk) as string);
    const did = didKeyIdFor(peer.publicJwk) as string;

    expect(peer.headers['signature-input']).toContain(`keyid="${did}"`);
    // A did:key is not a KERI AID, and must not be published as one.
    expect(peer.signer.publicAid).toBeNull();
  });

  it("keeps naming the thumbprint when the kid is another key's did:key", () => {
    const other = didKeyIdFor(
      generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
    ) as string;
    peersConfig.signingKeyJwk = JSON.stringify({
      ...generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
      kid: other,
    });
    const service = makeService();

    const input = service.signOutbound({ method: 'POST', targetUri: TARGET, body: BODY })?.[
      'signature-input'
    ];

    expect(input).toContain(`keyid="${service.publicThumbprint}"`);
    expect(input).not.toContain(other);
  });

  it('verifies against the recorded key and reports its thumbprint', async () => {
    const peer = makePeer((jwk) => didKeyIdFor(jwk) as string);

    await expect(verify(makeService(), peer)).resolves.toEqual({
      ok: true,
      keyThumbprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it('refuses a did:key that spells out a key other than the one the link holds', async () => {
    const peer = makePeer((jwk) => didKeyIdFor(jwk) as string);
    const stranger = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });

    // A label on the stored key naming the did:key does not make it that key.
    await expect(
      verify(makeService(), peer, { ...stranger, kid: didKeyIdFor(peer.publicJwk) }),
    ).resolves.toEqual({ ok: false, reason: 'unknown-key' });
    await expect(verify(makeService(), peer, stranger)).resolves.toEqual({
      ok: false,
      reason: 'unknown-key',
    });
  });

  it('refuses a replay of the same signed request', async () => {
    const peer = makePeer((jwk) => didKeyIdFor(jwk) as string);
    const service = makeService();

    await expect(verify(service, peer)).resolves.toMatchObject({ ok: true });
    await expect(verify(service, peer)).resolves.toEqual({ ok: false, reason: 'replayed' });
  });
});
