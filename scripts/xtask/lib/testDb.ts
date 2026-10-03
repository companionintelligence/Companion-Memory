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
/**
 * A container older than this MIGHT belong to a run that died without cleaning up. Age alone is not
 * enough to remove one — a `--keep` database, or a run on a loaded machine, is legitimately older — so
 * {@link planReap} asks what else is true of it first.
 */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Stamped on a container by `--keep` when it is created: the instant before which the reaper must leave
 * it alone (ISO-8601, UTC). It covers what the live-client check cannot — a kept database between two
 * jest runs has no connections at all. A label cannot be changed on a running container, so the window
 * is fixed at creation; `docker rename` is the way to protect one beyond it.
 *
 * A different key from {@link LABEL_KEY}, not a different value of it: `--filter label=ci.test-db=1`
 * matches the key exactly, so this one never changes which containers are listed.
 */
export const KEEP_UNTIL_LABEL_KEY = 'ci.test-db.keep-until';
/** How long `--keep` protects a container when `--keep-for` does not say: a working day, with margin. */
export const DEFAULT_KEEP_FOR_MS = 24 * 60 * 60 * 1000;
/**
 * The longest `--keep-for` accepts. A guard against a typo that would protect a container for years, and
 * what keeps `now + keepFor` a date `toISOString()` can still print: a value past the Date range throws,
 * and it would throw after the container had been created.
 */
export const MAX_KEEP_FOR_MS = 7 * 24 * 60 * 60 * 1000;

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
 * Containers old enough to be CANDIDATES for reaping: ours, and older than `maxAgeMs`. One whose
 * creation time cannot be read is left alone — an unreadable clock is not grounds for `rm -f`.
 *
 * A candidate is not yet a verdict: {@link planReap} decides which of them are actually removed.
 */
export function selectStale(
  containers: ContainerInfo[],
  now: number,
  maxAgeMs: number = STALE_AFTER_MS,
): ContainerInfo[] {
  return containers.filter((c) => isOurs(c) && c.createdAt !== null && now - c.createdAt > maxAgeMs);
}

/** The value of {@link KEEP_UNTIL_LABEL_KEY} for a container kept until `until`: UTC with milliseconds, so it reads back exactly. */
export function keepUntilLabelValue(until: number): string {
  return new Date(until).toISOString();
}

/**
 * Exactly what {@link keepUntilLabelValue} writes. Stricter than `Date.parse`, which reads `12` as a
 * year and `1` as a month: a hand-typed or damaged label that merely parses as SOMETHING must not be
 * able to protect a container indefinitely, or hand it over for removal early, by accident.
 */
const KEEP_UNTIL_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** When `c`'s keep label says it may next be reaped; null when it has none, or the value is not an ISO-8601 UTC instant. */
export function keepUntil(c: ContainerInfo): number | null {
  const raw = c.labels[KEEP_UNTIL_LABEL_KEY];

  if (raw === undefined || !KEEP_UNTIL_FORMAT.test(raw)) {
    return null;
  }

  const ms = Date.parse(raw);

  return Number.isNaN(ms) ? null : ms;
}

/** What looking inside a candidate for reaping found. */
export type ClientProbe =
  /** `clients` connections other than the probe's own; zero means idle. */
  | { state: 'counted'; clients: number }
  /** Nothing is running in it (created, exited, dead), so nothing can be connected. */
  | { state: 'no-process' }
  /** The daemon would not say, or said something unreadable. Never read as "idle". */
  | { state: 'unknown'; detail: string };

/** Why a candidate for reaping was left alone. */
export type SparedReason =
  { why: 'kept'; until: number } | { why: 'in-use'; clients: number } | { why: 'unverified'; detail: string };

export type Spared = { container: ContainerInfo } & SparedReason;

export interface ReapPlan {
  /** Old enough, not protected, and nothing connected: safe to remove. */
  remove: ContainerInfo[];
  /** Old enough to be candidates, and left alone. */
  spared: Spared[];
}

/**
 * What the stale-container reaper does with a listing. A container is removed only when ALL of:
 *
 *  1. it is ours and older than `maxAgeMs` ({@link selectStale});
 *  2. it is not inside a `--keep` window ({@link keepUntil} is absent, unreadable, or already past);
 *  3. nothing is connected to it — or nothing is running in it at all.
 *
 * Age alone used to decide. It removed a kept database that was idle between two runs (11h old), and
 * would have removed one with a 12-worker jest run connected to it (2h01m old) had its owner not renamed
 * it in time. Check 2 is the cure for the first and check 3 for the second.
 *
 * `probe` is asked only about a candidate that check 2 did not already protect: looking inside a
 * container is a docker exec, and nothing should be exec'd into without a reason. A probe that could
 * not find out is a reason to LEAVE the container, not to remove it.
 */
export function planReap(
  containers: ContainerInfo[],
  now: number,
  probe: (c: ContainerInfo) => ClientProbe,
  maxAgeMs: number = STALE_AFTER_MS,
): ReapPlan {
  const plan: ReapPlan = { remove: [], spared: [] };

  for (const container of selectStale(containers, now, maxAgeMs)) {
    const until = keepUntil(container);

    if (until !== null && until > now) {
      plan.spared.push({ container, why: 'kept', until });

      continue;
    }

    const seen = probe(container);

    if (seen.state === 'unknown') {
      plan.spared.push({ container, why: 'unverified', detail: seen.detail });
    } else if (seen.state === 'counted' && seen.clients > 0) {
      plan.spared.push({ container, why: 'in-use', clients: seen.clients });
    } else {
      plan.remove.push(container);
    }
  }

  return plan;
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

/** Escape `text` for use inside a regular expression (docker's `--filter name=` takes one). */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The `--format` for a `docker ps` whose rows {@link parsePsRows} reads: id, every
 * name, and the value of our label — so the CALLER can check the label itself
 * rather than trust that a `--filter` did.
 */
export const PS_FORMAT = `{{.ID}}|{{.Names}}|{{.Label "${LABEL_KEY}"}}`;

export interface PsRow {
  id: string;
  /** `docker ps` prints every name a container has, comma separated. */
  names: string[];
  /** The value of the ci.test-db label; empty when the container has none. */
  label: string;
}

/** Rows of `docker ps --format PS_FORMAT`. A line that is not three `|`-separated fields is dropped, not guessed at. */
export function parsePsRows(output: string): PsRow[] {
  const rows: PsRow[] = [];

  for (const line of output.split('\n')) {
    const parts = line.trim().split('|');

    if (parts.length !== 3 || !parts[0] || !parts[1]) {
      continue;
    }

    rows.push({ id: parts[0], names: parts[1].split(',').map((n) => n.replace(/^\//, '')), label: parts[2] });
  }

  return rows;
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
  /**
   * `--keep-for`, in ms: how long the kept container is protected from the stale-container reaper.
   * Present only when the flag was given (it implies `keep`); {@link DEFAULT_KEEP_FOR_MS} applies otherwise.
   */
  keepFor?: number;
  image?: string;
  workers: number;
  /**
   * Re-run the test files that failed, once, serially, to tell a flake from a
   * real failure. `--no-retry` turns it off.
   */
  retry: boolean;
  /** Everything destined for jest: path patterns, and anything after `--`. */
  jestArgs: string[];
}

export const DEFAULT_WORKERS = 4;
const MAX_WORKERS = 32;

const OWN_FLAGS = ['--help', '--keep', '--keep-for', '--image', '--workers', '--no-retry'];

const DURATION_UNIT_MS: Readonly<Record<string, number>> = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };

/**
 * The value of `--keep-for`: a whole, positive number and one unit — `30m`, `12h`, `2d` — no longer than
 * {@link MAX_KEEP_FOR_MS}. Anything else (a bare `12`, `1.5h`, `1h30m`, `forever`) is an error rather than
 * a guess about what was meant: the value decides how long a database nobody is watching survives.
 */
export function parseKeepFor(raw: string): number {
  const match = /^(\d+)([mhd])$/.exec(raw);
  const ms = match ? Number(match[1]) * DURATION_UNIT_MS[match[2]] : Number.NaN;

  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(
      `--keep-for must be a whole, positive number with a unit of m, h or d (for example 30m, 12h, 2d), got '${raw}'`,
    );
  }

  if (ms > MAX_KEEP_FOR_MS) {
    throw new Error(
      `--keep-for is at most ${formatAge(MAX_KEEP_FOR_MS)}, got '${raw}'. ` +
        '`docker rename` a container to protect it from the reaper for good.',
    );
  }

  return ms;
}

/**
 * Own flags come first; bare words are jest path patterns; everything after `--`
 * goes to jest untouched. An unrecognised `-flag` before the `--` is an error
 * naming the valid ones, rather than being passed through: a typo'd `--kepp`
 * would otherwise reach jest as a filter and run zero tests.
 */
export function parseTestDbArgs(argv: string[]): TestDbArgs {
  const args: TestDbArgs = { help: false, keep: false, workers: DEFAULT_WORKERS, retry: true, jestArgs: [] };
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
    } else if (flag === '--keep-for') {
      let raw: string;

      [raw, i] = value('--keep-for', i);
      args.keepFor = parseKeepFor(raw);
      // Asking for a window is asking for the container to be kept.
      args.keep = true;
    } else if (flag === '--no-retry') {
      args.retry = false;
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
  'GEOCODE_TEST_DATABASE_URL',
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
  'USER_TEST_DATABASE_URL',
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

/*
 * Parent-environment variables are removed BY NAME, and the rule is deliberately
 * broad, because the failure it guards against — a suite writing to the owner's
 * real corpus — cannot be undone, while the failure of being too broad is that a
 * variable nothing here needs goes missing. A reviewer injected
 * `HBPE_DATABASE_URL`, `PS_REPLICATION_URI`, `POWERSYNC_DATABASE_PASSWORD`,
 * `DB_HOST` and `COMPOSE_PROJECT_NAME` into the parent and every one reached
 * jest under the previous, narrower rule.
 *
 * Two tiers, matched case-insensitively:
 *
 *  1. A name CONTAINING one of DATABASE_WORDS is always dropped — not even the
 *     keep-list below can save it.
 *  2. A name that merely LOOKS like a connection setting (CONNECTION_SHAPED) is
 *     dropped unless it is on the keep-list: anything starting `PG` (libpq),
 *     containing `DB_` or ending `_DB`, ending `_URI` or `_URL` (a connection
 *     string is a URL by another name), or starting `COMPOSE_` (a docker compose
 *     project name can point at the owner's stack). This is where the false
 *     positives live — `ANTHROPIC_BASE_URL` goes, `ADB_SERVER_SOCKET` goes — and
 *     they cost nothing: a jest suite that needs one of them is reading an
 *     environment it should not be.
 */
const DATABASE_WORDS = /DATABASE|POSTGRES|REPLICATION|POWERSYNC/i;
const CONNECTION_SHAPED = /(^PG|DB_|_DB$|_URI$|_URL$|^COMPOSE_)/i;

/**
 * Set by this command, so whatever the parent had is dropped first even though
 * neither matches the rules above.
 */
const SET_BY_US = /^(DOTENV_CONFIG_PATH|CI_REQUIRE_DB)$/;

/**
 * The keep-list: names that must survive tier 2 because the toolchain needs
 * them, checked against what yarn, jest and the docker CLI actually read. It is
 * tiny on purpose — everything not matching a rule above already passes through,
 * so this list only ever overrides the tier-2 heuristics.
 *
 *   PATH, HOME, TMPDIR, USER, LOGNAME, SHELL   process basics: yarn resolves its
 *                                              binary and cache from them
 *   NODE_OPTIONS                               yarn PnP injects `--require .pnp.cjs`
 *                                              and its loader through it
 *   YARN_*                                     yarn's own configuration
 *   TERM, CI, TZ, LANG, LC_*                   output and locale behaviour of jest
 *   DOCKER_HOST, DOCKER_CONFIG                 which daemon and credentials the
 *                                              docker CLI (used by this command
 *                                              and by suites that shell out) reaches
 */
export const KEEP_ENV_NAMES: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  'NODE_OPTIONS',
  'TERM',
  'CI',
  'TZ',
  'LANG',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
];
export const KEEP_ENV_PREFIXES: readonly string[] = ['YARN_', 'LC_'];

const isKept = (name: string): boolean =>
  KEEP_ENV_NAMES.includes(name) || KEEP_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));

/**
 * Could this variable name a database (or a way to reach one)? True means it
 * must not reach jest or the migrations unless {@link buildTestEnv} set it
 * itself. Names are matched case-insensitively.
 */
export function isDatabaseShaped(name: string): boolean {
  if (DATABASE_WORDS.test(name) || SET_BY_US.test(name)) {
    return true;
  }

  return !isKept(name) && CONNECTION_SHAPED.test(name);
}

export interface Throwaway {
  port: number;
  appPassword: string;
  adminPassword: string;
}

/** A password no human will ever type: hex, so it needs no quoting anywhere it lands. */
export function randomPassword(): string {
  return randomBytes(24).toString('hex');
}

/** The parent environment with every {@link isDatabaseShaped} variable removed. */
export function scrubEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(parent).filter(([key]) => !isDatabaseShaped(key)));
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

/** Every variable {@link buildTestEnv} sets on purpose: the only database-shaped names allowed in the final environment. */
const THROWAWAY_VARS: ReadonlySet<string> = new Set([
  'DATABASE_URL',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_USERNAME',
  'DATABASE_PASSWORD',
  'DATABASE_NAME',
  'DATABASE_ADMIN_USERNAME',
  'DATABASE_ADMIN_PASSWORD',
  'CI_REQUIRE_DB',
  'DOTENV_CONFIG_PATH',
  ...TEST_DATABASE_URL_VARS,
  ...TEST_ADMIN_URL_VARS,
]);

/**
 * The last line of defence, run on the FINISHED environment before any child
 * process starts, and independent of {@link scrubEnv}: it does not assume the
 * scrub worked.
 *
 * Two rules. A variable this command sets must say what it should — a URL names
 * the throwaway's loopback port, a `*HOST` is loopback, a `*PORT` is the port.
 * And a database-shaped variable this command did NOT set must not be there at
 * all, whatever its value: had it come from the parent, the scrub missed it, and
 * `localhost:5432` is the owner's real database.
 *
 * Reports the VARIABLE, never its value — the values are connection strings
 * with passwords in them.
 */
export function assertOnlyThrowaway(env: NodeJS.ProcessEnv, port: number): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }

    if (!THROWAWAY_VARS.has(key)) {
      if (isDatabaseShaped(key)) {
        throw new Error(
          `${key} is a database-shaped variable this command did not set — refusing to run tests with it`,
        );
      }

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

/** A coarse span for a message about a container's age or protection: `45m`, `2h`, `2h 01m`, `24h`, `2d 3h`. */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  // Hours up to two days, so the default window reads as the `24h` it is typed as.
  if (hours < 48) {
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  }

  return hours % 24 === 0 ? `${hours / 24}d` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * What `--keep` prints once the run is over: how to reach the database, how to remove it, and — in place
 * of the old "the next `make test-db` removes it anyway once it is more than two hours old" — what
 * protects it from the stale-container reaper, for how long, and how to protect it longer.
 */
export function keptNotice(
  name: string,
  port: number,
  appPassword: string,
  until: number,
  now: number,
): string[] {
  const indent = ' '.repeat(22);
  // The notice is printed when the run ends, so the time left is rounded UP: a window made a moment ago reads
  // as the `3h` it was asked for, not `2h 59m`.
  const remaining = Math.ceil((until - now) / 60_000) * 60_000;

  return [
    `Kept ${name} on ${LOOPBACK}:${port} (throwaway; loopback only).`,
    `  psql as superuser:  docker exec -it ${name} psql -U postgres -d ${APP_DATABASE}`,
    `  application URL:    postgres://${APP_ROLE}:${appPassword}@${LOOPBACK}:${port}/${APP_DATABASE}?sslmode=disable`,
    `  remove it:          docker rm -f -v ${name}`,
    `  protected until:    ${keepUntilLabelValue(until)} (${formatAge(remaining)} from now): a later \`make test-db\``,
    `${indent}will not remove it before then, nor while anything is connected to it`,
    `  protect longer:     --keep-for <duration> on the next run (default ${formatAge(DEFAULT_KEEP_FOR_MS)}, at most ${formatAge(MAX_KEEP_FOR_MS)}); this window is fixed.`,
    `${indent}Or rename it so it no longer matches ci-testdb-*:  docker rename ${name} <new name>`,
  ];
}
