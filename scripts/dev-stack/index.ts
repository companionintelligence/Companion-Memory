/**
 * dev-stack — per-worktree local dev stack supervisor.
 *
 * `up` (what `make dev` runs) is a foreground supervisor that:
 *   1. Allocates host ports for every service, preferring the conventional
 *      default when it is free and falling back to an ephemeral port otherwise.
 *      The main checkout working solo therefore gets stable, familiar ports;
 *      concurrent worktrees transparently get ephemeral ones and never collide.
 *   2. Brings up the compose stack for this project (Postgres, object-store,
 *      summary, hbpe) on those host ports and waits for health.
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
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import dotenv from 'dotenv';

import { CaddyClient, routeId } from './caddy';
import { keyFromArgv } from './key';
import { fail, link, note, ok, step, table } from './log';
import { buildOvermindEnv } from './overmind-env';
import { allocStackPorts, dockerPublishedPorts } from './ports';
import { ensureSidecarAuthSecret } from './sidecar-secret';
import { removeStaleContainers } from './stale-containers';

const ROOT = process.cwd();
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

// A .env older than sidecar auth lacks this, and the sidecars exit without it.
// `make init` backfills it for `make dev`; running this script directly skips that.
if (ensureSidecarAuthSecret(path.join(ROOT, '.env'))) {
  note('Added a generated SIDECAR_AUTH_SECRET to .env (it predated sidecar auth)');
}

const caddy = new CaddyClient();

/**
 * Whether this host can pass an AMD GPU into a container.
 *
 * Keyed on the device nodes rather than on `rocminfo` or the built image's
 * flavour, because the nodes are exactly what `devices:` needs to bind — a
 * host with the ROCm userspace installed but no card, or a card with no
 * loaded amdkfd driver, must NOT get the overlay or compose refuses to start
 * the service at all.
 */
function rocmDevicesPresent(): boolean {
  return fs.existsSync('/dev/kfd') && fs.existsSync('/dev/dri');
}

/**
 * The group IDs `docker-compose.rocm.yml` binds the container's user into,
 * read off the host's own device nodes.
 *
 * Numeric and derived, never literal: the kernel checks the GID as seen from
 * the host, and `render` is 109 on Ubuntu but 105 elsewhere. /dev/kfd carries
 * the render group; the video group comes from a DRM card node, which a
 * headless box may not have — it falls back to the render GID rather than
 * being left empty, since compose would reject an empty group_add entry and a
 * duplicated group is harmless.
 */
function amdGroupEnv(): NodeJS.ProcessEnv {
  if (!rocmDevicesPresent()) {
    return {};
  }

  const renderGid = fs.statSync('/dev/kfd').gid;

  const card = fs
    .readdirSync('/dev/dri')
    .filter((entry) => entry.startsWith('card'))
    .sort()[0];

  const videoGid = card != null ? fs.statSync(path.join('/dev/dri', card)).gid : renderGid;

  return { AMD_RENDER_GID: String(renderGid), AMD_VIDEO_GID: String(videoGid) };
}

const COMPOSE_FILES = [
  '-f',
  'docker-compose.yml',
  '-f',
  'docker-compose.local.yml',
  // Appended, not substituted: the overlay only adds device passthrough to
  // hbpe-service and must lose to nothing in the local file.
  ...(rocmDevicesPresent() ? ['-f', 'docker-compose.rocm.yml'] : []),
];

/** Set once at startup; merged into the env of every compose invocation. */
const AMD_GROUP_ENV = amdGroupEnv();

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

/** The provider players the gallery can mount in an iframe (derivePlayer in
 * backend domains/embed). Without an explicit frame-src, `default-src 'self'`
 * governs frames and Chrome shows "This content is blocked" the moment a play
 * button is clicked. Mirror of the list in infrastructure/gateway/nginx.conf —
 * a new provider goes in both places, plus derivePlayer.ts. */
const PLAYER_FRAME_SRC = [
  'https://www.youtube-nocookie.com',
  'https://open.spotify.com',
  'https://player.vimeo.com',
  'https://w.soundcloud.com',
  'https://www.dailymotion.com',
].join(' ');

function buildRoute(key: string, p: { apiPort: number; webPort: number; objPort: number }) {
  const host = `${key}.localhost`;
  // script-src 'wasm-unsafe-eval': PowerSync's SQLite engine (wa-sqlite) is
  // WebAssembly compiled inside the DB web worker, and CSP counts compiling wasm
  // as eval — without it the worker's init throws and anything awaiting the local
  // database (logout's disconnectAndClear()) hangs. Mirrors nginx.conf.
  // script-src/connect-src maps.googleapis.com + maps.gstatic.com: the SPA
  // injects the Maps JS tag at runtime (frontend/apps/web/src/components/Map/
  // googleMaps.ts) and the loader then pulls its own modules and tile/route data
  // over XHR. Without them the script is refused, loadGoogleMaps()'s rejection is
  // swallowed, and the map quietly degrades to dashed straight-line polylines.
  // img-src is already `*`, so Maps' imagery needs no entry of its own.
  // Copy 4 of 4 of this policy — the other three are the http{} block and the
  // /static/ and /assets/ locations in infrastructure/gateway/nginx.conf. They
  // already drift (this one carries 'unsafe-inline' and the ws:// dev origins);
  // change all four together anyway or a fix that works in `make dev` silently
  // does nothing in the gateway-served and desktop builds.
  const csp =
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://maps.googleapis.com " +
    "https://maps.gstatic.com; style-src 'self' 'unsafe-inline' " +
    "https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src * data: blob:; " +
    "media-src 'self' blob:; connect-src 'self' https://maps.googleapis.com " +
    `ws://${host} wss://${host}; worker-src 'self'; ` +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; " +
    `frame-src ${PLAYER_FRAME_SRC};`;

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
          // Forward the Host the presigned URLs were SIGNED against, not the
          // dial target. The API signs S3 GET URLs with config.staticfiles.auth
          // .signatureUrl, which is the fixed `object-store:9000` (never
          // overridden to the dynamic dev port). SigV4 presigned URLs sign the
          // `host` header, so MinIO recomputes the signature against whatever
          // Host it receives; sending `localhost:${objPort}` here yields
          // SignatureDoesNotMatch (403). Dialing still goes to the local port.
          headers: { request: { set: { Host: ['object-store:9000'] } } },
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

function composeUp(key: string, env: NodeJS.ProcessEnv): void {
  // A stopped stack's network is fair game for `docker network prune` (the Hub
  // runs one at boot), and `up` cannot start a container whose network id is
  // gone. Drop those containers first; `up` recreates them, volumes untouched.
  const removed = removeStaleContainers(key);
  if (removed.length > 0) {
    note(`Removed ${removed.length} container(s) left on a deleted network: ${removed.join(', ')}`);
  }

  step('Bringing up Docker services...\n');

  run(
    'docker',
    ['compose', ...COMPOSE_FILES, '--profile', 'local', 'up', '-d', '--wait', '--remove-orphans'],
    { ...env, ...AMD_GROUP_ENV },
  );

  console.log('');
}

function composeStop(key: string): void {
  step('Stopping Docker services (volumes preserved)...\n');

  spawnSync('docker', ['compose', ...COMPOSE_FILES, '--profile', 'local', 'stop'], {
    cwd: ROOT,
    // The group vars matter even on `stop`: compose interpolates every file it
    // is handed before it does anything, so an unset AMD_RENDER_GID would warn
    // (and resolve to an empty group) while tearing the stack down.
    env: { ...process.env, ...AMD_GROUP_ENV, COMPOSE_PROJECT_NAME: key },
    stdio: 'inherit',
  });

  console.log('');
}

/**
 * Record which stack owns this database, as a per-database Postgres setting.
 *
 * Every worktree gets its own compose project and its own `db-data` volume, but
 * the Postgres HOST port is dynamic while `.env` hard-codes DATABASE_PORT=5432.
 * Anything that resolves the port from `.env` rather than from the running
 * stack — a bare `yarn workspace @ci/be-api migrate`, a seed script, jest —
 * therefore lands on whichever worktree currently holds host 5432 and writes to
 * ITS database. That is how a branch's migrations ended up applied to a
 * different branch's stack, leaving dbmate with nothing to do and the app
 * querying tables its own migrations never created.
 *
 * The stamp makes the mismatch detectable: `bin/dbmate.js` refuses to migrate a
 * database another stack owns, and the api refuses to boot on one (see
 * src/common/persistence/schemaIntegrity.ts). Kept here rather than in the
 * `ci/setup-database` image because per-worktree isolation is a dev-stack
 * concept — staging and production run one stack — and because a stamp added to
 * that image would not reach the warm images an existing checkout reuses.
 *
 * ALTER DATABASE ... SET, not a table: it survives restarts, needs no
 * migration, and stays out of the `pg_dump --schema-only` that dbmate writes to
 * schema.sql, so it cannot show up as churn in a diff.
 */
function stampStackIdentity(key: string, env: NodeJS.ProcessEnv): void {
  const admin = process.env.DATABASE_ADMIN_USERNAME ?? 'postgres';
  const database = process.env.DATABASE_NAME ?? 'companion';

  const res = spawnSync(
    'docker',
    [
      'compose',
      ...COMPOSE_FILES,
      '--profile',
      'local',
      'exec',
      '-T',
      'database',
      'psql',
      '-U',
      admin,
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      // Both halves are quoted AND escaped: the key comes from a directory name
      // and the database name from .env, neither of which is guaranteed to be
      // free of a quote character.
      `ALTER DATABASE "${database.replace(/"/g, '""')}" SET "ci.stack_key" = '${key.replace(/'/g, "''")}'`,
    ],
    { cwd: ROOT, env: { ...env, ...AMD_GROUP_ENV }, encoding: 'utf8' },
  );

  // Non-fatal: an un-stamped database only loses the ownership half of the
  // guard (the migrations-vs-files comparison still runs), and refusing to
  // start a stack over a failed bookkeeping write would be the worse trade.
  if (res.status !== 0) {
    note(`Could not stamp stack ownership on "${database}" — cross-worktree writes will not be caught`);
  }
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

// --- lifecycle --------------------------------------------------------------

async function up(key: string): Promise<void> {
  if (await caddy.hasRoute(routeId(key))) {
    fail(`Already routed at ${key}.localhost. Tear it down first with \`make dev-down\`.`);
    process.exit(1);
  }

  // One record feeds compose, the Caddy route and the Procfile env alike, so a
  // path proxied by both Caddy and vite (/api, /static) reaches the same port.
  const ports = await allocStackPorts(dockerPublishedPorts(key));
  const { apiPort, webPort, dbPort, objPort, hbpePort, summaryPort, parserPort } = ports;

  const composeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    COMPOSE_PROJECT_NAME: key,
    DB_HOST_PORT: String(dbPort),
    OBJECT_STORE_HOST_PORT: String(objPort),
    HBPE_HOST_PORT: String(hbpePort),
    SUMMARY_HOST_PORT: String(summaryPort),
    PARSER_HOST_PORT: String(parserPort),
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
    composeUp(key, composeEnv);

    composeStarted = true;

    stampStackIdentity(key, composeEnv);

    migrate(dbPort, composeEnv);

    const host = await caddyUp(key, ports);

    // overmind's control socket lives in this worktree's dir (overmind runs
    // with cwd = ROOT) as a RELATIVE path. Relative keeps the bound sun_path
    // short — an absolute path in a deep worktree dir overflows sun_path (104
    // bytes on macOS). The per-worktree cwd already isolates concurrent stacks,
    // so no key suffix is needed (it was what pushed the path over the limit).
    const overmindSocket = '.overmind.sock';
    const overmindEnv = buildOvermindEnv(process.env, ports, { host, socket: overmindSocket });

    console.log('');

    ok(`Stack up at ${link(`https://${host}`)}`);

    table(
      ['Service', 'Port'],
      [
        ['api', String(apiPort)],
        ['web (vite)', String(webPort)],
        ['db', String(dbPort)],
        ['object store', String(objPort)],
        ['hbpe', String(hbpePort)],
        ['summary', String(summaryPort)],
        ['parser', String(parserPort)],
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
  const key = keyFromArgv(argv);

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
