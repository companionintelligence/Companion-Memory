/**
 * The guarded dialer, with the transport faked and everything else real.
 *
 * The defect this pins was reproduced, not theorised: `PeerAskClient` validated
 * the peer URL once and then handed it to `fetch`, which follows redirects by
 * DEFAULT. A peer answering
 *
 *     307 Location: http://127.0.0.1:11434/api/pull
 *
 * had the owner's box make that request from inside its own network, carrying
 * the full POST body — the ask prompt — because the second URL was never
 * checked by anything.
 *
 * ═══ WHY THE TRANSPORT IS FAKED HERE, AND WHAT PAYS FOR IT ═══
 *
 * A real end-to-end redirect test would need a peer server this box is
 * ALLOWED to reach, and `checkEgressUrl` permits exactly one shape: https, port
 * 443, public address. A test server is loopback on a high port, so there is no
 * honest way to drive a real redirect through the real policy without weakening
 * the policy — and the policy is the correct trade (it is why the federation
 * harness drives boxes directly rather than over the network).
 *
 * So the redirect refusal is pinned twice over instead, and each half fails on
 * its own if the guard is removed:
 *
 *   - the OPTIONS assertion below goes red if `redirect: 'manual'` or the
 *     guarded dispatcher stops being passed;
 *   - the BEHAVIOUR assertions go red if a 3xx stops being refused.
 *
 * The connect-time address guard is proved over a real socket separately, in
 * `peerEgressLookup.socket.spec.ts`, where a real redirect cannot be staged but
 * a real connection can.
 */
jest.mock('undici', () => {
  const actual = jest.requireActual('undici');

  return { __esModule: true, ...actual, fetch: jest.fn() };
});

import { fetch as undiciFetch } from 'undici';

import { EgressBlockedError, peerEgressFetch } from '../urlPolicy';

const mockFetch = undiciFetch as unknown as jest.Mock;

const PEER = 'https://devon.example.com/agent/v1/ask';

interface StubOptions {
  status?: number;
  json?: unknown;
  cancel?: jest.Mock;
}

function respond({
  status = 200,
  json = {},
  // A real `ReadableStream.cancel()` returns a promise; the stub must too, or
  // it would be testing a shape the runtime never produces.
  cancel = jest.fn().mockResolvedValue(undefined),
}: StubOptions = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map<string, string>(),
    body: { cancel },
    json: async () => json,
  };
}

const INIT = {
  method: 'POST',
  headers: { authorization: 'Bearer token', accept: 'application/json' },
  body: '{"askId":"a1"}',
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('peerEgressFetch — the URL policy runs BEFORE anything is dialled', () => {
  it.each([
    ['loopback', 'http://127.0.0.1:11434/api/pull'],
    ['the ollama port on this box', 'https://127.0.0.1:11434/api/pull'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['plain http', 'http://devon.example.com/agent/v1/ask'],
    ['a database port', 'https://devon.example.com:5432/ask'],
    ['embedded credentials', 'https://user:pw@devon.example.com/ask'],
    ['a local name', 'https://db.localhost/ask'],
    ['nonsense', 'not a url'],
  ])('refuses %s without opening a connection', async (_label, url) => {
    await expect(peerEgressFetch(url, INIT)).rejects.toBeInstanceOf(EgressBlockedError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('peerEgressFetch — how the request is made', () => {
  it('never lets fetch follow a redirect, and always dials through the guarded dispatcher', async () => {
    mockFetch.mockResolvedValue(respond());

    await peerEgressFetch(PEER, INIT);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(PEER);
    // ═══ THE TWO LOAD-BEARING OPTIONS ═══
    // Drop either one and this box starts following a hostile peer's Location
    // header, or starts resolving names without checking the answer.
    expect(options.redirect).toBe('manual');
    expect(options.dispatcher).toBeDefined();
    // …and the caller's own request survives intact.
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual(INIT.headers);
    expect(options.body).toBe(INIT.body);
  });

  it('omits the body entirely for a GET — the collect route sends none', async () => {
    mockFetch.mockResolvedValue(respond());

    await peerEgressFetch('https://devon.example.com/agent/v1/ask/corr-1', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });

    expect(mockFetch.mock.calls[0][1]).not.toHaveProperty('body');
  });

  it('forwards the caller’s abort signal, so a silent peer cannot hang the ask', async () => {
    mockFetch.mockResolvedValue(respond());
    const signal = AbortSignal.timeout(5_000);

    await peerEgressFetch(PEER, { ...INIT, signal });

    expect(mockFetch.mock.calls[0][1].signal).toBe(signal);
  });
});

describe('peerEgressFetch — a peer that answers with a redirect', () => {
  it.each([301, 302, 303, 307, 308])('refuses %i rather than chasing it', async (status) => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    mockFetch.mockResolvedValue(respond({ status, cancel }));

    await expect(peerEgressFetch(PEER, INIT)).rejects.toBeInstanceOf(EgressBlockedError);

    // THE WHOLE POINT: exactly one request left this box. The second hop — the
    // one aimed at 127.0.0.1:11434 with the ask body attached — never happened.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // And the socket is not left hanging on a body nobody will read.
    expect(cancel).toHaveBeenCalled();
  });

  it('never repeats anything the peer chose back to the caller', async () => {
    mockFetch.mockResolvedValue(respond({ status: 307 }));

    let error: EgressBlockedError | undefined;
    try {
      await peerEgressFetch(PEER, INIT);
    } catch (thrown: unknown) {
      error = thrown as EgressBlockedError;
    }

    // The reason travels to the local UI. An attacker-chosen Location header
    // arriving there is how a collapsed status gets undone one field along.
    expect(error).toBeInstanceOf(EgressBlockedError);
    expect(error?.reason).not.toContain('127.0.0.1');
    expect(error?.reason).toContain('307');
  });
});

describe('peerEgressFetch — everything else is the caller’s business', () => {
  it('hands back a successful response untouched', async () => {
    const response = respond({ status: 200, json: { status: 'answered' } });
    mockFetch.mockResolvedValue(response);

    await expect(peerEgressFetch(PEER, INIT)).resolves.toBe(response);
  });

  it.each([400, 403, 404, 500, 503])(
    'hands back %i untouched — a peer error is not a refusal',
    async (status) => {
      const response = respond({ status });
      mockFetch.mockResolvedValue(response);

      await expect(peerEgressFetch(PEER, INIT)).resolves.toBe(response);
    },
  );

  it('reports a CONNECT-time block as a refusal, even though undici wraps it', async () => {
    // undici surfaces a failure from the agent's `lookup` as the `cause` of a
    // generic fetch failure. Without unwrapping it, a name that resolved inside
    // would be reported to the owner as "peer unreachable" — which is a lie
    // about what happened, and hides the attack.
    mockFetch.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: new EgressBlockedError('peer.example.com resolves to a blocked address'),
      }),
    );

    let error: EgressBlockedError | undefined;
    try {
      await peerEgressFetch(PEER, INIT);
    } catch (thrown: unknown) {
      error = thrown as EgressBlockedError;
    }

    expect(error).toBeInstanceOf(EgressBlockedError);
    expect(error?.reason).toContain('blocked address');
  });

  it('rethrows an ordinary transport failure unchanged', async () => {
    const failure = new TypeError('fetch failed');
    mockFetch.mockRejectedValue(failure);

    await expect(peerEgressFetch(PEER, INIT)).rejects.toBe(failure);
  });
});
