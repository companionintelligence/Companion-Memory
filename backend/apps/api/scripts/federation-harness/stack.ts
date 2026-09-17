/**
 * Bringing one box up and down: its compose services, its migrations, its API
 * process.
 *
 * Everything here is per-box and idempotent. `up` on a box that is already up
 * re-uses its containers and its database; the only thing that is always redone
 * is the migration pass, which is a no-op when the schema is current.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Client } from 'pg';

import { BOXES, REPO_ROOT, STATE_DIR, composeProject, type BoxId, type BoxRuntime } from './topology';

/**
 * The same two files `scripts/dev-stack` uses. The ROCm overlay is deliberately
 * not included: it only adds GPU passthrough to `hbpe-service`, which this
 * harness does not start.
 */
const COMPOSE_FILES = ['-f', 'docker-compose.yml', '-f', 'docker-compose.local.yml'];

/**
 * The three services a federated ask actually needs.
 *
 * `summary-service` and `hbpe-service` are in the `local` profile and `make dev`
 * starts them, but the ask path touches neither: `AskExecutorService` runs
 * SearchService in `mode: 'keyword'` (its comment: "keyword only: deterministic,
 * no embedding side effects"), so there is no embedding call, no LLM call, and
 * no Ollama dependency anywhere in the pipeline this harness exercises. Starting
 * them would double the container count and pull model weights for nothing.
 *
 * `setup-database` is the ephemeral one that creates the `companion` role and
 * the extensions; it runs to exit 0 and stays exited.
 *
 * The three names live inline in `composeUp` rather than in a shared constant,
 * because the two `up` invocations there deliberately split them (see the note
 * on `--wait` and a service that exits).
 */

export interface BoxEnv extends NodeJS.ProcessEnv {
  COMPOSE_PROJECT_NAME: string;
}

/** Environment for `docker compose` invocations against one box's stack. */
export function composeEnv(box: BoxId, runtime: BoxRuntime): BoxEnv {
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: composeProject(box),
    DB_HOST_PORT: String(runtime.dbPort),
    OBJECT_STORE_HOST_PORT: String(runtime.objectStorePort),
    // Named even though the services are not started: compose interpolates
    // EVERY service in the file before it does anything, so leaving these unset
    // produces a wall of warnings on an otherwise clean bring-up.
    HBPE_HOST_PORT: '0',
    SUMMARY_HOST_PORT: '0',
    PARSER_HOST_PORT: '0',
    API_HOST_PORT: String(runtime.apiPort),
  };
}

/**
 * Environment for this box's API process (and for the migrate/seed tooling that
 * has to reach the same database).
 *
 * `dotenv` never overrides an already-set variable, so everything set here wins
 * over the repo-root `.env` that `bootstrap.ts` loads — which is exactly how
 * `scripts/dev-stack` gets a worktree's API onto a dynamic database port
 * without editing `.env`. The same mechanism is what lets two API processes
 * share one `.env` and still be two different boxes.
 */
export function apiEnv(
  box: BoxId,
  runtime: BoxRuntime,
  idp: { issuer: string; jwksUri: string },
): NodeJS.ProcessEnv {
  const identity = BOXES[box];

  return {
    ...process.env,
    PORT: String(runtime.apiPort),
    CI_ROLE: 'web',
    DATABASE_HOST: 'localhost',
    DATABASE_PORT: String(runtime.dbPort),
    OBJECT_STORE_URL: `http://localhost:${runtime.objectStorePort}`,
    APP_PUBLIC_HOSTNAME: `127.0.0.1:${runtime.apiPort}`,

    // ── the trust anchor ────────────────────────────────────────────────────
    // Both boxes trust the SAME issuer. That is the realistic shape: CI-Portal
    // is one directory that both Companions authenticate against. What separates
    // them is the AUDIENCE below, not the issuer.
    PORTAL_OIDC_ENABLED: 'true',
    PORTAL_OIDC_ISSUER: idp.issuer,
    PORTAL_OIDC_JWKS_URI: idp.jwksUri,
    // Narrowed to this box alone. The shipped default is a six-entry
    // comma-separated list of first-party client ids; leaving it would mean a
    // token minted for any of them verifies on the non-peer paths.
    PORTAL_OIDC_AUDIENCE: identity.audience,

    // ── this box's own peer identity ────────────────────────────────────────
    // `peers.audience` is the load-bearing one: PeerAskController refuses every
    // inbound ask with a 503 until it is bound, and it passes exactly this value
    // to verifyClaims as the ONLY acceptable audience.
    CI_PEER_HANDLE: identity.handle,
    CI_PEER_AUDIENCE: identity.audience,
    CI_PEER_MEMORY_ENDPOINT: `http://127.0.0.1:${runtime.apiPort}/agent/v1`,
    CI_PEER_TIMEOUT_MS: '10000',
    // No directory: discovery is CI-Portal's job and this harness hand-writes
    // the peer links instead (there is no mutation that creates one — see the
    // Known limitations section of docs/peer-federation.md).
    CI_PEER_DIRECTORY_URL: '',

    ENABLE_ASK: 'true',

    // ── the data-safety pin ────────────────────────────────────────────────
    // The ONLY directory this appliance may resolve an import path into. The
    // owner's 308GB archive is deliberately not on this list: `import-real-data`
    // copies a bounded subset into the staging tree and the server imports the
    // COPY, so a mistyped path cannot reach the original. See realData.ts for
    // why that matters more here than anywhere else.
    //
    // JSON, NOT A BARE PATH. `config/custom-environment-variables.json` declares
    // this one `"__format": "json"`, so node-config runs the value through JSON5
    // before the app sees it — a plain `/some/path` dies at startup with
    // `invalid character 'p' at 1:2`, which names the character and not the
    // variable. Every other env var in this function is a plain string; this is
    // the single exception.
    CI_IMPORT_ROOTS: JSON.stringify([path.join(STATE_DIR, 'staging')]),

    // The import domain's three writable directories, all inside the harness's
    // own state dir. Their shipped defaults (`/var/lib/ci-import/...`,
    // `/var/tmp/ci-import`) belong to the appliance CONTAINER; a host-run API
    // cannot create them and the import dies with
    // `EACCES: permission denied, mkdir '/var/lib/ci-import'` — a 500 to the CLI
    // that says nothing about which directory or why.
    //
    // `CI_IMPORT_INBOX_DIR` is pinned even though this harness never runs
    // `ci inbox`. THE INBOX CONSUMES WHAT IT IMPORTS, BY RENAME, so the
    // one thing worth guaranteeing about it is that it can only ever point at a
    // directory the harness owns and can throw away.
    CI_IMPORT_UPLOADS_DIR: path.join(STATE_DIR, 'import', 'uploads'),
    CI_IMPORT_SCRATCH_DIR: path.join(STATE_DIR, 'import', 'scratch'),
    CI_IMPORT_INBOX_DIR: path.join(STATE_DIR, 'import', 'inbox'),
  };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd = REPO_ROOT): void {
  const result = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });

  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}`);
  }
}

/**
 * Ensure the repo-root `.env` exists.
 *
 * `make init` does this and nothing else does. The API will not boot without it
 * (the auth secrets have no defaults), and a harness that told the owner to run
 * a different make target first would fail its own "one-command bring-up"
 * promise.
 */
export function ensureDotenv(): void {
  const envPath = path.join(REPO_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    return;
  }

  fs.copyFileSync(path.join(REPO_ROOT, '.env.default'), envPath);
  console.log('  · created .env from .env.default (same as `make init`)');
}

export function composeUp(box: BoxId, runtime: BoxRuntime): void {
  const env = composeEnv(box, runtime);

  // `database` and `object-store` are long-running and have healthchecks, so
  // they can be waited on. `setup-database` RUNS TO COMPLETION, and `up --wait`
  // treats a service that exits as a failure unless something in the compose
  // model depends on it with `service_completed_successfully` — which here is
  // only summary/hbpe, and those are not being started. Naming it in the same
  // `--wait` invocation therefore fails the whole bring-up on its clean exit(0).
  // Two invocations, and the second is polled below instead.
  run(
    'docker',
    ['compose', ...COMPOSE_FILES, '--profile', 'local', 'up', '-d', '--wait', 'database', 'object-store'],
    env,
  );
  run('docker', ['compose', ...COMPOSE_FILES, '--profile', 'local', 'up', '-d', 'setup-database'], env);
}

/** Wait for the ephemeral `setup-database` container to finish creating roles. */
export async function waitForSetupDatabase(box: BoxId, runtime: BoxRuntime): Promise<void> {
  const env = composeEnv(box, runtime);
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    const result = spawnSync(
      'docker',
      [
        'compose',
        ...COMPOSE_FILES,
        '--profile',
        'local',
        'ps',
        '-a',
        '--format',
        '{{.Service}}\t{{.State}}\t{{.ExitCode}}',
      ],
      { cwd: REPO_ROOT, env, encoding: 'utf8' },
    );

    const line = (result.stdout ?? '').split('\n').find((l) => l.startsWith('setup-database\t'));
    if (line) {
      const [, state, exitCode] = line.split('\t');
      if (state === 'exited') {
        if (exitCode !== '0') {
          throw new Error(`setup-database for box ${box} exited ${exitCode}`);
        }

        return;
      }
    }

    await sleep(1000);
  }

  throw new Error(`setup-database for box ${box} did not finish in time`);
}

export function composeStop(box: BoxId, runtime: BoxRuntime): void {
  spawnSync('docker', ['compose', ...COMPOSE_FILES, '--profile', 'local', 'stop'], {
    cwd: REPO_ROOT,
    env: composeEnv(box, runtime),
    stdio: 'inherit',
  });
}

/** `down -v`: containers AND this box's volumes. Only ever called by `down --purge`. */
export function composeDestroy(box: BoxId, runtime: BoxRuntime): void {
  spawnSync('docker', ['compose', ...COMPOSE_FILES, '--profile', 'local', 'down', '-v', '--remove-orphans'], {
    cwd: REPO_ROOT,
    env: composeEnv(box, runtime),
    stdio: 'inherit',
  });
}

/**
 * Apply migrations to one box.
 *
 * Routed through the workspace script rather than a bare `dbmate` so it picks up
 * `check:migrations` — the guard that catches a database migrated by a different
 * checkout. `DATABASE_URL` is passed explicitly, exactly as `scripts/dev-stack`
 * does, because it is the one thing that cannot be inferred from `.env` when the
 * host port is not 5432.
 */
export function migrate(box: BoxId, runtime: BoxRuntime): void {
  const user = process.env.DATABASE_USERNAME ?? 'companion';
  const name = process.env.DATABASE_NAME ?? 'companion';
  const password = readDotenvValue('DATABASE_PASSWORD') ?? process.env.DATABASE_PASSWORD ?? '';
  const databaseUrl = `postgres://${user}:${password}@localhost:${runtime.dbPort}/${name}?sslmode=disable`;

  run('yarn', ['workspace', '@ci/be-api', 'migrate'], { ...process.env, DATABASE_URL: databaseUrl });
}

/**
 * Read one value out of the repo-root `.env`.
 *
 * The harness runs under `yarn workspace @ci/be-api run exec`, which sets
 * `DOTENV_CONFIG_PATH` for the API's own bootstrap — but this process is not the
 * API and never calls `dotenv.config()`, so `process.env.DATABASE_PASSWORD` is
 * unset here even though the API will see it. Parsed rather than `dotenv`-loaded
 * to keep the harness from mutating its own environment, which would then be
 * inherited by both boxes' API processes and defeat the per-box overrides.
 */
export function readDotenvValue(key: string): string | undefined {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    return undefined;
  }

  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1 || line.slice(0, eq).trim() !== key) {
      continue;
    }

    return line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }

  return undefined;
}

/** A `pg` client for one box's database. Callers must `end()` it. */
export async function connect(runtime: BoxRuntime): Promise<Client> {
  const client = new Client({
    host: 'localhost',
    port: runtime.dbPort,
    user: process.env.DATABASE_USERNAME ?? 'companion',
    password: readDotenvValue('DATABASE_PASSWORD') ?? process.env.DATABASE_PASSWORD ?? '',
    database: process.env.DATABASE_NAME ?? 'companion',
  });

  await client.connect();

  return client;
}

/**
 * Start one box's API (or its worker) as a detached background process.
 *
 * ═══ WHY BOTH ROLES, WHEN A FEDERATED ASK ONLY NEEDS ONE ═══
 *
 * The Procfile runs `api` (CI_ROLE=web) and `worker` (CI_ROLE=worker) as two
 * processes off the same binary. Nothing on the ask path needs the worker — the
 * consent pipeline, the calendar ingest and the tsvector stages are all `web`.
 * The IMPORT stages are not: `ImportStageListener` declares `role: 'worker'` on
 * all four queues (unpack / parse / media / push), so a web-only box accepts an
 * import, writes an `ci_import.import_runs` row, and leaves it at **`queued`
 * forever** with no error anywhere. `ci --wait` then simply never
 * returns, which reads as a slow import rather than an absent consumer.
 *
 * Starting both keeps the harness's two boxes shaped like a real one and stops
 * `import-real-data` from having a silent floor.
 *
 * `yarn workspace @ci/be-api dev` is deliberately NOT used: it wraps the process
 * in nodemon watching `src`, `config` and `../../../.env`, so an unrelated edit
 * (or the harness's own `.env` creation) restarts a box mid-scenario. The `exec`
 * script is the same ts-node invocation without the watcher, and is what
 * `make seed` already uses to run a one-shot script.
 */
export function startApi(
  box: BoxId,
  runtime: BoxRuntime,
  idp: { issuer: string; jwksUri: string },
  logPath: string,
  role: 'web' | 'worker' = 'web',
): ChildProcess {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  // Created here rather than left to the API: `CI_IMPORT_ROOTS` is validated at
  // boot and an absent root is dropped, so a staging directory that does not
  // exist yet turns "path imports are enabled" into "that path is not permitted"
  // an hour later, when someone finally runs an import.
  for (const dir of ['staging', 'import/uploads', 'import/scratch', 'import/inbox']) {
    fs.mkdirSync(path.join(STATE_DIR, dir), { recursive: true });
  }

  const log = fs.openSync(logPath, 'a');

  const child = spawn('yarn', ['workspace', '@ci/be-api', 'run', 'exec', '--', 'src/main.ts'], {
    cwd: REPO_ROOT,
    // The worker binds no port (see `PORT: '0'` below); everything else about
    // its environment is identical, exactly as the Procfile runs them.
    env: { ...apiEnv(box, runtime, idp), CI_ROLE: role, ...(role === 'worker' ? { PORT: '0' } : {}) },
    // Detached + its own stdio: the API must outlive the `up` command, which
    // returns as soon as both boxes are healthy so the owner gets their shell
    // back. Its output goes to the log file, which `status` points at.
    detached: true,
    stdio: ['ignore', log, log],
  });

  child.unref();

  return child;
}

export async function waitForApi(runtime: BoxRuntime, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${runtime.apiPort}/health`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Not up yet. A NestJS cold boot behind ts-node is 30-60s on this repo.
    }

    await sleep(1500);
  }

  throw new Error(`API on :${runtime.apiPort} did not become healthy within ${timeoutMs}ms`);
}

/** Is a process we previously spawned still alive? */
export function isAlive(pid: number | undefined): boolean {
  if (pid == null) {
    return false;
  }

  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a box's API.
 *
 * The PID recorded in the state file is `yarn`, which spawns node underneath, so
 * the signal goes to the PROCESS GROUP (`-pid`). Signalling `yarn` alone leaves
 * the node process holding the port, and the next `up` then allocates an
 * ephemeral one and quietly runs against a stale box.
 */
export function stopApi(pid: number | undefined): void {
  if (!isAlive(pid) || pid == null) {
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone between the liveness check and here.
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
