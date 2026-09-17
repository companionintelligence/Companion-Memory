import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';

import { fetch as undiciFetch } from 'undici';

import {
  createEgressLookup,
  createPeerEgressAgent,
  EgressBlockedError,
  peerEgressFetch,
  type AddressResolver,
} from '../urlPolicy';

/**
 * DNS rebinding, over a real socket.
 *
 * `urlPolicy.spec.ts` proves the lookup FUNCTION refuses a name that resolves
 * inside. That is not the same claim as "a request through the agent cannot
 * reach that address" — the gap between them is whether the lookup is actually
 * wired into the dispatcher, and a guard that is written but not wired is
 * exactly the shape of the four guarantees this review found pinned by nothing.
 *
 * So this suite starts a REAL server, resolves a public-looking name to it
 * through a deterministic fake resolver, and asks whether the request arrives.
 *
 * ═══ THE CONTROL IS THE POINT ═══
 *
 * Both cases use the same agent factory, the same server, the same fake DNS.
 * They differ in ONE thing: whether the lookup is wrapped in
 * {@link createEgressLookup}. The unguarded one hits the server; the guarded one
 * does not. That is the mutation test, permanently, in the suite — remove the
 * guard and the first case starts hitting the server too.
 *
 * No network is involved: the resolver is a stub, so this is deterministic on a
 * machine with no DNS at all.
 */
describe('the connect-time address guard, over a real socket', () => {
  let server: http.Server;
  let port: number;
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      // Stands in for `http://127.0.0.1:11434/api/pull` — a service that is
      // only reachable from inside this box.
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    hits.length = 0;
  });

  /** Every name resolves to the loopback server — the rebind answer. */
  const rebindResolver: AddressResolver = (_hostname, _options, callback) => {
    setImmediate(() => callback(null, [{ address: '127.0.0.1', family: 4 }]));
  };

  /** The same answer, with no guard in front of it. */
  const unguardedLookup: LookupFunction = (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all) {
      (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address: '127.0.0.1', family: 4 },
      ]);

      return;
    }

    callback(null, '127.0.0.1', 4);
  };

  it('CONTROL: without the guard, a public-looking name reaches the loopback service', async () => {
    const agent = createPeerEgressAgent(unguardedLookup);

    const response = await undiciFetch(`http://peer.example.com:${port}/api/pull`, {
      method: 'POST',
      body: '{"prompt":"a private question"}',
      redirect: 'manual',
      dispatcher: agent,
    });

    expect(response.status).toBe(200);
    // This is the disclosure: the request arrived inside.
    expect(hits).toEqual([`POST /api/pull`]);

    // `close` is present on undici's Dispatcher at runtime; the cast is only
    // because this repo's type resolution does not surface it on `Agent`.
    await (agent as unknown as { close(): Promise<void> }).close();
  });

  it('with the guard, the same request never reaches the socket at all', async () => {
    const agent = createPeerEgressAgent(createEgressLookup(rebindResolver));

    await expect(
      undiciFetch(`http://peer.example.com:${port}/api/pull`, {
        method: 'POST',
        body: '{"prompt":"a private question"}',
        redirect: 'manual',
        dispatcher: agent,
      }),
    ).rejects.toThrow();

    expect(hits).toEqual([]);

    await (agent as unknown as { close(): Promise<void> }).close();
  });

  /**
   * `peers.allowCgnatEndpoints` only ever takes 100.64.0.0/10 out of the
   * table — this is the real-socket proof that turning it on does not also,
   * even by accident, loosen the guard for loopback. Same rebind resolver,
   * same real server, same wiring; the only difference from the test above is
   * `{ allowCgnat: true }`, and the request still never arrives.
   */
  it('with allowCgnat:true, a rebind to the REAL loopback service still never reaches the socket', async () => {
    const agent = createPeerEgressAgent(createEgressLookup(rebindResolver, { allowCgnat: true }));

    await expect(
      undiciFetch(`http://peer.example.com:${port}/api/pull`, {
        method: 'POST',
        body: '{"prompt":"a private question"}',
        redirect: 'manual',
        dispatcher: agent,
      }),
    ).rejects.toThrow();

    expect(hits).toEqual([]);

    await (agent as unknown as { close(): Promise<void> }).close();
  });

  /**
   * ═══ A LITERAL IP NEVER REACHES THE LOOKUP — SO THE URL POLICY IS NOT
   *     BELT-AND-BRACES, IT IS THE ONLY THING GUARDING THAT CASE ═══
   *
   * `net.connect` only consults `lookup` when the host needs resolving. Give it
   * `127.0.0.1` and it dials straight through, guard or no guard.
   *
   * This is written down as a test rather than a comment because the tempting
   * simplification — "the connect-time guard covers everything now, the literal
   * checks in `checkEgressUrl` are redundant" — is false, and would reopen the
   * plainest version of the hole. Measured, not assumed.
   */
  it('does NOT consult the lookup for a literal IP, which is why checkEgressUrl must block literals itself', async () => {
    let resolverCalls = 0;
    const countingResolver: AddressResolver = (_hostname, _options, callback) => {
      resolverCalls += 1;
      setImmediate(() => callback(null, [{ address: '127.0.0.1', family: 4 }]));
    };

    const agent = createPeerEgressAgent(createEgressLookup(countingResolver));

    const response = await undiciFetch(`http://127.0.0.1:${port}/api/pull`, {
      redirect: 'manual',
      dispatcher: agent,
    });

    expect(response.status).toBe(200);
    expect(hits).toEqual(['GET /api/pull']);
    expect(resolverCalls).toBe(0);

    await (agent as unknown as { close(): Promise<void> }).close();

    // …and this is what actually stops it in production. No socket is opened:
    // the URL never passes policy.
    await expect(
      peerEgressFetch('https://127.0.0.1/api/pull', { method: 'GET', headers: {} }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(hits).toEqual(['GET /api/pull']);
  });
});
