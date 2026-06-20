/**
 * dev-stack — per-worktree local dev stack supervisor.
 *
 * `up` (what `make dev` runs) is a foreground supervisor that:
 *   1. Allocates host ports for every service, preferring the conventional
 *      default when it is free and falling back to an ephemeral port otherwise.
 *      The main checkout working solo therefore gets stable, familiar ports;
 *      concurrent worktrees transparently get ephemeral ones and never collide.
 *   2. Brings up the compose stack for this project (Postgres, object-store,
 *      Temporal, summary, hbpe) on those host ports and waits for health.
 *   3. Runs migrations against the (possibly dynamic) DB port.
 *   4. Registers a Caddy route at <key>.localhost (api / graphql / llm-stream /
 *      mcp-SSE / static / web).
 *   5. Runs the Procfile (api + web) via overmind, blocking until Ctrl-C, then
 *      tears the route down and stops the stack.
 *
 * The key is PROJECT_NAME (passed by the Makefile), the same identity that
 * already drives COMPOSE_PROJECT_NAME and the overmind tmux session — so the
 * compose project, the dev session, and the Caddy hostname all agree.
 *
 * `down` deregisters a (possibly stale) Caddy route for this worktree.
 *
 * All stacks share ONE Caddy server on :443 (Caddy forbids two servers on a
 * single listener); each stack is one host-matched route tagged with an @id,
 * added/removed independently via the admin API on :2019.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import dotenv from 'dotenv';

import { CaddyClient, routeId } from './caddy';
import { fail, link, note, ok, step, table } from './log';

const ROOT = process.cwd();
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const caddy = new CaddyClient();

const COMPOSE_FILES = ['-f', 'docker-compose.yml', '-f', 'docker-compose.local.yml'];

// Conventional default host ports, preferred when free.
const DEFAULTS = {
  api: 3030,
  web: 5173,
  db: 5432,
  objectStore: 9000,
  temporal: 7233,
  hbpe: 8002,
  summary: 8001,
};

// --- ports ------------------------------------------------------------------

/** True if something is already listening on the port — including a Docker
 * container another worktree published on 0.0.0.0. We *connect* rather than
 * bind-test: a bind on 127.0.0.1 falsely reports "free" because Node sets
 * SO_REUSEADDR, so the loopback bind coexists with an existing 0.0.0.0:<port>
 * bind — and then `docker compose up` fails with "port is already allocated".
 * (Binding 0.0.0.0 would detect it but trips the macOS firewall prompt.) A
 * refused/failed/timed-out connection means free; a successful one means taken. */
function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (taken: boolean) => {
      socket.destroy();
      resolve(taken);
    };

    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Host ports Docker has already published across all running containers. This
 * is the authoritative check for container port conflicts: Docker Desktop on
 * macOS publishes via its VM and the host port frequently isn't reachable on
 * IPv4 loopback (it listens on IPv6 `*`), so a bind- or connect-test misses it
 * — yet `docker compose up` still fails with "port is already allocated". */
function dockerPublishedPorts(): Set<number> {
  const res = spawnSync('docker', ['ps', '--format', '{{.Ports}}'], { encoding: 'utf8' });
  const ports = new Set<number>();
  for (const match of (res.stdout ?? '').matchAll(/:(\d+)->/g)) {
    ports.add(Number(match[1]));
  }

  return ports;
}

/** Preferred port if free, else an ephemeral one. "Free" means neither already
 * published by Docker (covers other worktrees' containers) nor answering a
 * connection (covers host processes like another stack's api/web). The
 * ephemeral fallback also skips Docker-published ports. (Small TOCTOU window
 * before the consumer binds — acceptable for local dev.) */
async function allocPort(preferred: number, dockerPorts: Set<number>): Promise<number> {
  if (!dockerPorts.has(preferred) && !(await portTaken(preferred))) {
    return preferred;
  }

  let port = await ephemeralPort();
  while (dockerPorts.has(port)) {
    port = await ephemeralPort();
  }

  return port;
}

// --- caddy routing (the CaddyClient lives in ./caddy) -----------------------

/** reverse_proxy handler; flush_interval -1 streams responses immediately
 * (LLM token streaming, MCP SSE) instead of buffering. */
const reverseProxy = (port: number, stream = false) => ({
  handler: 'reverse_proxy',
  ...(stream ? { flush_interval: -1 } : {}),
  upstreams: [{ dial: `localhost:${port}` }],
});

/** Strip the /api prefix before proxying — the API serves /llm/generate, not
 * /api/llm/generate. */
const stripApi = { handler: 'rewrite', strip_path_prefix: '/api' };

function buildRoute(key: string, p: { apiPort: number; webPort: number; objPort: number }) {
  const host = `${key}.localhost`;
  const csp =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' " +
    "https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src * data: blob:; " +
    `media-src 'self' blob:; connect-src 'self' ws://${host} wss://${host}; worker-src 'self'; ` +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none';";

  // Order matters: most specific first; the catch-all (web) is last.
  const routes = [
    // LLM token stream + MCP SSE: strip /api, proxy to api, flush immediately.
    { match: [{ path: ['/api/llm/generate'] }], handle: [stripApi, reverseProxy(p.apiPort, true)] },
    { match: [{ path: ['/api/mcp', '/api/mcp/'] }], handle: [stripApi, reverseProxy(p.apiPort, true)] },
    // /static: refuse if Authorization is present (SDK creds), else strip the
    // prefix and proxy to the object store with its own Host header.
    {
      match: [{ path: ['/static/*'], header: { Authorization: ['*'] } }],
      handle: [{ handler: 'static_response', status_code: 403 }],
    },
    {
      match: [{ path: ['/static/*'] }],
      handle: [
        { handler: 'rewrite', strip_path_prefix: '/static' },
        {
          handler: 'reverse_proxy',
          upstreams: [{ dial: `localhost:${p.objPort}` }],
          headers: { request: { set: { Host: [`localhost:${p.objPort}`] } } },
        },
      ],
    },
    // General API + GraphQL (websocket upgrade handled automatically by Caddy).
    { match: [{ path: ['/api/*'] }], handle: [stripApi, reverseProxy(p.apiPort)] },
    { match: [{ path: ['/graphql', '/graphql/*'] }], handle: [reverseProxy(p.apiPort)] },
    // Everything else -> vite.
    { handle: [reverseProxy(p.webPort)] },
  ];

  return {
    '@id': routeId(key),
    match: [{ host: [host] }],
    handle: [
      { handler: 'headers', response: { set: { 'Content-Security-Policy': [csp] } } },
      { handler: 'subroute', routes },
    ],
  };
}

async function caddyUp(
  key: string,
  p: { apiPort: number; webPort: number; objPort: number },
): Promise<string> {
  await caddy.addRoute(buildRoute(key, p));

  const host = `${key}.localhost`;

  ok(
    `Configuring Caddy, routing ${link(`https://${host}`)}  (/api :${p.apiPort}, /static :${p.objPort}, /* :${p.webPort})`,
  );

  return host;
}

async function caddyDown(key: string): Promise<void> {
  if (await caddy.hasRoute(routeId(key))) {
    await caddy.deleteById(routeId(key));

    ok(`Removed Caddy route for ${key}.localhost`);
  } else {
    note(`No Caddy route registered for ${key}.localhost`);
  }

  console.log('');

  // Remove the shared :443 server once its last stack route is gone.
  if (await caddy.removeServerIfEmpty()) {
    ok(`Last stack down; removed the shared :443 server (${caddy.serverName})`);

    console.log('');
  }
}

// --- compose + migrate + overmind -------------------------------------------

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): void {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });

  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}`);
  }
}

function composeUp(env: NodeJS.ProcessEnv): void {
  step('Bringing up Docker services...\n');

  run(
    'docker',
    ['compose', ...COMPOSE_FILES, '--profile', 'local', 'up', '-d', '--wait', '--remove-orphans'],
    env,
  );

  console.log('');
}

function composeStop(key: string): void {
  step('Stopping Docker services (volumes preserved)...\n');

  spawnSync('docker', ['compose', ...COMPOSE_FILES, '--profile', 'local', 'stop'], {
    cwd: ROOT,
    env: { ...process.env, COMPOSE_PROJECT_NAME: key },
    stdio: 'inherit',
  });

  console.log('');
}

function migrate(dbPort: number, env: NodeJS.ProcessEnv): void {
  step('Running database migrations...\n');

  const user = process.env.DATABASE_USERNAME ?? 'companion';
  const name = process.env.DATABASE_NAME ?? 'companion';
  const pass = process.env.DATABASE_PASSWORD ?? '';
  const databaseUrl = `postgres://${user}:${pass}@localhost:${dbPort}/${name}?sslmode=disable`;

  run('yarn', ['workspace', '@ci/be-api', 'migrate'], { ...env, DATABASE_URL: databaseUrl });

  console.log('');
}

// --- key resolution ---------------------------------------------------------

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[/.]/g, '-');
}

function gitKey(): string {
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? '';
  const common = git('rev-parse', '--git-common-dir');
  const top = git('rev-parse', '--show-toplevel');
  if (!common || !top) {
    throw new Error('not a git worktree; pass --key to name the stack');
  }

  const repo = sanitize(path.basename(path.dirname(path.resolve(ROOT, common))));
  const worktree = sanitize(path.basename(top));

  return worktree === repo ? repo : `${repo}-${worktree}`;
}

function resolveKey(explicit?: string): string {
  if (explicit) {
    return sanitize(explicit);
  }

  if (process.env.PROJECT_NAME) {
    return sanitize(process.env.PROJECT_NAME);
  }

  return gitKey();
}

// --- lifecycle --------------------------------------------------------------

async function up(key: string): Promise<void> {
  if (await caddy.hasRoute(routeId(key))) {
    fail(`Already routed at ${key}.localhost. Tear it down first with \`make dev-down\`.`);
    process.exit(1);
  }

  const dockerPorts = dockerPublishedPorts();
  const [apiPort, webPort, dbPort, objPort, temporalPort, hbpePort, summaryPort] = await Promise.all([
    allocPort(DEFAULTS.api, dockerPorts),
    allocPort(DEFAULTS.web, dockerPorts),
    allocPort(DEFAULTS.db, dockerPorts),
    allocPort(DEFAULTS.objectStore, dockerPorts),
    allocPort(DEFAULTS.temporal, dockerPorts),
    allocPort(DEFAULTS.hbpe, dockerPorts),
    allocPort(DEFAULTS.summary, dockerPorts),
  ]);

  const composeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    COMPOSE_PROJECT_NAME: key,
    DB_HOST_PORT: String(dbPort),
    OBJECT_STORE_HOST_PORT: String(objPort),
    ORCHESTRATOR_HOST_PORT: String(temporalPort),
    HBPE_HOST_PORT: String(hbpePort),
    SUMMARY_HOST_PORT: String(summaryPort),
    API_HOST_PORT: String(apiPort), // hbpe container calls the host api at this port
  };

  let overmind: ReturnType<typeof spawn> | null = null;
  let composeStarted = false;
  let tearingDown = false;

  const teardown = async () => {
    if (tearingDown) {
      return;
    }

    tearingDown = true;
    console.log('');

    step('Tearing down the stack...');

    console.log('');

    // Hand back the canonical OAuth host if this stack was the one holding it.
    await caddy.releaseOauthIfOwned(key).catch((err) => fail(String(err)));
    await caddyDown(key).catch((err) => fail(String(err))); // safe no-op if no route

    if (composeStarted) {
      composeStop(key);
    }

    ok('Teardown complete');
  };

  // Ctrl-C: once overmind owns the foreground, forward SIGINT so it group-reaps
  // api/web + tmux (its exit then resolves the wait below and the finally runs
  // teardown). Before overmind exists, tear the partial stack down directly.
  const onSignal = () => {
    if (overmind && overmind.exitCode === null) {
      overmind.kill('SIGINT');
    } else {
      void teardown().then(() => process.exit(0));
    }
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    composeUp(composeEnv);

    composeStarted = true;

    migrate(dbPort, composeEnv);

    const host = await caddyUp(key, { apiPort, webPort, objPort });

    // overmind's control socket lives in this worktree's dir (overmind runs
    // with cwd = ROOT) as a RELATIVE path. Relative keeps the bound sun_path
    // short — an absolute path in a deep worktree dir overflows sun_path (104
    // bytes on macOS). The per-worktree cwd already isolates concurrent stacks,
    // so no key suffix is needed (it was what pushed the path over the limit).
    const overmindSocket = '.overmind.sock';
    const overmindEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(apiPort),
      API_PORT: String(apiPort),
      WEB_PORT: String(webPort),
      DATABASE_PORT: String(dbPort),
      OBJECT_STORE_URL: `http://localhost:${objPort}`,
      HBPE_HOST: `http://localhost:${hbpePort}`,
      HOSTNAME: host, // this stack's own origin (<key>.localhost); OAuth host is separate
      OVERMIND_SOCKET: overmindSocket,
    };

    console.log('');

    ok(`Stack up at ${link(`https://${host}`)}`);

    table(
      ['Service', 'Port'],
      [
        ['api', String(apiPort)],
        ['web (vite)', String(webPort)],
        ['db', String(dbPort)],
        ['temporal', String(temporalPort)],
        ['object store', String(objPort)],
        ['hbpe', String(hbpePort)],
        ['summary', String(summaryPort)],
      ],
      ['left', 'right'],
    );

    note('Ctrl-C to tear everything down');

    console.log('');

    fs.rmSync(path.join(ROOT, overmindSocket), { force: true }); // clear a stale socket from a crashed run

    await new Promise<void>((resolve) => {
      overmind = spawn('overmind', ['start', '-f', 'Procfile'], {
        cwd: ROOT,
        env: overmindEnv,
        stdio: 'inherit',
      });
      overmind.on('exit', () => resolve());
      overmind.on('error', (err) => {
        fail(`overmind failed to start: ${err}`);
        resolve();
      });
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await teardown();
  }

  process.exit(process.exitCode ?? 0);
}

async function down(key: string): Promise<void> {
  await caddyDown(key);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'up';
  const keyFlag = argv.indexOf('--key');
  const key = resolveKey(keyFlag !== -1 ? argv[keyFlag + 1] : undefined);

  if (command === 'down') {
    await down(key);
  } else {
    await up(key);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
