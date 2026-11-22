jest.mock('undici', () => {
  const actual = jest.requireActual('undici');

  return { __esModule: true, ...actual, fetch: jest.fn() };
});

import { generateKeyPairSync } from 'node:crypto';

import { fetch as undiciFetch } from 'undici';

import { didKeyIdFor } from '../didKeyId';
import { signIdentityProof } from '../identityProof';

import { PeerExchangeClient } from './PeerExchangeClient';
import { PeerSignatureService } from './PeerSignatureService';

const mockFetch = undiciFetch as unknown as jest.Mock;

const ENDPOINT = 'https://alice.example.com/api/agent/v1';

function respond(status: number, json: unknown = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map<string, string>(),
    body: { cancel: jest.fn().mockResolvedValue(undefined) },
    json: async () => json,
  };
}

function person() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const didKey = didKeyIdFor(publicKey.export({ format: 'jwk' }) as Record<string, unknown>) as string;

  return { key: privateKey, didKey };
}

function client() {
  const logger = { setContext: jest.fn(), warn: jest.fn(), log: jest.fn() };
  const signatures = new PeerSignatureService({} as never, logger as never);

  return new PeerExchangeClient(signatures, logger as never);
}

/** A peer box that answers identity requests for `holder`, signing whatever endpoint it is told to. */
function answerAs(holder: ReturnType<typeof person>, endpoint = ENDPOINT) {
  mockFetch.mockImplementation(async (url: string) => {
    const parsed = new URL(url);
    const challenge = parsed.searchParams.get('challenge') as string;

    return respond(200, signIdentityProof(holder.key, { didKey: holder.didKey, endpoint, challenge }));
  });
}

beforeEach(() => mockFetch.mockReset());

describe('PeerExchangeClient.verifyIdentity', () => {
  it('accepts a box that proves the key at that address', async () => {
    const alice = person();
    answerAs(alice);

    await expect(client().verifyIdentity(ENDPOINT, alice.didKey)).resolves.toEqual({
      ok: true,
      value: undefined,
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toMatch(new RegExp(`^${ENDPOINT}/identity/${encodeURIComponent(alice.didKey)}\\?challenge=`));
    expect(init.redirect).toBe('manual');
  });

  it('refuses a box that holds a DIFFERENT key than the one asked about', async () => {
    const alice = person();
    const mallory = person();
    mockFetch.mockImplementation(async (url: string) => {
      const challenge = new URL(url).searchParams.get('challenge') as string;

      return respond(
        200,
        signIdentityProof(mallory.key, { didKey: alice.didKey, endpoint: ENDPOINT, challenge }),
      );
    });

    await expect(client().verifyIdentity(ENDPOINT, alice.didKey)).resolves.toEqual({
      ok: false,
      reason: 'bad-proof',
    });
  });

  it('refuses a box that says it lives at another address', async () => {
    const alice = person();
    answerAs(alice, 'https://elsewhere.example.com/api/agent/v1');

    await expect(client().verifyIdentity(ENDPOINT, alice.didKey)).resolves.toEqual({
      ok: false,
      reason: 'bad-proof',
    });
  });

  it('reports a 404 as refused', async () => {
    mockFetch.mockResolvedValue(respond(404));

    await expect(client().verifyIdentity(ENDPOINT, person().didKey)).resolves.toEqual({
      ok: false,
      reason: 'refused',
      status: 404,
    });
  });

  it('dials nothing for an address the egress policy refuses', async () => {
    await expect(client().verifyIdentity('https://10.0.0.5/api/agent/v1', person().didKey)).resolves.toEqual({
      ok: false,
      reason: 'not-permitted',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses to follow a redirect', async () => {
    mockFetch.mockResolvedValue({ ...respond(307), headers: new Map([['location', 'http://127.0.0.1/']]) });

    await expect(client().verifyIdentity(ENDPOINT, person().didKey)).resolves.toEqual({
      ok: false,
      reason: 'not-permitted',
    });
  });
});

describe('PeerExchangeClient.postSigned', () => {
  it('signs the body with the given key and sends no token', async () => {
    const alice = person();
    mockFetch.mockResolvedValue(respond(200, { ok: true }));

    await client().postSigned(ENDPOINT, '/invites/accept', { a: 1 }, { key: alice.key, keyid: alice.didKey });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${ENDPOINT}/invites/accept`);
    expect(init.headers.authorization).toBe('Bearer keri');
    expect(init.headers['signature-input']).toContain(`keyid="${alice.didKey}"`);
    expect(init.headers['content-digest']).toMatch(/^sha-256=:/);
    expect(init.body).toBe('{"a":1}');
  });
});
