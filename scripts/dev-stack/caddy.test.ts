import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';

import { CaddyClient, type CaddyConfig } from './caddy';

/** Caddy's config while other stacks are up: the shared server, carrying their routes. */
const withRoutes = (...ids: string[]): CaddyConfig => ({
  apps: { http: { servers: { stacks: { listen: [':443'], routes: ids.map((id) => ({ '@id': id })) } } } },
});

/** What Caddy answers a PUT onto a key that is already there. */
const alreadyExists = (path: string, key: string): Reply => ({
  status: 409,
  body: { error: `[${path}] key already exists: ${key}` },
});

const ok = (body?: unknown): Reply => ({ status: 200, body });

/** 'reset' drops the connection without answering, as Caddy does to in-flight
 * admin calls while it reloads; 'cut' drops it halfway through a 200. */
type Reply = 'reset' | 'cut' | { status: number; body?: unknown };

type Admin = { port: number; log: string[] };

/** A stand-in for Caddy's admin API. `reply` answers each request, given its
 * 1-based position; `log` records them in order as "METHOD /path". */
async function fakeAdmin(
  t: TestContext,
  reply: (req: { method: string; url: string; n: number }) => Reply,
): Promise<Admin> {
  const log: string[] = [];

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      log.push(`${req.method} ${req.url}`);

      const answer = reply({ method: req.method ?? '', url: req.url ?? '', n: log.length });

      if (answer === 'reset') {
        req.socket.destroy();
      } else if (answer === 'cut') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
        res.write('{"apps":', () => req.socket.destroy());
      } else {
        res.writeHead(answer.status, { 'Content-Type': 'application/json' });
        res.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
      }
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  return { port: (server.address() as AddressInfo).port, log };
}

const clientFor = (admin: Admin) => new CaddyClient({ host: '127.0.0.1', port: admin.port });

const writes = (admin: Admin) => admin.log.filter((line) => !line.startsWith('GET '));

/** claimOauth takes the canonical host from OAUTH_CALLBACK_URL, and reports with ok(). */
function prepareOauth(t: TestContext): void {
  const previous = process.env.OAUTH_CALLBACK_URL;

  process.env.OAUTH_CALLBACK_URL = 'https://oauth.example.test/callback';
  t.after(() => {
    // Assigning undefined would store the string "undefined".
    if (previous === undefined) {
      delete process.env.OAUTH_CALLBACK_URL;
    } else {
      process.env.OAUTH_CALLBACK_URL = previous;
    }
  });
  t.mock.method(console, 'log', () => {});
}

/** Block this thread outright, as spawnSync does while up() runs compose and migrate. */
function blockEventLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Caddy's admin server drops a keep-alive connection that has sat idle (Go's
 * IdleTimeout) and sends no Keep-Alive hint that would warn Node off reusing it.
 * This one does the same after `idleMs`. It runs in a worker so it can close
 * sockets while the test's own thread is blocked. It counts requests, and those
 * that asked to keep their connection open. */
const IDLE_CLOSING_ADMIN = `
const http = require('node:http');
const { parentPort, workerData } = require('node:worker_threads');

const stats = { requests: 0, keepAlive: 0 };

const server = http.createServer((req, res) => {
  stats.requests += 1;
  if (req.headers.connection !== 'close') stats.keepAlive += 1;

  clearTimeout(req.socket.idle);
  res.on('finish', () => {
    req.socket.idle = setTimeout(() => req.socket.destroy(), workerData.idleMs);
  });

  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(workerData.config));
});

// 0: no Keep-Alive header, as Go sends none. The timer above does the closing.
server.keepAliveTimeout = 0;
server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
parentPort.on('message', () => parentPort.postMessage(stats));
`;

test('a socket Caddy closed while up() was blocked is not read as "no shared server"', async (t) => {
  const worker = new Worker(IDLE_CLOSING_ADMIN, {
    eval: true,
    // Plain JS: no need to inherit tsx's loader, which is slow to start.
    execArgv: [],
    workerData: { config: withRoutes('stack-other'), idleMs: 50 },
  });

  t.after(() => worker.terminate());

  const [port] = await once(worker, 'message');
  const caddy = new CaddyClient({ host: '127.0.0.1', port });

  assert.notEqual(await caddy.server(), undefined);

  // The server's idle close lands now, and nothing on this thread reads it.
  blockEventLoop(500);

  // A reused socket answered this with a reset, which used to read as "absent".
  assert.notEqual(await caddy.server(), undefined);

  worker.postMessage('stats');
  const [stats] = await once(worker, 'message');

  assert.deepEqual(stats, { requests: 2, keepAlive: 0 });
});

test('a reset on the first config read is retried, so addRoute does not PUT a server that exists', async (t) => {
  const admin = await fakeAdmin(t, ({ method, url, n }) => {
    if (n === 1) {
      return 'reset';
    }

    if (method === 'GET') {
      return ok(withRoutes('stack-other'));
    }

    return method === 'PUT' ? alreadyExists(url, 'stacks') : ok();
  });

  await clientFor(admin).addRoute({ '@id': 'stack-mine' });

  assert.deepEqual(admin.log, [
    'GET /config/',
    'GET /config/',
    'POST /config/apps/http/servers/stacks/routes',
  ]);
});

test('a connection cut mid-answer is retried rather than left hanging', { timeout: 10_000 }, async (t) => {
  const admin = await fakeAdmin(t, ({ n }) => (n === 1 ? 'cut' : ok(withRoutes('stack-other'))));

  assert.notEqual(await clientFor(admin).server(), undefined);
  assert.equal(admin.log.length, 2);
});

test('ensureServer: a 409 "key already exists" on its PUT means the server is there, so addRoute carries on', async (t) => {
  // Another worktree's `make dev` created the server between our read and our PUT.
  const admin = await fakeAdmin(t, ({ method, url }) =>
    method === 'GET' ? ok(null) : method === 'PUT' ? alreadyExists(url, 'stacks') : ok(),
  );

  await clientFor(admin).addRoute({ '@id': 'stack-mine' });

  assert.deepEqual(writes(admin), [
    'PUT /config/apps/http/servers/stacks',
    'POST /config/apps/http/servers/stacks/routes',
  ]);
});

test('ensureServer: a PUT that landed but was reset, then 409s when retried, is a success', async (t) => {
  let puts = 0;

  const admin = await fakeAdmin(t, ({ method, url }) => {
    if (method !== 'PUT') {
      return method === 'GET' ? ok(null) : ok();
    }

    puts += 1;

    return puts === 1 ? 'reset' : alreadyExists(url, 'stacks');
  });

  await clientFor(admin).ensureServer();

  assert.deepEqual(writes(admin), [
    'PUT /config/apps/http/servers/stacks',
    'PUT /config/apps/http/servers/stacks',
  ]);
});

test('ensureServer: the shared server it creates listens on loopback only', async (t) => {
  // Every route on it matches a `<key>.localhost` host, which only this machine
  // resolves. On `:443` it answered the network, and a request naming one of
  // those hosts reached the stack, its `/static` object-store route included,
  // from any machine.
  let created: { listen?: unknown } | undefined;

  const server = http.createServer((req, res) => {
    let body = '';

    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'PUT') {
        created = JSON.parse(body);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.method === 'GET' ? 'null' : '');
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  await new CaddyClient({ host: '127.0.0.1', port: (server.address() as AddressInfo).port }).ensureServer();

  assert.deepEqual(created?.listen, ['127.0.0.1:443']);
});

test('ensureServer: any other refusal of its PUT still throws', async (t) => {
  const admin = await fakeAdmin(t, ({ method }) =>
    method === 'GET' ? ok(null) : { status: 400, body: { error: 'loading config: listen tcp :443: bind' } },
  );

  await assert.rejects(
    clientFor(admin).ensureServer(),
    /Caddy admin PUT \/config\/apps\/http\/servers\/stacks returned 400/,
  );
});

test('claimOauth: a 409 on the tls PUT re-reads and creates only the level still missing', async (t) => {
  prepareOauth(t);

  let tls: object | undefined;

  const admin = await fakeAdmin(t, ({ method, url }) => {
    if (method === 'GET') {
      return ok({ apps: { ...withRoutes('stack-mine').apps, ...(tls ? { tls } : {}) } });
    }

    if (method === 'PUT' && url === '/config/apps/tls') {
      // Something created the tls app since our read, with no automation in it.
      tls = { certificates: {} };

      return alreadyExists(url, 'tls');
    }

    return ok();
  });

  await clientFor(admin).claimOauth('mine');

  assert.deepEqual(writes(admin), [
    'PUT /config/apps/tls',
    'PUT /config/apps/tls/automation',
    'POST /config/apps/tls/automation/policies',
    'POST /config/apps/http/servers/stacks/routes',
  ]);
});

test('claimOauth: a race at every tls level (tls, automation, policies) still converges', async (t) => {
  prepareOauth(t);

  // Each PUT finds its level created since our read, with nothing beneath it.
  const tls: { automation?: { policies?: unknown[] } } = {};
  let hasTls = false;

  const admin = await fakeAdmin(t, ({ method, url }) => {
    if (method === 'GET') {
      return ok({ apps: { ...withRoutes('stack-mine').apps, ...(hasTls ? { tls } : {}) } });
    }

    if (method !== 'PUT') {
      return ok();
    }

    if (url === '/config/apps/tls') {
      hasTls = true;
    } else if (url === '/config/apps/tls/automation') {
      tls.automation = {};
    } else if (tls.automation) {
      tls.automation.policies = [];
    }

    return alreadyExists(url, url.slice(url.lastIndexOf('/') + 1));
  });

  await clientFor(admin).claimOauth('mine');

  assert.deepEqual(writes(admin), [
    'PUT /config/apps/tls',
    'PUT /config/apps/tls/automation',
    'PUT /config/apps/tls/automation/policies',
    'POST /config/apps/tls/automation/policies',
    'POST /config/apps/http/servers/stacks/routes',
  ]);
});

test('an unreachable Caddy fails with a message that says so, rather than reading as "no route"', async () => {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');

  const caddy = new CaddyClient({ host: '127.0.0.1', port });

  assert.equal(await caddy.reachable(), false);
  await assert.rejects(
    caddy.hasRoute('stack-mine'),
    new RegExp(`Caddy admin GET /config/ failed; is Caddy running on :${port}\\?`),
  );
});

test('addRoute: a reset POST whose effect cannot be read back is not re-sent blind', async (t) => {
  // The POST may have landed; with every read-back failing, a second POST could
  // append the route twice.
  const admin = await fakeAdmin(t, ({ n }) => (n === 1 ? ok(withRoutes()) : 'reset'));

  await assert.rejects(
    clientFor(admin).addRoute({ '@id': 'stack-mine' }),
    /POST \/config\/apps\/http\/servers\/stacks\/routes failed, and reading back whether it applied failed too/,
  );
  assert.deepEqual(writes(admin), ['POST /config/apps/http/servers/stacks/routes']);
});

test('addRoute: a reset POST that the read-back shows applied is not re-sent', async (t) => {
  let posted = false;

  const admin = await fakeAdmin(t, ({ method }) => {
    if (method === 'POST') {
      posted = true;

      return 'reset';
    }

    return ok(posted ? withRoutes('stack-mine') : withRoutes());
  });

  await clientFor(admin).addRoute({ '@id': 'stack-mine' });

  assert.deepEqual(writes(admin), ['POST /config/apps/http/servers/stacks/routes']);
});
