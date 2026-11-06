import { generateKeyPairSync } from 'node:crypto';

// A plain object, not a Proxy over a `const` declared below: `urlPolicy` reads the peers config at
// module load, which is before this file's own `const`s exist.
jest.mock('@ci/configuration', () => ({
  __esModule: true,
  default: { logging: { level: 'error' }, peers: { timeoutMs: 5_000 } },
}));

jest.mock('../urlPolicy', () => {
  const actual = jest.requireActual('../urlPolicy');

  return { __esModule: true, ...actual, peerEgressFetch: jest.fn() };
});

import config from '@ci/configuration';

import { didKeyIdFor } from '../didKeyId';
import {
  createEgressLookup,
  EgressBlockedError,
  outstandingPeerEgressLookups,
  peerEgressFetch,
} from '../urlPolicy';

import { LocalPubDiscoveryService, MAX_OUTSTANDING_RESOLVER_CALLS } from './LocalPubDiscoveryService';

const mockFetch = peerEgressFetch as unknown as jest.Mock;
const peersConfig = (config as unknown as { peers: Record<string, unknown> }).peers;

const ACTOR_URL = 'https://alice.example/did:scid:vh:1:QmSyntheticSyntheticSyntheticSyntheticSynth/actor';
const DID = didKeyIdFor(
  generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
) as string;

const FINGER = {
  subject: 'acct:alice@alice.example',
  links: [{ rel: 'self', type: 'application/activity+json', href: ACTOR_URL }],
};
const ACTOR = {
  id: ACTOR_URL,
  type: 'Person',
  preferredUsername: 'alice',
  name: 'Alice Example',
  attachment: [
    { type: 'PropertyValue', name: 'Companion', value: `https://m.alice.example/agent/v1 ${DID}` },
  ],
};

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** A response whose body is a stream of the given chunks; `cancelled` says whether the reader was cancelled. */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const state = { cancelled: false, pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[state.pulled];
      state.pulled += 1;
      if (next === undefined) {
        controller.close();
      } else {
        controller.enqueue(next);
      }
    },
    cancel() {
      state.cancelled = true;
    },
  });

  return { response: new Response(body, { status: 200, headers }), state };
}

/** A JSON document of exactly `bytes` bytes (UTF-8), made by padding one string member. */
function jsonOfSize(base: Record<string, unknown>, bytes: number) {
  const withoutPad = JSON.stringify({ ...base, pad: '' });
  const pad = 'x'.repeat(bytes - Buffer.byteLength(withoutPad));

  return JSON.stringify({ ...base, pad });
}

function makeService() {
  const logger = { setContext: jest.fn(), warn: jest.fn(), log: jest.fn(), debug: jest.fn() };

  return { service: new LocalPubDiscoveryService(logger as never), logger };
}

/** A promise settled from outside, to hold a lookup in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

const NOT_FOUND = () => json({ error: 'not found' }, { status: 404 });

beforeEach(() => {
  mockFetch.mockReset();
  for (const key of Object.keys(peersConfig)) {
    delete peersConfig[key];
  }

  peersConfig.localPubEnabled = true;
  peersConfig.timeoutMs = 5_000;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('LocalPubDiscoveryService — off by default', () => {
  it('makes no call at all while peers.localPubEnabled is not set', async () => {
    delete peersConfig.localPubEnabled;
    const { service } = makeService();

    expect(service.enabled).toBe(false);
    await expect(service.lookup('@alice@alice.example')).resolves.toEqual({ ok: false, reason: 'disabled' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('is not switched on by a truthy-looking string', async () => {
    peersConfig.localPubEnabled = 'true';

    expect(makeService().service.enabled).toBe(false);
  });
});

describe('LocalPubDiscoveryService.lookup', () => {
  it('asks the handle host for WebFinger, then the actor it names, and returns what the profile claims', async () => {
    mockFetch.mockResolvedValueOnce(json(FINGER)).mockResolvedValueOnce(json(ACTOR));
    const { service } = makeService();

    const result = await service.lookup('@alice@alice.example');

    expect(result).toEqual({
      ok: true,
      candidate: expect.objectContaining({
        handle: 'alice@alice.example',
        actorId: ACTOR_URL,
        displayName: 'Alice Example',
        companionEndpoint: 'https://m.alice.example/agent/v1',
        companionDidKey: DID,
      }),
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://alice.example/.well-known/webfinger?resource=acct%3Aalice%40alice.example',
      expect.objectContaining({
        method: 'GET',
        headers: { accept: 'application/jrd+json, application/json' },
      }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      ACTOR_URL,
      expect.objectContaining({
        method: 'GET',
        headers: {
          accept:
            'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
        },
      }),
    );
  });

  it('puts ONE deadline of peers.timeoutMs over the whole lookup, not one per request', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    peersConfig.timeoutMs = 1234;
    mockFetch.mockResolvedValueOnce(json(FINGER)).mockResolvedValueOnce(json(ACTOR));

    await makeService().service.lookup('@alice@alice.example');

    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(1234);
    const first = mockFetch.mock.calls[0][1].signal as AbortSignal;
    const second = mockFetch.mock.calls[1][1].signal as AbortSignal;
    expect(first).toBeInstanceOf(AbortSignal);
    expect(second).toBe(first);
  });

  it('defaults the deadline to ten seconds', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    delete peersConfig.timeoutMs;
    mockFetch.mockResolvedValueOnce(NOT_FOUND());

    await makeService().service.lookup('@alice@alice.example');

    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it('clamps a deadline too long for a timer, which would otherwise fire at once or throw', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    mockFetch.mockResolvedValueOnce(json(FINGER)).mockResolvedValueOnce(json(ACTOR));
    peersConfig.timeoutMs = 3_000_000_000;

    await expect(makeService().service.lookup('@alice@alice.example')).resolves.toMatchObject({ ok: true });
    expect(timeout).toHaveBeenCalledWith(2_147_483_647);

    peersConfig.timeoutMs = 10_000_000_000_000;
    mockFetch.mockResolvedValueOnce(json(FINGER)).mockResolvedValueOnce(json(ACTOR));
    await expect(makeService().service.lookup('@alice@alice.example')).resolves.toMatchObject({ ok: true });
  });

  it('sends nothing for a handle it cannot read', async () => {
    const { service } = makeService();

    for (const input of ['alice', 'alice@127.0.0.1', 'alice@localhost', 'alice@alice.example:8443', '']) {
      await expect(service.lookup(input)).resolves.toEqual({ ok: false, reason: 'bad-handle' });
    }

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([404, 410])(
    'says not-found for a %s, and drops the body so the socket is not held',
    async (status) => {
      const cancel = jest.fn().mockResolvedValue(undefined);
      mockFetch.mockResolvedValueOnce({ status, ok: false, headers: new Headers(), body: { cancel } });

      await expect(makeService().service.lookup('alice@alice.example')).resolves.toEqual({
        ok: false,
        reason: 'not-found',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it('treats a 200 with no body at all as a bad answer, not as a host that did not answer', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(makeService().service.lookup('alice@alice.example')).resolves.toEqual({
      ok: false,
      reason: 'bad-response',
    });
  });

  it('does not mistake a body that is the JSON string "missing" for a missing account', async () => {
    mockFetch.mockResolvedValueOnce(json('missing'));

    await expect(makeService().service.lookup('alice@alice.example')).resolves.toEqual({
      ok: false,
      reason: 'bad-response',
    });
  });

  it('refuses a WebFinger answer that is about another account', async () => {
    mockFetch.mockResolvedValueOnce(json({ ...FINGER, subject: 'acct:mallory@alice.example' }));
    const { service, logger } = makeService();

    await expect(service.lookup('alice@alice.example')).resolves.toEqual({
      ok: false,
      reason: 'bad-response',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('refused (bad-response)'));
  });

  it('refuses an actor that is not the one WebFinger named', async () => {
    mockFetch
      .mockResolvedValueOnce(json(FINGER))
      .mockResolvedValueOnce(json({ ...ACTOR, id: 'https://alice.example/x' }));

    await expect(makeService().service.lookup('alice@alice.example')).resolves.toEqual({
      ok: false,
      reason: 'bad-response',
    });
  });

  it('treats a missing actor as a bad answer, not as an absent account', async () => {
    mockFetch.mockResolvedValueOnce(json(FINGER)).mockResolvedValueOnce(json({}, { status: 404 }));

    await expect(makeService().service.lookup('alice@alice.example')).resolves.toEqual({
      ok: false,
      reason: 'bad-response',
    });
  });

  it.each([500, 502, 403, 429])(
    'treats a %s from WebFinger as a bad answer and drops the body',
    async (status) => {
      const cancel = jest.fn().mockResolvedValue(undefined);
      mockFetch.mockResolvedValueOnce({ status, ok: false, headers: new Headers(), body: { cancel } });
      const { service, logger } = makeService();

      await expect(service.lookup('alice@alice.example')).resolves.toEqual({
        ok: false,
        reason: 'bad-response',
      });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`→ ${status}`));
    },
  );

  it.each([500, 503])('treats a %s from the actor request as a bad answer', async (status) => {
    mockFetch.mockResolvedValueOnce(json(FINGER)).mockResolvedValueOnce(new Response('nope', { status }));

    await expect(makeService().service.lookup('alice@alice.example')).resolves.toEqual({
      ok: false,
      reason: 'bad-response',
    });
  });

  it('treats a body that is not JSON as a bad answer', async () => {
    mockFetch.mockResolvedValueOnce(new Response('<html>hello</html>', { status: 200 }));

    await expect(makeService().service.lookup('alice@alice.example')).resolves.toEqual({
      ok: false,
      reason: 'bad-response',
    });
  });
});

describe('LocalPubDiscoveryService — what it will read', () => {
  const finger = { ...FINGER };

  it('reads a WebFinger answer of exactly 64 KiB and refuses one byte more', async () => {
    mockFetch.mockResolvedValueOnce(new Response(jsonOfSize(finger, 65_536), { status: 200 }));
    mockFetch.mockResolvedValueOnce(json(ACTOR));
    await expect(makeService().service.lookup('alice@alice.example')).resolves.toMatchObject({ ok: true });

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(new Response(jsonOfSize(finger, 65_537), { status: 200 }));
    await expect(makeService().service.lookup('alice@alice.example')).resolves.toEqual({
      ok: false,
      reason: 'bad-response',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reads an actor of exactly 256 KiB and refuses one byte more', async () => {
    mockFetch.mockResolvedValueOnce(json(FINGER));
    mockFetch.mockResolvedValueOnce(new Response(jsonOfSize(ACTOR, 262_144), { status: 200 }));
    await expect(makeService().service.lookup('alice@alice.example')).resolves.toMatchObject({ ok: true });

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(json(FINGER));
    mockFetch.mockResolvedValueOnce(new Response(jsonOfSize(ACTOR, 262_145), { status: 200 }));
    await expect(makeService().service.lookup('alice@alice.example')).resolves.toEqual({
      ok: false,
      reason: 'bad-response',
    });
  });

  it('reads a body that declares exactly the cap', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(jsonOfSize(finger, 65_536), { status: 200, headers: { 'content-length': '65536' } }),
    );
    mockFetch.mockResolvedValueOnce(json(ACTOR));

    await expect(makeService().service.lookup('alice@alice.example')).resolves.toMatchObject({ ok: true });
  });

  it('refuses on the declared length alone, without reading the body', async () => {
    const getReader = jest.fn();
    const cancel = jest.fn().mockResolvedValue(undefined);
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-length': '65537' }),
      body: { getReader, cancel },
    });

    await expect(makeService().service.lookup('alice@alice.example')).resolves.toEqual({
      ok: false,
      reason: 'bad-response',
    });
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('stops reading and cancels the stream once an undeclared body passes the cap', async () => {
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    const { response, state } = streamed(Array.from({ length: 64 }, () => chunk));
    mockFetch.mockResolvedValueOnce(response);

    await expect(makeService().service.lookup('alice@alice.example')).resolves.toEqual({
      ok: false,
      reason: 'bad-response',
    });
    expect(state.cancelled).toBe(true);
    // 64 KiB is four chunks; the fifth crosses the cap. Reading the other fifty-nine would be the bug.
    expect(state.pulled).toBeLessThanOrEqual(6);
  });
});

describe('LocalPubDiscoveryService — refusals and silence', () => {
  it('reports a refusal by the egress policy as blocked', async () => {
    mockFetch.mockRejectedValueOnce(new EgressBlockedError('alice.example resolves to a blocked address'));
    const { service, logger } = makeService();

    await expect(service.lookup('alice@alice.example')).resolves.toEqual({ ok: false, reason: 'blocked' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('resolves to a blocked address'));
  });

  it('reports a redirect, on either request, as redirected and not as blocked', async () => {
    mockFetch.mockRejectedValueOnce(new EgressBlockedError('peer answered 301 with a redirect', true));
    await expect(makeService().service.lookup('alice@alice.example')).resolves.toEqual({
      ok: false,
      reason: 'redirected',
    });

    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce(json(FINGER))
      .mockRejectedValueOnce(new EgressBlockedError('peer answered 302 with a redirect', true));
    await expect(makeService().service.lookup('alice@alice.example')).resolves.toEqual({
      ok: false,
      reason: 'redirected',
    });
  });

  it('reports a host that does not answer as unreachable', async () => {
    mockFetch.mockRejectedValueOnce(
      Object.assign(new Error('fetch failed'), { cause: new Error('ECONNREFUSED') }),
    );

    await expect(makeService().service.lookup('alice@alice.example')).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('reports a timeout as unreachable', async () => {
    mockFetch.mockRejectedValueOnce(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    );

    await expect(makeService().service.lookup('alice@alice.example')).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });
});

describe('LocalPubDiscoveryService — how much it may be asked', () => {
  it('runs at most two lookups at once and answers busy to the third, then admits one when a slot frees', async () => {
    const held = [deferred<Response>(), deferred<Response>()];
    mockFetch.mockReturnValueOnce(held[0].promise).mockReturnValueOnce(held[1].promise);
    const { service, logger } = makeService();

    const first = service.lookup('a@alice.example');
    const second = service.lookup('b@alice.example');
    await expect(service.lookup('c@alice.example')).resolves.toEqual({ ok: false, reason: 'busy' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('(busy)'));

    held[0].resolve(NOT_FOUND());
    await expect(first).resolves.toEqual({ ok: false, reason: 'not-found' });

    mockFetch.mockResolvedValueOnce(NOT_FOUND());
    await expect(service.lookup('d@alice.example')).resolves.toEqual({ ok: false, reason: 'not-found' });

    held[1].resolve(NOT_FOUND());
    await second;
  });

  it('gives the slot back when a lookup throws', async () => {
    // A failed fetch is caught and answered `unreachable`; what can still escape is the logger. Three
    // escapes would hold three slots, and only two are allowed at once.
    mockFetch.mockRejectedValue(new Error('boom'));
    const { service, logger } = makeService();
    logger.warn.mockImplementation(() => {
      throw new Error('log sink is down');
    });

    for (let i = 0; i < 3; i += 1) {
      await expect(service.lookup('a@alice.example')).rejects.toThrow('log sink is down');
    }

    logger.warn.mockReset();
    await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'unreachable' });
  });

  it('answers busy while ONE name lookup is still waiting for DNS, though no fetch is in flight', async () => {
    // A fetch that hit its deadline leaves its getaddrinfo call behind, holding a libuv thread. libuv lets
    // that kind of work use two threads; one stuck call is allowed to hold one of them, never both, so
    // the next lookup waits until it is answered. That is what counting the resolver calls (and not only
    // the fetches) is for, and why the bound is one and not two.
    let answer: () => void = () => undefined;
    const lookup = createEgressLookup((_host, _options, callback) => {
      answer = () => callback(null, [{ address: '93.184.216.34', family: 4 }]);
    });
    lookup('slow-one.example', {}, () => undefined);
    const { service } = makeService();

    try {
      expect(outstandingPeerEgressLookups()).toBe(1);
      expect(MAX_OUTSTANDING_RESOLVER_CALLS).toBe(1);
      await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'busy' });
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      answer();
    }

    expect(outstandingPeerEgressLookups()).toBe(0);
    mockFetch.mockResolvedValueOnce(NOT_FOUND());
    await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'not-found' });
  });

  it('still runs two lookups at once when no name lookup is waiting', async () => {
    const held = [deferred<Response>(), deferred<Response>()];
    mockFetch.mockReturnValueOnce(held[0].promise).mockReturnValueOnce(held[1].promise);
    const { service } = makeService();

    const first = service.lookup('a@alice.example');
    const second = service.lookup('b@alice.example');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    held[0].resolve(NOT_FOUND());
    held[1].resolve(NOT_FOUND());
    await Promise.all([first, second]);
  });

  it('does not spend the minute budget on calls it answers busy, so they cannot extend the lockout', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(NOT_FOUND()));
    const { service } = makeService();
    let clock = 1_000_000;
    service.now = () => clock;

    for (let i = 0; i < 20; i += 1) {
      await service.lookup('a@alice.example');
    }

    // Thirty more calls over the next 57 seconds, every one busy.
    for (let i = 0; i < 30; i += 1) {
      clock += 1_900;
      await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'busy' });
    }

    // The twenty that were admitted all started at the same moment, so a minute after it the window is empty.
    clock = 1_000_000 + 60_000;
    await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'not-found' });
  });

  it('judges the minute window by the OLDEST start, one slot at a time', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(NOT_FOUND()));
    const { service } = makeService();
    let clock = 1_000_000;
    service.now = () => clock;

    // Twenty lookups started three seconds apart: the first at +0, the last at +57 s.
    for (let i = 0; i < 20; i += 1) {
      clock = 1_000_000 + i * 3_000;
      await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'not-found' });
    }

    // At +59.999 s the first has not yet aged out.
    clock = 1_000_000 + 59_999;
    await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'busy' });

    // At +60 s exactly ONE slot is free (the first), not twenty and not none.
    clock = 1_000_000 + 60_000;
    await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'not-found' });
    await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'busy' });

    // The second start ages out three seconds later.
    clock = 1_000_000 + 63_000;
    await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'not-found' });
  });

  it('reads the minute window off a clock that does not step back: process.hrtime, not Date.now', () => {
    const { service } = makeService();
    jest.spyOn(process.hrtime, 'bigint').mockReturnValue(7_000_000_000n);
    jest.spyOn(Date, 'now').mockReturnValue(1);

    expect(service.now()).toBe(7_000);
  });

  it('allows twenty lookups to start in a minute, answers busy to the next, and recovers after the minute', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(NOT_FOUND()));
    const { service } = makeService();
    let clock = 1_000_000;
    service.now = () => clock;

    for (let i = 0; i < 20; i += 1) {
      await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'not-found' });
    }

    await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'busy' });
    expect(mockFetch).toHaveBeenCalledTimes(20);

    clock += 59_999;
    await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'busy' });

    clock += 1;
    await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'not-found' });
  });

  it('spends the budget on lookups that fail, not only on those that succeed', async () => {
    mockFetch.mockImplementation(() => Promise.reject(new Error('down')));
    const { service } = makeService();
    service.now = () => 1_000_000;

    for (let i = 0; i < 20; i += 1) {
      await service.lookup('a@alice.example');
    }

    await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'busy' });
  });

  it('does not spend the budget on a handle it refuses, or while off', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(NOT_FOUND()));
    const { service } = makeService();
    service.now = () => 1_000_000;

    for (let i = 0; i < 50; i += 1) {
      await service.lookup('not a handle');
    }

    peersConfig.localPubEnabled = false;
    for (let i = 0; i < 50; i += 1) {
      await service.lookup('a@alice.example');
    }

    peersConfig.localPubEnabled = true;

    await expect(service.lookup('a@alice.example')).resolves.toEqual({ ok: false, reason: 'not-found' });
  });
});
