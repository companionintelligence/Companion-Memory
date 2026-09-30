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
 *
 * ── A skip needs PROOF, and only an unasked-for database may skip ──────────
 *
 * A skipped suite and a passing one look the same from a distance — jest exits
 * 0 for both — so a skip is only allowed when two things are true: there is
 * positive evidence that no database is there, and nobody asked for one. Every
 * other case either runs or FAILS, with a message saying why:
 *
 *   configuration                  probe                        answer
 *   ─────────────────────────────  ───────────────────────────  ──────
 *   nothing configured             (not probed)                 skip
 *   `.env`'s DATABASE_* values     connection refused           skip
 *   a URL set for this run         connection refused           FAIL
 *   anything                       open                         run
 *   anything                       no answer / probe failed     FAIL
 *   a URL that does not parse      (not probed)                 FAIL
 *
 * "Asked for" means a connection URL — the suite's own `<SUITE>_TEST_DATABASE_URL`
 * or `DATABASE_URL` — set in the environment the test run was started with.
 * The discrete `DATABASE_*` variables never count: `.env.default` ships them,
 * so every checkout that has run `make dev` has them, and they describe where
 * the dev stack's database WOULD be, not a promise that it is up. A URL that
 * `.env` itself filled in does not count either, for the same reason.
 *
 * The row that was missing until 2026-09-30 is "probe failed". The probe is a
 * child process, and a child that did not get to finish — killed by its time
 * limit on a machine too busy to start it — used to read exactly like "nothing
 * listening": a resolver suite skipped all seven of its tests, silently, in a
 * loaded 69-suite run with both of its variables pointing at a healthy
 * Postgres, and passed when run on its own. A probe that could not answer says
 * nothing about the database, so it can no longer produce a skip.
 *
 * `CI_REQUIRE_DB=1` (what `make test-db` sets) turns the two remaining skips
 * into failures as well. A run that asked for a database and did not get one
 * must not exit 0.
 */
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import path from 'node:path';

import dotenv from 'dotenv';

// The rest of the toolchain (`yarn test`, `yarn dev`, `yarn dbmate`) runs with
// DOTENV_CONFIG_PATH pointing at the repo-root .env, and `src/bootstrap.ts` is
// what turns that into process.env for the running app. Test files never import
// bootstrap, so the same load happens here, at module scope, BEFORE anything
// reads process.env — otherwise the connection would resolve to nothing on a
// developer machine whose credentials live only in .env.
const setBeforeDotenv = new Set(Object.keys(process.env));
const dotenvLoad = dotenv.config({
  path: path.resolve(process.cwd(), process.env.DOTENV_CONFIG_PATH ?? '.env'),
});

/**
 * The variables `.env` FILLED IN: present in the file, absent from the
 * environment the test run started with. dotenv never overrides a variable that
 * is already set, so these are exactly the ones whose value came from the file
 * rather than from whoever ran jest — which is the difference between "the dev
 * stack might be here" and "I am telling you a database is here".
 */
const SUPPLIED_BY_DOTENV: ReadonlySet<string> = new Set(
  Object.keys(dotenvLoad.parsed ?? {}).filter((name) => !setBeforeDotenv.has(name)),
);

/**
 * Whether `name` holds a value set for this run, rather than one `.env` filled
 * in. Blank counts as unset. See the table at the top of this file.
 */
export function isExplicitlySet(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  suppliedByDotenv: ReadonlySet<string> = SUPPLIED_BY_DOTENV,
): boolean {
  const value = env[name];

  return value != null && value.trim().length > 0 && !suppliedByDotenv.has(name);
}

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

/** `TestDatabaseOptions.urlEnvVar` as a list, whatever shape it was given in. */
function urlEnvVarNames(options: TestDatabaseOptions): readonly string[] {
  if (options.urlEnvVar == null) {
    return [];
  }

  return typeof options.urlEnvVar === 'string' ? [options.urlEnvVar] : options.urlEnvVar;
}

/** Suite overrides, then `DATABASE_URL`, without naming that fallback twice. */
function configurationUrlVariables(options: TestDatabaseOptions): readonly string[] {
  const names = [...urlEnvVarNames(options)];

  if (!names.includes('DATABASE_URL')) {
    names.push('DATABASE_URL');
  }

  return names;
}

/** How a message names the variables a suite reads: `A or B or DATABASE_URL`. */
function overrideLabel(options: TestDatabaseOptions): string {
  return configurationUrlVariables(options).join(' or ');
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
 * What the environment says about a suite's database, before anything is
 * probed.
 *
 * `explicit` is the "asked for" column of the table at the top of this file:
 * true only for a connection URL set for this run. A malformed URL is its own
 * case rather than "nothing configured", because it is the opposite — someone
 * configured a database and got it wrong.
 */
export type TestDatabaseConfiguration =
  | { kind: 'none' }
  | { kind: 'malformed'; variable: string }
  | { kind: 'configured'; variable: string; explicit: boolean; connection: TestDatabaseConnection };

/**
 * Read the configuration out of `env`.
 *
 * Precedence: the suite's own test URL, then the URL the dev-stack supervisor
 * exports, then the discrete `DATABASE_*` variables `config/` already maps. A
 * blank variable counts as unset and falls through to the next one.
 */
export function resolveConfiguration(
  options: TestDatabaseOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  suppliedByDotenv: ReadonlySet<string> = SUPPLIED_BY_DOTENV,
): TestDatabaseConfiguration {
  const urlVariables = configurationUrlVariables(options);

  for (const variable of urlVariables) {
    const url = env[variable];

    if (url == null || url.trim().length === 0) {
      continue;
    }

    try {
      const parsed = new URL(url);

      return {
        kind: 'configured',
        variable,
        explicit: !suppliedByDotenv.has(variable),
        connection: {
          url,
          // WHATWG keeps the brackets on an IPv6 literal (`[::1]`); a socket wants the address.
          host: parsed.hostname.replace(/^\[(.*)\]$/, '$1'),
          port: parsed.port.length > 0 ? Number(parsed.port) : DEFAULT_PORT,
          username: decodeURIComponent(parsed.username) || DEFAULT_USERNAME,
          password: decodeURIComponent(parsed.password),
          database: parsed.pathname.replace(/^\//, '') || DEFAULT_DATABASE,
        },
      };
    } catch {
      return { kind: 'malformed', variable };
    }
  }

  const password = env.DATABASE_PASSWORD;

  // The one field with no default. Everything else about this database is
  // public knowledge living in config/default.json; the password lives in .env,
  // and its absence is precisely the signal "there is no database here".
  if (password == null || password.length === 0) {
    return { kind: 'none' };
  }

  return {
    kind: 'configured',
    variable: 'DATABASE_PASSWORD',
    // Never explicit, wherever it came from: see TestDatabaseConfiguration.
    explicit: false,
    connection: {
      host: env.DATABASE_HOST ?? DEFAULT_HOST,
      port: Number(env.DATABASE_PORT ?? DEFAULT_PORT),
      username: env.DATABASE_USERNAME ?? DEFAULT_USERNAME,
      database: env.DATABASE_NAME ?? DEFAULT_DATABASE,
      password,
    },
  };
}

/**
 * The connection, or `null` when the environment does not describe a usable
 * one — nothing configured, or a URL that does not parse. For the difference
 * between those two, which decides skip versus fail, use
 * {@link resolveConfiguration}.
 */
export function resolveConnection(
  options: TestDatabaseOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  suppliedByDotenv: ReadonlySet<string> = SUPPLIED_BY_DOTENV,
): TestDatabaseConnection | null {
  const configuration = resolveConfiguration(options, env, suppliedByDotenv);

  return configuration.kind === 'configured' ? configuration.connection : null;
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
      `databaseAvailability() said a database was available but resolveConnection() found none (${overrideLabel(options)})`,
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

/**
 * `CI_REQUIRE_DB=1` — the switch that makes a missing database a FAILURE.
 *
 * The table above already fails an explicitly requested database that is not
 * there. What it still skips is "nothing configured" and "only `.env`'s
 * discrete variables, and that port refused". `make test-db` sets this so
 * those skips fail too: a run that provisioned a database and meant to use it
 * must not exit 0 having skipped the integration coverage.
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

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/**
 * What a reachability probe found.
 *
 *  - `open`: something accepted a TCP connection.
 *  - `refused`: the network stack said nobody is there — connection refused,
 *    unknown host, no route. The only outcome that is evidence of absence.
 *  - `unanswered`: nothing answered within the socket timeout. A host that is
 *    down behind a firewall looks like this; so does a wedged proxy.
 *  - `inconclusive`: the probe itself did not get to answer — its process
 *    could not be started, was killed by its time limit, or reported something
 *    it was not written to report. This says NOTHING about the database.
 */
export type PortProbeOutcome = 'open' | 'refused' | 'unanswered' | 'inconclusive';

export interface PortProbe {
  outcome: PortProbeOutcome;
  /** One line for a message: what was observed, per attempt when there were several. */
  detail: string;
  /** Probe processes it took to get this answer. */
  attempts: number;
}

/** The slice of `spawnSync` the probe uses — injectable, so the classification is testable without a busy machine. */
export type ProbeSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export interface PortProbeOptions {
  /** Socket timeout for the connection attempt itself. */
  timeoutMs: number;
  /** Probe processes to try before accepting an `unanswered` or `inconclusive` result. Default 3. */
  attempts?: number;
  /**
   * Time a probe process is allowed for STARTING, on top of `timeoutMs`.
   * Default 10 000 ms. See {@link DEFAULT_STARTUP_ALLOWANCE_MS}.
   */
  startupAllowanceMs?: number;
  spawn?: ProbeSpawn;
}

/**
 * How long a probe process gets to start, separately from the socket timeout.
 *
 * Starting node is nearly all of what the probe costs — the connect itself
 * takes about a millisecond — and start-up is exactly the part that grows with
 * load. Measured on 2026-09-30 (12 cores, a healthy Postgres, the old limit of
 * socket timeout + 5 s = 7 s, the child still carrying the Yarn PnP preload):
 *
 *   load ~100  start-up p50 0.8 s, max 3.0 s — none of 86 probes killed
 *   load ~340  start-up p50 4.2 s — 14 of 30 probes KILLED at 7 s, every one
 *              `status: null, SIGTERM, ETIMEDOUT`, and so read as "no database"
 *              (one had already connected when it was killed)
 *
 * Without the preload (see {@link probeEnvironment}) the same load gave p50
 * 1.1 s and 1 of 30 killed — better, not enough. Hence a longer limit and
 * retries as well, and above all a killed probe reading as `inconclusive`,
 * which can never produce a skip. The allowance costs nothing on an idle
 * machine: a child that finishes early returns early.
 */
const DEFAULT_STARTUP_ALLOWANCE_MS = 10_000;
const DEFAULT_PROBE_ATTEMPTS = 3;

/**
 * The only error codes that mean "nobody is there". Anything else — EMFILE,
 * EAI_AGAIN, EPERM — is the probe's own trouble and proves nothing either way.
 */
const ABSENCE_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * The probe process. It reports exactly one line on stdout and exits 0
 * whenever it got that far, so "the probe answered" (status 0 plus a line) can
 * never be confused with "the probe never got to answer" (anything else). Exit
 * codes alone cannot do that: node itself exits 1 when it crashes on start-up,
 * which is what a closed port used to exit with too.
 *
 * The timeout handler decides one event-loop turn late on purpose. Timers run
 * before I/O in a turn, so a process that was descheduled for longer than the
 * timeout wakes with the timer due AND the connection already complete; waiting
 * for `setImmediate` lets the poll phase report the connection first.
 */
const PROBE_SCRIPT = [
  "const fs = require('node:fs');",
  "const net = require('node:net');",
  "const report = (line) => { fs.writeSync(1, 'ci-db-probe ' + line + '\\n'); process.exit(0); };",
  'const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]) });',
  "socket.on('connect', () => report('open'));",
  'socket.setTimeout(Number(process.argv[3]));',
  "socket.on('timeout', () => setImmediate(() => report('unanswered')));",
  "socket.on('error', (error) => report('error ' + (error.code || (error.errors && error.errors[0] && error.errors[0].code) || 'UNKNOWN')));",
].join('\n');

const PROBE_REPORT = /^ci-db-probe (open|unanswered|error ([A-Z0-9_]+))$/m;

/**
 * The probe's environment: this process's, minus `NODE_OPTIONS`.
 *
 * Under `yarn jest`, `NODE_OPTIONS` carries Yarn PnP into every node process —
 * `--require .pnp.cjs` (a 2.3 MB dependency map) and an `--experimental-loader`
 * that node runs on a thread of its own. The probe uses node builtins only and
 * needs neither, and inheriting them made it three to four times slower to
 * start (2026-09-30: ~130-220 ms bare against ~410-640 ms, at load ~95).
 */
function probeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  delete env.NODE_OPTIONS;

  return env;
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
 * the migrations applied. That split is deliberate: "nothing is listening" may
 * be an absent database, whereas "something is listening but the schema is
 * wrong" is a broken setup and must FAIL, with a message naming the command
 * that fixes it.
 *
 * `unanswered` and `inconclusive` are what a stall looks like, so they get
 * another process, up to `attempts`; `open` and `refused` are final.
 *
 * Exported because `scratchDatabase.ts` asks the same synchronous question
 * about a server it reaches with different (administrative) credentials, so
 * there is still exactly one implementation.
 */
export function probePort(host: string, port: number, options: PortProbeOptions): PortProbe {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_PROBE_ATTEMPTS);
  const boundMs = options.timeoutMs + (options.startupAllowanceMs ?? DEFAULT_STARTUP_ALLOWANCE_MS);
  const spawn: ProbeSpawn = options.spawn ?? spawnSync;
  const details: string[] = [];

  for (let attempt = 1; ; attempt += 1) {
    const { outcome, detail } = probeOnce(spawn, host, port, options.timeoutMs, boundMs);

    details.push(detail);

    if (outcome === 'open' || outcome === 'refused' || attempt >= attempts) {
      return {
        outcome,
        detail:
          details.length === 1
            ? detail
            : details.map((line, index) => `attempt ${index + 1}: ${line}`).join('; '),
        attempts: attempt,
      };
    }
  }
}

function probeOnce(
  spawn: ProbeSpawn,
  host: string,
  port: number,
  timeoutMs: number,
  boundMs: number,
): Omit<PortProbe, 'attempts'> {
  const startedAt = Date.now();
  const probe = spawn(process.execPath, ['-e', PROBE_SCRIPT, host, String(port), String(timeoutMs)], {
    encoding: 'utf8',
    env: probeEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Bounds the process as a whole: start-up AND the connection attempt.
    timeout: boundMs,
    windowsHide: true,
  });
  const elapsedMs = Date.now() - startedAt;

  const report = probe.status === 0 ? PROBE_REPORT.exec(probe.stdout ?? '') : null;

  if (report == null) {
    return { outcome: 'inconclusive', detail: describeSilentProbe(probe, elapsedMs, boundMs) };
  }

  if (report[1] === 'open') {
    return { outcome: 'open', detail: `connected (${elapsedMs} ms)` };
  }

  if (report[1] === 'unanswered') {
    return { outcome: 'unanswered', detail: `no answer within ${timeoutMs} ms` };
  }

  const code = report[2];

  return ABSENCE_ERROR_CODES.has(code)
    ? { outcome: 'refused', detail: code }
    : { outcome: 'inconclusive', detail: `the connection attempt failed with ${code}` };
}

/** Why a probe process produced no report, in words. */
function describeSilentProbe(probe: SpawnSyncReturns<string>, elapsedMs: number, boundMs: number): string {
  const code = (probe.error as NodeJS.ErrnoException | undefined)?.code;

  if (code === 'ETIMEDOUT') {
    return (
      `the probe process was killed after ${elapsedMs} ms without reporting ` +
      `(limit ${boundMs} ms${probe.signal == null ? '' : `, ${probe.signal}`})`
    );
  }

  if (probe.error != null) {
    return `the probe process could not be run (${code ?? probe.error.message})`;
  }

  if (probe.signal != null) {
    return `the probe process was killed by ${probe.signal} after ${elapsedMs} ms`;
  }

  const stderr = (probe.stderr ?? '').trim().split('\n')[0]?.slice(0, 200);

  return (
    `the probe process exited ${String(probe.status)} without reporting` +
    (stderr != null && stderr.length > 0 ? ` (${stderr})` : '')
  );
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** Answer to "can this suite run?", computed without any I/O the caller must await. */
export interface DatabaseAvailability {
  available: boolean;
  /** Human-readable explanation, printed by the spec when it skips. */
  reason: string;
  /** `host:port/database`, never including the password. */
  target: string;
}

export interface AvailabilityDecision {
  verdict: 'run' | 'skip' | 'fail';
  reason: string;
  target: string;
}

/** The words a decision needs that only the caller knows. */
export interface AvailabilityWording {
  /** The reason to give when nothing is configured at all. */
  noneReason: string;
  /** The variable to suggest for pointing the suite at a database, e.g. `MEMORY_TEST_DATABASE_URL`. */
  urlEnvVar: string;
  /** The variable that raises the socket timeout, if the suite has one. */
  probeTimeoutEnvVar?: string;
}

/**
 * The table at the top of this file, as a function. Pure: the configuration
 * and the probe result go in, the verdict and the words for it come out.
 */
export function decideAvailability(
  configuration: TestDatabaseConfiguration,
  probe: PortProbe | null,
  wording: AvailabilityWording,
): AvailabilityDecision {
  if (configuration.kind === 'none') {
    return { verdict: 'skip', reason: wording.noneReason, target: '(unset)' };
  }

  if (configuration.kind === 'malformed') {
    return {
      verdict: 'fail',
      reason:
        `${configuration.variable} is set but is not a valid connection URL, so there is no telling ` +
        `where this suite's database is. Fix it, or unset it. (The value is not printed here: it may ` +
        `carry a password.)`,
      target: '(malformed)',
    };
  }

  const { connection, variable, explicit } = configuration;
  const target = `${connection.host}:${connection.port}/${connection.database}`;

  if (probe == null) {
    throw new Error(`decideAvailability: ${variable} describes ${target}, but no probe result was given.`);
  }

  const timeoutVariable = wording.probeTimeoutEnvVar;

  switch (probe.outcome) {
    case 'open':
      return { verdict: 'run', reason: `Postgres reachable at ${target}`, target };

    case 'refused':
      return explicit
        ? {
            verdict: 'fail',
            reason:
              `${variable} points at ${target}, but nothing is accepting connections there ` +
              `(${probe.detail}). A suite whose database was set explicitly fails instead of skipping, ` +
              `because a skip would read as a pass. Start that database — a dev-stack port changes on ` +
              `every \`up\`, so take the current URL from \`make dburl\` — or unset ${variable} if you ` +
              `did not mean to run this suite.`,
            target,
          }
        : {
            verdict: 'skip',
            reason:
              `nothing accepting connections at ${target} (${probe.detail}) — the dev-stack database ` +
              `${variable} describes is not running. Start the stack, or set ${wording.urlEnvVar} to a ` +
              `database that is.`,
            target,
          };

    case 'unanswered':
      return {
        verdict: 'fail',
        reason:
          `No answer from ${target} (${variable}; ${probe.detail}). Nothing refused the connection ` +
          `either, so this is not "no database here" but a host, proxy or network that is not ` +
          `responding. Check it` +
          (timeoutVariable == null ? '.' : `, or raise ${timeoutVariable} if it is merely slow.`),
        target,
      };

    case 'inconclusive':
      return {
        verdict: 'fail',
        reason:
          `Could not find out whether anything is listening at ${target} (${variable}): ` +
          `${probe.detail}. That is the probe failing, not the database — usually a machine too busy ` +
          `to start a node process in time. This suite fails rather than skipping so a busy machine ` +
          `cannot turn it into a silent pass: re-run it on its own or with fewer workers ` +
          `(--maxWorkers)` +
          (timeoutVariable == null ? '.' : `, or raise ${timeoutVariable}.`),
        target,
      };
  }
}

/**
 * A decision as the specs consume it: `run` and `skip` become an availability
 * answer, and `fail` THROWS. The specs call this at module scope, so the throw
 * surfaces as jest's "Test suite failed to run" with the reason as its message
 * — loud, specific, and counted as a failure.
 */
export function availabilityOrThrow(decision: AvailabilityDecision): DatabaseAvailability {
  if (decision.verdict === 'fail') {
    throw new Error(`Database-backed suite cannot run: ${decision.reason}`);
  }

  return { available: decision.verdict === 'run', reason: decision.reason, target: decision.target };
}

/** The socket timeout from `probeTimeoutEnvVar`, when that holds a positive number. */
export function probeTimeoutMs(
  probeTimeoutEnvVar: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = probeTimeoutEnvVar == null ? undefined : Number(env[probeTimeoutEnvVar]);

  return configured != null && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_PROBE_TIMEOUT_MS;
}

// Keyed by the caller's override names, so two suites in one jest module
// registry cannot read each other's answer. Jest gives each test FILE its own
// registry, so in practice this caches within a file — which is the point: the
// probe spawns a process and a suite may consult it more than once. A `fail`
// is cached too, and thrown again on every call.
const cachedDecisions = new Map<string, AvailabilityDecision>();

/**
 * Whether a Postgres is reachable for this test run: available, skip with a
 * reason, or THROW — see the table at the top of this file. Cached, see above.
 */
export function databaseAvailability(options: TestDatabaseOptions = {}): DatabaseAvailability {
  const label = overrideLabel(options);
  const cacheKey = `${label}|${options.probeTimeoutEnvVar ?? ''}`;
  let decision = cachedDecisions.get(cacheKey);

  if (decision == null) {
    const configuration = resolveConfiguration(options);
    const timeoutMs = probeTimeoutMs(options.probeTimeoutEnvVar);
    const probe =
      configuration.kind === 'configured'
        ? probePort(configuration.connection.host, configuration.connection.port, { timeoutMs })
        : null;

    decision = decideAvailability(configuration, probe, {
      noneReason:
        'no database configured — set ' +
        label +
        ', or DATABASE_PASSWORD (plus optional DATABASE_HOST / DATABASE_PORT / DATABASE_USERNAME / ' +
        'DATABASE_NAME). `yarn test` already points DOTENV_CONFIG_PATH at the repo-root .env.',
      urlEnvVar: label,
      probeTimeoutEnvVar: options.probeTimeoutEnvVar,
    });

    cachedDecisions.set(cacheKey, decision);
  }

  // failIfRequired is outside the cache on purpose: CI_REQUIRE_DB is a property
  // of the run, and a decision cached as a skip must still throw when a later
  // call is made under that switch.
  return failIfRequired(availabilityOrThrow(decision), `the database-backed suite that reads ${label}`);
}
