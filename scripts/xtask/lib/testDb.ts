/**
 * The pure parts of `xtask test-db`: argument parsing, image choice, which
 * containers are ours to remove, and — the part that matters most — the
 * environment the suites run under. Nothing here touches Docker or the
 * filesystem, so all of it is unit-tested.
 *
 * ── The one rule this file exists to enforce ───────────────────────────────
 *
 * A DB-backed jest suite must NEVER reach a database it did not create. The
 * owner's appliance is a Postgres on host port 5432 holding an imported corpus,
 * `.env` names it, `yarn workspace @ci/be-api test` reads that `.env`, and the
 * suites write rows. So `buildTestEnv` starts from the parent environment with
 * every database-shaped variable REMOVED and then sets each one it needs to the
 * throwaway container; `assertOnlyThrowaway` re-checks the finished environment
 * and throws if any of them points anywhere else. Both run before the first
 * child process is started.
 */
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Container ownership
// ---------------------------------------------------------------------------

/** Every container this command creates is named with this prefix... */
export const CONTAINER_PREFIX = 'ci-testdb-';
/** ...and carries this label. A container is ours only if it has BOTH. */
export const LABEL_KEY = 'ci.test-db';
export const LABEL_VALUE = '1';
/** A container older than this belongs to a run that died without cleaning up. */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export interface ContainerInfo {
  id: string;
  /** Without the leading slash `docker inspect` puts on it. */
  name: string;
  /** Epoch ms, or null when the timestamp did not parse. */
  createdAt: number | null;
  labels: Record<string, string>;
}

/** Ours: the name prefix AND the label. Either alone is not enough to be removed. */
export function isOurs(c: ContainerInfo): boolean {
  return c.name.startsWith(CONTAINER_PREFIX) && c.labels[LABEL_KEY] === LABEL_VALUE;
}

/**
 * Containers this command may reap: ours, and older than `maxAgeMs`. One whose
 * creation time cannot be read is left alone — an unreadable clock is not
 * grounds for `rm -f`.
 */
export function selectStale(
  containers: ContainerInfo[],
  now: number,
  maxAgeMs: number = STALE_AFTER_MS,
): ContainerInfo[] {
  return containers.filter((c) => isOurs(c) && c.createdAt !== null && now - c.createdAt > maxAgeMs);
}

/**
 * Parse `docker inspect --format '{{.Id}}|{{.Name}}|{{.Created}}|{{json .Config.Labels}}'`
 * lines. Malformed lines are dropped rather than guessed at.
 */
export function parseInspectContainers(output: string): ContainerInfo[] {
  const containers: ContainerInfo[] = [];

  for (const line of output.split('\n')) {
    const [id, name, created, ...rest] = line.trim().split('|');

    if (!id || !name || !created) {
      continue;
    }

    let labels: Record<string, string> = {};

    try {
      const parsed: unknown = JSON.parse(rest.join('|') || 'null');

      if (parsed !== null && typeof parsed === 'object') {
        labels = parsed as Record<string, string>;
      }
    } catch {
      continue;
    }

    const ms = Date.parse(created);

    containers.push({
      id,
      name: name.replace(/^\//, ''),
      createdAt: Number.isNaN(ms) ? null : ms,
      labels,
    });
  }

  return containers;
}

/** A fresh container name: unguessable enough that two concurrent runs never collide. */
export function newContainerName(): string {
  return `${CONTAINER_PREFIX}${randomBytes(4).toString('hex')}`;
}

/** `127.0.0.1:61778` (and, on some hosts, a second `[::]:61778` line) → 61778. */
export function parseDockerPort(output: string): number {
  const match = /:(\d{2,5})\s*$/m.exec(output.trim());

  if (!match) {
    throw new Error(`could not read a published port out of: ${JSON.stringify(output.trim())}`);
  }

  return Number(match[1]);
}

// ---------------------------------------------------------------------------
// Image choice
// ---------------------------------------------------------------------------

/** What `make dev` builds and runs, so the tests run against the same bytes. */
export const LOCAL_IMAGE = 'ci/database:latest';

/**
 * The database image `.github/workflows/ci.yml`'s backend job pins as its
 * `postgres` service — read from that file rather than copied here, so there is
 * one place the pin is bumped.
 */
export function parseCiDatabaseImage(ciYml: string): string {
  const service = /^ {6}postgres:\s*\n((?: {8}.*\n|\s*\n)+)/m.exec(ciYml);
  const image = service ? /^ {8}image:\s*(\S+)/m.exec(service[1]) : null;

  if (!image) {
    throw new Error(
      'could not find the `postgres` service image in .github/workflows/ci.yml — pass --image explicitly',
    );
  }

  return image[1];
}

export interface ImageChoice {
  ref: string;
  source: 'flag' | 'local' | 'ci-pin';
}

/** `--image` wins; else the local dev image when present; else the pin CI uses. */
export function chooseImage(opts: {
  flag?: string;
  localPresent: boolean;
  ciPin: () => string;
}): ImageChoice {
  if (opts.flag) {
    return { ref: opts.flag, source: 'flag' };
  }

  if (opts.localPresent) {
    return { ref: LOCAL_IMAGE, source: 'local' };
  }

  return { ref: opts.ciPin(), source: 'ci-pin' };
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface TestDbArgs {
  help: boolean;
  keep: boolean;
  image?: string;
  workers: number;
  /** Everything destined for jest: path patterns, and anything after `--`. */
  jestArgs: string[];
}

export const DEFAULT_WORKERS = 4;
const MAX_WORKERS = 32;

const OWN_FLAGS = ['--help', '--keep', '--image', '--workers'];

/**
 * Own flags come first; bare words are jest path patterns; everything after `--`
 * goes to jest untouched. An unrecognised `-flag` before the `--` is an error
 * naming the valid ones, rather than being passed through: a typo'd `--kepp`
 * would otherwise reach jest as a filter and run zero tests.
 */
export function parseTestDbArgs(argv: string[]): TestDbArgs {
  const args: TestDbArgs = { help: false, keep: false, workers: DEFAULT_WORKERS, jestArgs: [] };
  const dashDash = argv.indexOf('--');
  const own = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const rest = dashDash === -1 ? [] : argv.slice(dashDash + 1);

  const value = (flag: string, i: number): [string, number] => {
    const token = own[i];
    const eq = token.indexOf('=');

    if (eq !== -1) {
      return [token.slice(eq + 1), i];
    }

    const next = own[i + 1];

    if (next === undefined || next.startsWith('-')) {
      throw new Error(`${flag} needs a value`);
    }

    return [next, i + 1];
  };

  for (let i = 0; i < own.length; i += 1) {
    const token = own[i];
    const flag = token.split('=')[0];

    if (flag === '--help' || token === '-h') {
      args.help = true;
    } else if (flag === '--keep') {
      args.keep = true;
    } else if (flag === '--image') {
      let image: string;

      [image, i] = value('--image', i);
      args.image = image;
    } else if (flag === '--workers') {
      let raw: string;

      [raw, i] = value('--workers', i);

      const n = Number(raw);

      if (!Number.isInteger(n) || n < 1 || n > MAX_WORKERS) {
        throw new Error(`--workers must be an integer from 1 to ${MAX_WORKERS}, got '${raw}'`);
      }

      args.workers = n;
    } else if (token.startsWith('-')) {
      throw new Error(
        `Unknown flag '${token}'. Flags for this command: ${OWN_FLAGS.join(', ')}. ` +
          `To pass a flag to jest, put it after '--' (for example: xtask test-db -- ${token}).`,
      );
    } else {
      args.jestArgs.push(token);
    }
  }

  args.jestArgs.push(...rest);

  return args;
}

/** Whether the caller already chose a worker count, so ours must not fight it. */
export function jestChoosesWorkers(jestArgs: string[]): boolean {
  return jestArgs.some((a) => /^(--maxWorkers|-w$|--runInBand|-i$)/.test(a));
}

/** Whether jest was asked to filter tests by NAME, which makes every other test report as skipped. */
export function jestFiltersByName(jestArgs: string[]): boolean {
  return jestArgs.some((a) =>
    /^(--testNamePattern|-t$|--onlyFailures|--findRelatedTests|--onlyChanged|-o$)/.test(a),
  );
}

// ---------------------------------------------------------------------------
// The environment the suites run under
// ---------------------------------------------------------------------------

/**
 * Every `<DOMAIN>_TEST_DATABASE_URL` any suite reads, jest and pytest both. A
 * unit test greps the source tree and fails when this list and the tree
 * disagree, so a suite that starts reading a new one cannot go unset here.
 */
export const TEST_DATABASE_URL_VARS: readonly string[] = [
  'ASKS_TEST_DATABASE_URL',
  'AUTH_TEST_DATABASE_URL',
  'BROWSER_ACTIVITY_TEST_DATABASE_URL',
  'CONNECTIONS_TEST_DATABASE_URL',
  'EVENTS_TEST_DATABASE_URL',
  'IMPORT_TEST_DATABASE_URL',
  'MACOS_TEST_DATABASE_URL',
  'MEMORY_TEST_DATABASE_URL',
  'NOTES_TEST_DATABASE_URL',
  'PEERS_TEST_DATABASE_URL',
  'PERSISTENCE_TEST_DATABASE_URL',
  'PERSONALIZATION_TEST_DATABASE_URL',
  'PIPELINE_TEST_DATABASE_URL',
  'PLANNING_TEST_DATABASE_URL',
  'PORTABILITY_TEST_DATABASE_URL',
  'SCHEDULE_TEST_DATABASE_URL',
  'SEARCH_INGRESS_TEST_DATABASE_URL',
  'SEARCH_NEXT_TEST_DATABASE_URL',
];

/** The variables that carry an ADMIN (superuser) URL, for suites that create their own database. */
export const TEST_ADMIN_URL_VARS: readonly string[] = ['PIPELINE_TEST_ADMIN_DATABASE_URL'];

/**
 * Variables that must point at a database with NOTHING in it. Python's macOS
 * activity suite runs `CREATE SCHEMA ci` and refuses a database that already has
 * one, so it cannot share the migrated `companion`; `bootstrap.sql` makes it one.
 */
export const EMPTY_DATABASE_VARS: readonly string[] = ['MACOS_TEST_DATABASE_URL'];

export const APP_DATABASE = 'companion';
export const EMPTY_DATABASE = 'companion_empty';
export const APP_ROLE = 'companion';
export const ADMIN_ROLE = 'postgres';
export const LOOPBACK = '127.0.0.1';

/** Names of parent-environment variables that could point a suite at some other database. */
const DATABASE_SHAPED =
  /^(DATABASE_|PG[A-Z_]*$|POSTGRES_|.*_TEST_(ADMIN_)?DATABASE_URL$|DOTENV_CONFIG_PATH$|CI_REQUIRE_DB$)/;

export interface Throwaway {
  port: number;
  appPassword: string;
  adminPassword: string;
}

/** A password no human will ever type: hex, so it needs no quoting anywhere it lands. */
export function randomPassword(): string {
  return randomBytes(24).toString('hex');
}

/** The parent environment with every database-shaped variable removed. */
export function scrubEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(parent).filter(([key]) => !DATABASE_SHAPED.test(key)));
}

const urlFor = (user: string, password: string, port: number, database: string, query = ''): string =>
  `postgres://${user}:${password}@${LOOPBACK}:${port}/${database}${query}`;

/**
 * The full environment for migrations and jest: the scrubbed parent, then
 * everything a suite might read, all pointing at the throwaway.
 *
 * `DOTENV_CONFIG_PATH` names a file that does not exist. Every entry point the
 * suites and migrations go through loads `.env` from that path and dotenv never
 * overrides a variable that is already set — so the values above would win
 * anyway — but a variable NOT set above (a future one) would otherwise come
 * straight from the operator's real `.env`. Pointing at nothing closes that.
 */
export function buildTestEnv(
  parent: NodeJS.ProcessEnv,
  db: Throwaway,
  nonexistentDotenv: string,
): NodeJS.ProcessEnv {
  const env = scrubEnv(parent);
  const appUrl = urlFor(APP_ROLE, db.appPassword, db.port, APP_DATABASE, '?sslmode=disable');

  Object.assign(env, {
    DATABASE_URL: appUrl,
    DATABASE_HOST: LOOPBACK,
    DATABASE_PORT: String(db.port),
    DATABASE_USERNAME: APP_ROLE,
    DATABASE_PASSWORD: db.appPassword,
    DATABASE_NAME: APP_DATABASE,
    DATABASE_ADMIN_USERNAME: ADMIN_ROLE,
    DATABASE_ADMIN_PASSWORD: db.adminPassword,
    CI_REQUIRE_DB: '1',
    DOTENV_CONFIG_PATH: nonexistentDotenv,
  });

  for (const name of TEST_DATABASE_URL_VARS) {
    env[name] = EMPTY_DATABASE_VARS.includes(name)
      ? urlFor(APP_ROLE, db.appPassword, db.port, EMPTY_DATABASE)
      : appUrl;
  }

  for (const name of TEST_ADMIN_URL_VARS) {
    env[name] = urlFor(ADMIN_ROLE, db.adminPassword, db.port, 'postgres');
  }

  return env;
}

/**
 * Throw if any database-shaped variable in `env` names a host other than the
 * throwaway's loopback port. Reports the VARIABLE, never its value — the values
 * are connection strings with passwords in them.
 */
export function assertOnlyThrowaway(env: NodeJS.ProcessEnv, port: number): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !/^(DATABASE_|PG[A-Z_]*$|.*_TEST_(ADMIN_)?DATABASE_URL$)/.test(key)) {
      continue;
    }

    if (/^\w+:\/\//.test(value)) {
      let url: URL;

      try {
        url = new URL(value);
      } catch {
        throw new Error(`${key} is set to something that is not a URL — refusing to run tests with it`);
      }

      if (url.hostname !== LOOPBACK || url.port !== String(port)) {
        throw new Error(
          `${key} points at ${url.hostname}:${url.port || '(default port)'}, not the throwaway database at ${LOOPBACK}:${port} — refusing to run tests`,
        );
      }
    } else if (/HOST(ADDR)?$/.test(key) && value !== LOOPBACK) {
      throw new Error(`${key} is set to a host other than ${LOOPBACK} — refusing to run tests`);
    } else if (key.endsWith('PORT') && value !== String(port)) {
      throw new Error(`${key} is set to a port other than ${port} — refusing to run tests`);
    }
  }
}

/** Human-readable duration: `6m 12s`, `48s`, `950ms`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;

  return m === 0 ? `${s}s` : `${m}m ${String(s).padStart(2, '0')}s`;
}
