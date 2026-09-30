/**
 * ═══════════════════════════════════════════════════════════════════════════
 * "IS THERE A DATABASE HERE?", ANSWERED SYNCHRONOUSLY, FOR ANY DOMAIN'S SPEC.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Several suites need a real Postgres and must SKIP legibly when there is not
 * one, rather than failing every test on a connection error. Answering that
 * needs two things: work out where the database would be from the environment,
 * and find out whether anything is actually listening there.
 *
 * This lived in `domains/pipeline/__tests__/harness/pipelineHarness.ts`, and
 * `domains/audit`'s trigger spec carried a hand-copied duplicate of it with a
 * comment explaining that the copy existed only because
 * `.dependency-cruiser.mjs` forbids reaching into another domain's internals.
 * That was the right reading of the rule and the wrong place to end up: none of
 * this is pipeline-specific, and a copy is exactly how two answers to "can this
 * suite run?" drift apart. It now sits above the domains, where shared test
 * machinery belongs and where the rule explicitly permits importing it.
 *
 * Each suite passes its own override variable names, which is the only thing
 * that ever differed between the copies.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import dotenv from 'dotenv';

// The rest of the toolchain (`yarn test`, `yarn dev`, `yarn dbmate`) runs with
// DOTENV_CONFIG_PATH pointing at the repo-root .env, and `src/bootstrap.ts` is
// what turns that into process.env for the running app. Test files never import
// bootstrap, so the same load happens here, at module scope, BEFORE anything
// reads process.env — otherwise the connection would resolve to nothing on a
// developer machine whose credentials live only in .env.
dotenv.config({ path: path.resolve(process.cwd(), process.env.DOTENV_CONFIG_PATH ?? '.env') });

/** Where a suite will connect. Never carries a hardcoded credential. */
export interface TestDatabaseConnection {
  /** Present when a full URL was supplied; the discrete fields are parsed from it. */
  url?: string;
  host: string;
  port: number;
  username: string;
  database: string;
  /** Read from the environment. Never defaulted — an absent password means "no database". */
  password: string;
}

/**
 * Per-suite environment overrides.
 *
 * A suite names its own variables so it can be pointed at a scratch database
 * without moving the whole app — or the other suites — off the dev one.
 */
export interface TestDatabaseOptions {
  /**
   * Checked before `DATABASE_URL`, e.g. `PIPELINE_TEST_DATABASE_URL`. A list is
   * checked in order and the first one that is set wins — for a suite that
   * answers to its own variable and, failing that, a sibling domain's.
   */
  urlEnvVar?: string | readonly string[];
  /** Probe timeout override, e.g. `PIPELINE_TEST_PROBE_TIMEOUT_MS`. Defaults to 2000 ms. */
  probeTimeoutEnvVar?: string;
}

/**
 * Defaults that are NOT secrets.
 *
 * `config/default.json` says host `database` because the app runs inside the
 * compose network; jest runs on the host, where the published port is what is
 * reachable — which is why `.env` sets `DATABASE_HOST=localhost`. Defaulting to
 * localhost means a developer with a running stack needs no extra setup, while
 * the password is only ever read, never assumed.
 */
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 5432;
const DEFAULT_USERNAME = 'companion';
const DEFAULT_DATABASE = 'companion';
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * The connection, or `null` when the environment does not describe one.
 *
 * Precedence: the suite's own test URL, then the URL the dev-stack supervisor
 * exports, then the discrete `DATABASE_*` variables `config/` already maps.
 */
export function resolveConnection(
  options: TestDatabaseOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): TestDatabaseConnection | null {
  const override = urlEnvVarNames(options).reduce<string | undefined>(
    (found, name) => found ?? env[name],
    undefined,
  );
  const url = override ?? env.DATABASE_URL;

  if (url != null && url.trim().length > 0) {
    try {
      const parsed = new URL(url);

      return {
        url,
        host: parsed.hostname,
        port: parsed.port.length > 0 ? Number(parsed.port) : DEFAULT_PORT,
        username: decodeURIComponent(parsed.username) || DEFAULT_USERNAME,
        password: decodeURIComponent(parsed.password),
        database: parsed.pathname.replace(/^\//, '') || DEFAULT_DATABASE,
      };
    } catch {
      // A malformed URL is a configuration mistake, not an absent database, but
      // it is reported as unavailable (with the reason) rather than thrown so
      // the suite skips legibly instead of failing every test on a parse error.
      return null;
    }
  }

  const password = env.DATABASE_PASSWORD;

  // The one field with no default. Everything else about this database is
  // public knowledge living in config/default.json; the password lives in .env,
  // and its absence is precisely the signal "there is no database here".
  if (password == null || password.length === 0) {
    return null;
  }

  return {
    host: env.DATABASE_HOST ?? DEFAULT_HOST,
    port: Number(env.DATABASE_PORT ?? DEFAULT_PORT),
    username: env.DATABASE_USERNAME ?? DEFAULT_USERNAME,
    database: env.DATABASE_NAME ?? DEFAULT_DATABASE,
    password,
  };
}

/** `TestDatabaseOptions.urlEnvVar` as a list, whatever shape it was given in. */
function urlEnvVarNames(options: TestDatabaseOptions): readonly string[] {
  if (options.urlEnvVar == null) {
    return [];
  }

  return typeof options.urlEnvVar === 'string' ? [options.urlEnvVar] : options.urlEnvVar;
}

/** How a suite should describe its own override in a message: `A or B or DATABASE_URL`. */
function overrideNames(options: TestDatabaseOptions): string {
  return [...urlEnvVarNames(options), 'DATABASE_URL'].join(' or ');
}

/**
 * The connection fields a TypeORM `DataSource` wants, from a resolved
 * connection: the URL when one was supplied (so `?sslmode=` and friends survive),
 * otherwise the discrete fields. Every DB-backed suite used to spell this
 * ternary out inline; the ones that had no discrete-field fallback at all now
 * share it.
 */
export type DataSourceConnectionFields =
  | { url: string }
  | { host: string; port: number; username: string; password: string; database: string };

export function dataSourceConnection(options: TestDatabaseOptions = {}): DataSourceConnectionFields {
  const connection = resolveConnection(options);

  if (connection == null) {
    // Reachable only if the suite skipped its own availability check: the
    // suite's `describe` is chosen from databaseAvailability(), which says
    // "unavailable" whenever this would be null.
    throw new Error(
      `databaseAvailability() said a database was available but resolveConnection() found none (${overrideNames(options)})`,
    );
  }

  return connection.url != null
    ? { url: connection.url }
    : {
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password: connection.password,
        database: connection.database,
      };
}

/** Answer to "can this suite run?", computed without any I/O the caller must await. */
export interface DatabaseAvailability {
  available: boolean;
  /** Human-readable explanation, printed by the spec when it skips. */
  reason: string;
  /** `host:port/database`, never including the password. */
  target: string;
}

/**
 * TCP reachability, SYNCHRONOUSLY.
 *
 * A jest suite must choose `describe` vs `describe.skip` while the module is
 * being evaluated, and these files compile to CommonJS (`jest.config.mjs` →
 * `@swc/jest`), so there is no top-level `await` to reach for. A short-lived
 * child process doing one `net.connect` is the only way to get a real answer at
 * that moment. It costs one process spawn per test file and depends on nothing
 * but a node builtin — notably not `pg`, which the child would have to resolve
 * through Yarn PnP.
 *
 * A TCP handshake proves something is listening, not that it is Postgres with
 * the migrations applied. That split is deliberate: "nothing is listening" is
 * an absent database and must SKIP, whereas "something is listening but the
 * schema is wrong" is a broken setup and must FAIL, with a message naming the
 * command that fixes it.
 *
 * Exported because `pipeline/__tests__/harness/scratchDatabase.ts` asks the same
 * synchronous question about a server it reaches with different
 * (administrative) credentials. It re-exports through the pipeline harness, so
 * there is still exactly one implementation.
 */
export function isPortOpen(host: string, port: number, timeoutMs: number): boolean {
  const script =
    "const net = require('node:net');" +
    'const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]) });' +
    'socket.setTimeout(Number(process.argv[3]));' +
    "socket.on('connect', () => { socket.destroy(); process.exit(0); });" +
    "socket.on('timeout', () => { socket.destroy(); process.exit(1); });" +
    "socket.on('error', () => { process.exit(1); });";

  const probe = spawnSync(process.execPath, ['-e', script, host, String(port), String(timeoutMs)], {
    // Generous relative to the socket's own timeout: this bounds process
    // startup, not the connection, so a merely slow spawn is never misread as
    // an unreachable database.
    timeout: timeoutMs + 5_000,
    stdio: 'ignore',
  });

  return probe.status === 0;
}

/**
 * `CI_REQUIRE_DB=1` — the switch that makes a missing database a FAILURE.
 *
 * Without it, "no database here" means "skip", which is the right default on a
 * laptop with no stack running and the wrong one anywhere a green run is read as
 * proof: a skipped suite is invisible in jest's exit status, so a run with no
 * database — or with one that was briefly unreachable when the probe ran —
 * exits 0 having tested none of the integration coverage. `make test-db` sets
 * this; so should any workflow that provisions a database and means to use it.
 *
 * It changes what {@link databaseAvailability} and
 * `scratchDatabaseAvailability()` do when the answer would be "unavailable":
 * they THROW, at module scope of the spec that asked, so jest reports "Test
 * suite failed to run" and the run goes red, instead of returning
 * `available: false` for the spec to turn into a `describe.skip`.
 */
export const REQUIRE_DB_ENV_VAR = 'CI_REQUIRE_DB';

/** Whether this run must execute its database-backed suites. Only `1` and `true` count. */
export function databaseRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[REQUIRE_DB_ENV_VAR]?.trim().toLowerCase();

  return value === '1' || value === 'true';
}

/**
 * Turn an "unavailable" answer into a thrown error when the run requires a
 * database; pass every other answer through untouched. `subject` says whose
 * skip this would have been, because the thrown message is the only place the
 * failure is explained: the spec never reached its own `describe`.
 */
export function failIfRequired(
  answer: DatabaseAvailability,
  subject: string,
  env: NodeJS.ProcessEnv = process.env,
): DatabaseAvailability {
  if (!answer.available && databaseRequired(env)) {
    throw new Error(
      `${REQUIRE_DB_ENV_VAR}=1 forbids skipping ${subject}, and no database is available: ${answer.reason} ` +
        `(target ${answer.target}). A run that sets ${REQUIRE_DB_ENV_VAR} must execute its database-backed ` +
        `suites, so this is a failure, not a skip. Start a throwaway database with \`make test-db\`, or ` +
        `unset ${REQUIRE_DB_ENV_VAR} to allow the skip.`,
    );
  }

  return answer;
}

/**
 * How many times the port probe is tried before "nothing is listening" is
 * believed, and how long to wait between tries. One failed probe is weak
 * evidence: the answer is a single TCP handshake with a 2 s ceiling, made by a
 * freshly spawned process on a machine that may be running eleven jest workers
 * and a database under load. A blip there used to read as "no database" and skip
 * the suite silently. Three tries a few hundred milliseconds apart cost nothing
 * when the database is up (the first one succeeds) and a fraction of a second
 * when it is genuinely absent.
 */
export const PROBE_ATTEMPTS = 3;
export const PROBE_BACKOFF_MS: readonly number[] = [150, 450];

/** Seams for the unit tests: what actually probes, and what actually waits. */
export interface ProbeDeps {
  probe?: (host: string, port: number, timeoutMs: number) => boolean;
  sleep?: (ms: number) => void;
}

/** A synchronous sleep — the callers are module-scope code with no `await`. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** {@link isPortOpen}, believed only after {@link PROBE_ATTEMPTS} failures in a row. */
export function isPortOpenWithRetry(
  host: string,
  port: number,
  timeoutMs: number,
  deps: ProbeDeps = {},
): boolean {
  const probe = deps.probe ?? isPortOpen;
  const sleep = deps.sleep ?? sleepSync;

  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
    if (probe(host, port, timeoutMs)) {
      return true;
    }

    if (attempt < PROBE_ATTEMPTS) {
      sleep(PROBE_BACKOFF_MS[attempt - 1] ?? PROBE_BACKOFF_MS[PROBE_BACKOFF_MS.length - 1] ?? 0);
    }
  }

  return false;
}

/** Test seams for {@link databaseAvailability}: the environment, the probe, the sleep. */
export interface AvailabilityDeps extends ProbeDeps {
  env?: NodeJS.ProcessEnv;
}

// Keyed by the caller's override names, so two suites in one jest module
// registry cannot read each other's answer. Jest gives each test FILE its own
// registry, so in practice this caches within a file — which is the point: the
// probe spawns a process and a suite may consult it more than once.
const cachedAvailability = new Map<string, DatabaseAvailability>();

/**
 * Whether a Postgres is reachable for this test run. Cached — see above — except
 * when `deps` is passed, which only the unit tests do and which must not leak
 * an injected answer into the cache.
 *
 * THROWS instead of answering "unavailable" when `CI_REQUIRE_DB=1`; see
 * {@link REQUIRE_DB_ENV_VAR}.
 */
export function databaseAvailability(
  options: TestDatabaseOptions = {},
  deps?: AvailabilityDeps,
): DatabaseAvailability {
  const cacheKey = `${urlEnvVarNames(options).join(',')}|${options.probeTimeoutEnvVar ?? ''}`;
  const cached = deps == null ? cachedAvailability.get(cacheKey) : undefined;

  if (cached != null) {
    return cached;
  }

  const env = deps?.env ?? process.env;
  const subject = `the database-backed suite that reads ${overrideNames(options)}`;
  const connection = resolveConnection(options, env);

  if (connection == null) {
    const answer: DatabaseAvailability = {
      available: false,
      reason:
        'no database configured — set ' +
        (urlEnvVarNames(options).length === 0 ? 'DATABASE_URL' : overrideNames(options)) +
        ', or DATABASE_PASSWORD (plus optional DATABASE_HOST / DATABASE_PORT / DATABASE_USERNAME / ' +
        'DATABASE_NAME). `yarn test` already points DOTENV_CONFIG_PATH at the repo-root .env.',
      target: '(unset)',
    };

    failIfRequired(answer, subject, env);

    if (deps == null) {
      cachedAvailability.set(cacheKey, answer);
    }

    return answer;
  }

  const timeoutMs =
    options.probeTimeoutEnvVar == null
      ? DEFAULT_PROBE_TIMEOUT_MS
      : Number(env[options.probeTimeoutEnvVar] ?? DEFAULT_PROBE_TIMEOUT_MS);
  const target = `${connection.host}:${connection.port}/${connection.database}`;

  const answer: DatabaseAvailability = isPortOpenWithRetry(connection.host, connection.port, timeoutMs, deps)
    ? { available: true, reason: `Postgres reachable at ${target}`, target }
    : {
        available: false,
        reason:
          `nothing accepting connections at ${target} ` +
          `(probe timeout ${timeoutMs} ms, ${PROBE_ATTEMPTS} attempts)`,
        target,
      };

  failIfRequired(answer, subject, env);

  if (deps == null) {
    cachedAvailability.set(cacheKey, answer);
  }

  return answer;
}
