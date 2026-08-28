/**
 * `PeerAskClient` end to end: the real URL policy, the real dialer, the real
 * redirect refusal — only the socket is faked.
 *
 * Mocking `undici.fetch` rather than the policy module is deliberate. The defect
 * was never in what the policy DECIDED; it was that the decision was made once,
 * about a URL, and then a redirect-following `fetch` was handed the peer's next
 * choice. A spec that stubs the policy out cannot see that. This one can: it
 * counts how many requests actually left the box.
 */
jest.mock('undici', () => {
  const actual = jest.requireActual('undici');

  return { __esModule: true, ...actual, fetch: jest.fn() };
});

import { fetch as undiciFetch } from 'undici';

import { type PeerLink } from '../entities/PeerLinkEntity';
import type { PeerAskBody } from '../protocol';
import { EgressBlockedError } from '../urlPolicy';

import { PeerAskClient } from './PeerAskClient';

const mockFetch = undiciFetch as unknown as jest.Mock;

function client(): { subject: PeerAskClient; warn: jest.Mock } {
  const warn = jest.fn();
  const logger = { setContext: jest.fn(), warn, log: jest.fn(), error: jest.fn(), debug: jest.fn() };

  return { subject: new PeerAskClient(unsignedSigner() as never, logger as never), warn };
}

function link(memoryEndpoint: string): PeerLink {
  return {
    id: 'link-1',
    ownerUserId: 'user-1',
    peerHandle: 'devon',
    memoryEndpoint,
    trustTier: 'trusted',
    status: 'active',
  } as PeerLink;
}

const PUBLIC_PEER = link('https://devon.example.com/agent/v1');

const BODY = {
  askId: 'ask-wire-1',
  askerHandle: 'liam',
  prompt: 'are you free thursday?',
  request: { archetype: 'availability' },
} as unknown as PeerAskBody;

function respond(status: number, json: unknown = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map<string, string>(),
    body: { cancel: jest.fn().mockResolvedValue(undefined) },
    json: async () => json,
  };
}

const ANSWER = {
  status: 'answered',
  answer: { form: 'availability', summary: 'Free after 3pm.', disclosedCount: 1, withheldCount: 0 },
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('PeerAskClient — an endpoint pointing inside is refused before anything is dialled', () => {
  it.each([
    ['loopback over http', 'http://127.0.0.1:11434'],
    ['loopback over https', 'https://127.0.0.1:11434'],
    ['cloud metadata', 'https://169.254.169.254/latest'],
    ['the tailnet', 'https://100.64.3.4/agent/v1'],
    ['a private LAN box', 'https://192.168.1.10/agent/v1'],
    ['a local name', 'https://companion.local/agent/v1'],
    ['a name that only means inside', 'https://vault.internal/agent/v1'],
  ])('send() to %s declines without a request', async (_label, endpoint) => {
    const { subject } = client();

    const reply = await subject.send(link(endpoint), BODY, 'token');

    expect(reply).toEqual({
      askId: 'ask-wire-1',
      status: 'delivered',
      reason: 'Peer endpoint not permitted',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  /**
   * The collect route is newer than the ask route and egresses just the same.
   * A second caller that skipped the guard would reopen the hole for the whole
   * domain, so it is pinned separately rather than trusted to share a helper.
   */
  it.each([
    ['loopback', 'http://127.0.0.1:11434'],
    ['cloud metadata', 'https://169.254.169.254/latest'],
    ['the tailnet', 'https://100.64.3.4/agent/v1'],
  ])('poll() to %s declines without a request', async (_label, endpoint) => {
    const { subject } = client();

    const reply = await subject.poll(link(endpoint), 'corr-1', 'token');

    expect(reply).toEqual({
      askId: 'corr-1',
      status: 'delivered',
      reason: 'Peer endpoint not permitted',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('PeerAskClient — a compromised peer cannot redirect this box into its own network', () => {
  it('send(): a 307 at the ask route is refused, and the ask body never makes a second hop', async () => {
    // THE REPRODUCED DEFECT. Before the fix, `fetch` followed this by default
    // and re-issued the POST — method and body intact — at
    // http://127.0.0.1:11434/api/pull, from inside the appliance's own network.
    const { subject } = client();
    mockFetch.mockResolvedValue(respond(307));

    const reply = await subject.send(PUBLIC_PEER, BODY, 'token');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://devon.example.com/agent/v1/ask');
    expect(reply).toEqual({
      askId: 'ask-wire-1',
      status: 'delivered',
      reason: 'Peer endpoint not permitted',
    });
    expect(reply.answer).toBeUndefined();
  });

  it.each([301, 302, 303, 307, 308])('send(): %i is refused too', async (status) => {
    const { subject } = client();
    mockFetch.mockResolvedValue(respond(status));

    const reply = await subject.send(PUBLIC_PEER, BODY, 'token');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(reply.status).toBe('delivered');
    expect(reply.answer).toBeUndefined();
  });

  it('poll(): a 307 at the collect route is refused just the same', async () => {
    const { subject } = client();
    mockFetch.mockResolvedValue(respond(307));

    const reply = await subject.poll(PUBLIC_PEER, 'corr-1', 'token');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(reply).toEqual({
      askId: 'corr-1',
      status: 'delivered',
      reason: 'Peer endpoint not permitted',
    });
  });

  it('a refusal never carries anything the peer wrote', async () => {
    const { subject } = client();
    mockFetch.mockResolvedValue(respond(307));

    const reply = await subject.send(PUBLIC_PEER, BODY, 'token');

    // The peer's own words are dropped on every path, refusal included — the
    // distinction #2216 had to restore.
    expect(reply.reason).toBe('Peer endpoint not permitted');
  });
});

describe('PeerAskClient — the request it does make', () => {
  it('dials the ask route with manual redirects, the guarded dispatcher, and the bearer token', async () => {
    const { subject } = client();
    mockFetch.mockResolvedValue(respond(200, ANSWER));

    await subject.send(PUBLIC_PEER, BODY, 'portal-token');

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://devon.example.com/agent/v1/ask');
    expect(options.redirect).toBe('manual');
    expect(options.dispatcher).toBeDefined();
    expect(options.method).toBe('POST');
    expect(options.headers.authorization).toBe('Bearer portal-token');
    expect(options.headers['content-type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual(BODY);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('dials the collect route by correlation id, with no body', async () => {
    const { subject } = client();
    mockFetch.mockResolvedValue(respond(200, ANSWER));

    await subject.poll(PUBLIC_PEER, 'corr 1/../admin', 'portal-token');

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://devon.example.com/agent/v1/ask/corr%201%2F..%2Fadmin');
    expect(options.method).toBe('GET');
    expect(options.redirect).toBe('manual');
    expect(options).not.toHaveProperty('body');
  });

  it('still carries an answer back on the happy path', async () => {
    const { subject } = client();
    mockFetch.mockResolvedValue(respond(200, ANSWER));

    const reply = await subject.send(PUBLIC_PEER, BODY, 'token');

    expect(reply.status).toBe('answered');
    expect(reply.answer?.summary).toBe('Free after 3pm.');
  });
});

describe('PeerAskClient — a refusal and an outage are different facts', () => {
  it('reports a peer HTTP error as a peer error', async () => {
    const { subject } = client();
    mockFetch.mockResolvedValue(respond(500));

    const reply = await subject.send(PUBLIC_PEER, BODY, 'token');

    expect(reply).toEqual({ askId: 'ask-wire-1', status: 'delivered', reason: 'Peer error 500' });
  });

  it('reports a transport failure as unreachable, not as a refusal', async () => {
    const { subject } = client();
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const reply = await subject.send(PUBLIC_PEER, BODY, 'token');

    expect(reply).toEqual({ askId: 'ask-wire-1', status: 'delivered', reason: 'Peer unreachable' });
  });

  it('reports a name that RESOLVES inside as a refusal, not as unreachable', async () => {
    // undici hands the agent's own error back as `cause`. Reporting this as
    // "peer unreachable" would tell the owner a comforting lie about what just
    // happened to their box.
    const { subject } = client();
    mockFetch.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: new EgressBlockedError('devon.example.com resolves to a blocked address'),
      }),
    );

    const reply = await subject.send(PUBLIC_PEER, BODY, 'token');

    expect(reply.reason).toBe('Peer endpoint not permitted');
  });
});

/**
 * A signer with no key configured, which is every box until an operator sets
 * `peers.signingKeyJwk`. These suites are about the call, not the signature.
 */
function unsignedSigner() {
  return { signOutbound: () => null };
}
