/**
 * The few Docker calls `xtask test-db` makes, all through the `docker` CLI and
 * all in exec form (an argv array, never a shell string) — the same discipline
 * the database's own healthcheck needs, for the same reason: nothing here may
 * leave an orphaned `sh -c` behind in a container.
 *
 * Every function that could touch a container takes the container's NAME or ID
 * from a caller that got it from {@link listOurContainers} or from creating it
 * itself. Nothing here lists, inspects, execs into or removes a container by
 * pattern, and `removeContainers` refuses an id it was not told is ours.
 */
import { spawnSync } from 'node:child_process';

import {
  CONTAINER_PREFIX,
  LABEL_KEY,
  LABEL_VALUE,
  PS_FORMAT,
  escapeRegex,
  isOurs,
  parseDockerPort,
  parseInspectContainers,
  parsePsRows,
  type ContainerInfo,
} from './testDb';

/*
 * Every docker call on the start-up and clean-up path carries a timeout, chosen
 * per KIND of call. A daemon can accept a call and never answer it (it is the
 * same unwell daemon that makes `docker port` fail); `spawnSync` with no limit
 * then blocks for ever — and with it the removal that was supposed to clean up.
 * A timed-out call is reported as a failed one (status null), which every caller
 * already treats as "unknown", never as "fine".
 */

/**
 * `docker run -d`. The image is already local, so a healthy run takes about a second; the limit is generous
 * because it was MEASURED to be exceeded on a heavily loaded shared machine (load average ~440): the call ran
 * past 120 s, the CLI was killed, and the daemon had by then created the container — which the by-name sweep
 * after a failed run found and removed. A limit that tight fails a healthy-but-slow run for nothing.
 */
export const DOCKER_RUN_TIMEOUT_MS = 300_000;
/** `docker rm -f -v`: a running Postgres is SIGKILLed and its volume goes with it. Slow removals are retried, not waited on. */
export const DOCKER_RM_TIMEOUT_MS = 40_000;
/**
 * Read-only lookups (`ps`, `port`, `inspect`): the daemon answers these from memory, in tens of
 * milliseconds. The limit is generous anyway, because it was MEASURED on a busy shared machine
 * (load average ~400) that `docker ps -q` took 8.8 s: a limit that tight fails a healthy run.
 */
export const DOCKER_QUERY_TIMEOUT_MS = 20_000;
/** Listing every container of ours, or asking whether an image is present: a little more work than one lookup. */
export const DOCKER_LIST_TIMEOUT_MS = 30_000;
/** The readiness probe run inside the container (`pg_isready`). */
export const DOCKER_PROBE_TIMEOUT_MS = 15_000;
/** SQL run inside the container, and reading its whole log: bootstrap is a few statements, a heavy run's log is megabytes. */
export const DOCKER_SQL_TIMEOUT_MS = 120_000;
/** Attempts at removing one container, each followed (when it did not succeed) by a verification. */
export const REMOVE_ATTEMPTS = 3;
export const REMOVE_RETRY_DELAY_MS = 1_000;
/** `docker port` is polled while the port is being published; hung calls must not multiply, so the whole poll has a budget. */
export const PORT_LOOKUP_BUDGET_MS = 30_000;
const PORT_LOOKUP_RETRIES = 20;
const PORT_LOOKUP_DELAY_MS = 250;

export interface DockerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface DockerOptions {
  /** Fed to the process's stdin. */
  input?: string;
  /** Environment for the docker CLI process. Values reach a container only via a bare `-e NAME`. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** The shape of {@link docker}, so a caller can be handed a fake in a unit test. */
export type DockerFn = (args: string[], opts?: DockerOptions) => DockerResult;

/** `docker <args>`, captured, never throwing on a nonzero exit. */
export function docker(args: string[], opts: DockerOptions = {}): DockerResult {
  const res = spawnSync('docker', args, {
    encoding: 'utf8',
    input: opts.input,
    env: opts.env ?? process.env,
    timeout: opts.timeoutMs,
    // A CLI that has outlived its timeout is not going to honour a polite SIGTERM.
    killSignal: 'SIGKILL',
    // `docker logs` of a heavy run is tens of megabytes.
    maxBuffer: 512 * 1024 * 1024,
  });

  if (res.error) {
    const timedOut = (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';

    return {
      status: null,
      stdout: '',
      stderr: timedOut ? `docker ${args[0]} timed out after ${opts.timeoutMs} ms` : String(res.error.message),
    };
  }

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Is a Docker daemon answering? `detail` is the reason when it is not. */
export function dockerReachable(): { ok: boolean; detail: string } {
  const res = docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });

  return res.status === 0
    ? { ok: true, detail: res.stdout.trim() }
    : { ok: false, detail: (res.stderr || res.stdout).trim().split('\n')[0] || 'no output' };
}

const firstLineOf = (res: DockerResult): string =>
  (res.stderr || res.stdout).trim().split('\n')[0] || `exit ${res.status}`;

/** Attempts at asking whether an image is present, before "the daemon would not say" is reported as such. */
export const IMAGE_PROBE_ATTEMPTS = 3;
const IMAGE_PROBE_DELAY_MS = 1_000;

/**
 * What the daemon says about a local image.
 *
 * `unknown` is a first-class answer, exactly as it is for a container: a `docker
 * image inspect` that timed out or could not reach the daemon says nothing about
 * the image. Read as "absent" it silently swaps the local dev image for CI's pin
 * — or sends a `docker pull` after an image that only exists locally, which
 * fails with "pull access denied", a message about the wrong problem. This was
 * seen on a heavily loaded machine.
 */
export type ImageState = { state: 'present' } | { state: 'absent' } | { state: 'unknown'; detail: string };

/**
 * Only the daemon's own "No such image" is an answer of "absent"; success is
 * "present"; anything else (a timeout, a refused connection, an error nobody
 * anticipated) is asked again, a bounded number of times, and then reported as
 * `unknown`.
 */
export function imageState(
  ref: string,
  run: DockerFn = docker,
  opts: { attempts?: number; sleep?: (ms: number) => void } = {},
): ImageState {
  const attempts = Math.max(1, opts.attempts ?? IMAGE_PROBE_ATTEMPTS);
  const sleep = opts.sleep ?? sleepSync;
  let detail = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      sleep(IMAGE_PROBE_DELAY_MS);
    }

    const res = run(['image', 'inspect', '--format', '{{.Id}}', ref], { timeoutMs: DOCKER_LIST_TIMEOUT_MS });

    if (res.status === 0) {
      return { state: 'present' };
    }

    if (res.status !== null && /no such image/i.test(`${res.stderr}${res.stdout}`)) {
      return { state: 'absent' };
    }

    detail = firstLineOf(res);
  }

  return { state: 'unknown', detail };
}

/** Every container of ours the daemon listed — or the reason it would not say, which is NOT the same as "there are none". */
export interface OurContainers {
  containers: ContainerInfo[];
  /** Set when a lookup failed: `containers` may then be incomplete, and a caller must not report "none". */
  problem?: string;
}

/** Every container carrying our label — filtered again by {@link isOurs}, which also wants the name prefix. */
export function listOurContainers(run: DockerFn = docker): OurContainers {
  const listed = run(['ps', '-a', '-q', '--no-trunc', '--filter', `label=${LABEL_KEY}=${LABEL_VALUE}`], {
    timeoutMs: DOCKER_LIST_TIMEOUT_MS,
  });

  if (listed.status !== 0) {
    return { containers: [], problem: `docker ps failed: ${firstLineOf(listed)}` };
  }

  const ids = listed.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return { containers: [] };
  }

  const inspected = run(
    ['inspect', '--format', '{{.Id}}|{{.Name}}|{{.Created}}|{{json .Config.Labels}}', ...ids],
    { timeoutMs: DOCKER_LIST_TIMEOUT_MS },
  );
  const containers = parseInspectContainers(inspected.stdout).filter(isOurs);

  // `docker inspect a b` prints what it found and exits 1 when one has gone since the listing (a concurrent
  // run finishing, `--rm`): that is normal. Any OTHER failure means the containers could not be read.
  if (inspected.status !== 0 && !/no such (object|container)/i.test(inspected.stderr)) {
    return { containers, problem: `docker inspect failed: ${firstLineOf(inspected)}` };
  }

  return { containers };
}

/** What we know about a container the moment `docker run` has returned its id. */
export interface CreatedContainer {
  id: string;
  name: string;
}

/**
 * A container this command has just created, described the way
 * {@link removeContainers} wants it. Only for one whose creation we witnessed:
 * `docker run` succeeded under a name and label of ours, so it IS ours.
 */
export function justCreated(c: CreatedContainer): ContainerInfo {
  return { id: c.id, name: c.name, createdAt: Date.now(), labels: { [LABEL_KEY]: LABEL_VALUE } };
}

/**
 * What the daemon says about a container named `name` that carries our label.
 *
 * `unknown` is a first-class answer, not a synonym for `absent`: a failed or
 * unreadable `docker ps` tells us nothing about the container, and treating it
 * as "it is gone" is how a running database ends up with nothing tracking it.
 *
 * The lookup is by exact, anchored NAME plus the label — not by id. Ids are not
 * always known (an empty `docker run` answer falls back to the name), and
 * `--filter id=<name>` matches nothing even for a running container. The rows
 * that come back are checked again here, for name and label, rather than
 * trusting that the filters did their job.
 */
export type Presence =
  | { state: 'absent' }
  | { state: 'present'; id: string; label: string }
  | { state: 'unknown'; detail: string };

export function ourContainerNamed(name: string, run: DockerFn = docker): Presence {
  const res = run(
    [
      'ps',
      '-a',
      '--no-trunc',
      '--filter',
      `name=^${escapeRegex(name)}$`,
      '--filter',
      `label=${LABEL_KEY}=${LABEL_VALUE}`,
      '--format',
      PS_FORMAT,
    ],
    { timeoutMs: DOCKER_QUERY_TIMEOUT_MS },
  );

  if (res.status !== 0) {
    return {
      state: 'unknown',
      detail: (res.stderr || res.stdout).trim().split('\n')[0] || `exit ${res.status}`,
    };
  }

  const rows = parsePsRows(res.stdout);

  if (rows.length === 0 && res.stdout.trim() !== '') {
    return { state: 'unknown', detail: 'docker ps printed something this could not read' };
  }

  const row = rows.find((r) => r.names.includes(name) && r.label === LABEL_VALUE);

  return row ? { state: 'present', id: row.id, label: row.label } : { state: 'absent' };
}

export interface RemoveOptions {
  /** Attempts per container. Default {@link REMOVE_ATTEMPTS}. */
  attempts?: number;
  /** Blocking sleep between attempts. Tests substitute a no-op. */
  sleep?: (ms: number) => void;
}

export interface RemovalResult {
  /** Confirmed gone: `docker rm` said so, or a verification that SUCCEEDED found nothing. */
  removed: string[];
  /**
   * NOT confirmed gone — the container is still there, or we could not tell. This
   * is the complete list of names to worry about, so a caller that looks only at
   * `failed` is safe by default.
   */
  failed: string[];
  /** The subset of `failed` whose state is unknown: the verification itself failed, so it may well be running. */
  unknown: string[];
}

type Fate = 'gone' | 'present' | 'unknown';

/**
 * One container, up to `attempts` rounds of: `rm -f -v`, and — only when that did
 * not itself succeed — a verification. `rm` succeeding, or saying the container
 * does not exist, is the daemon's own word that it is gone. Anything else (an
 * error, a timeout, "removal already in progress") proves nothing either way, so
 * the daemon is asked; and if THAT fails the answer is "unknown", never "gone".
 */
function removeOne(c: ContainerInfo, run: DockerFn, attempts: number, sleep: (ms: number) => void): Fate {
  let last: Fate = 'unknown';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      sleep(REMOVE_RETRY_DELAY_MS);
    }

    const res = run(['rm', '-f', '-v', c.id], { timeoutMs: DOCKER_RM_TIMEOUT_MS });

    if (res.status === 0 || /No such container/i.test(res.stderr)) {
      return 'gone';
    }

    // `--rm` may have beaten us to it, or removal may be in progress: ask.
    const seen = ourContainerNamed(c.name, run);

    if (seen.state === 'absent') {
      return 'gone';
    }

    last = seen.state;
  }

  return last;
}

/**
 * Force-remove containers, and their anonymous volumes (`-v`): the image
 * declares `VOLUME /var/lib/postgresql`, so without it every throwaway database
 * would leave its data directory behind.
 *
 * Refuses anything that is not verifiably ours — all of them, before the first
 * docker call — so a caller bug cannot turn this into `docker rm -f <someone
 * else's database>`.
 *
 * "Removed" means the daemon said so. A removal that failed and whose
 * verification also failed is reported as `unknown` (and in `failed`): the
 * container may be running, and the caller must keep tracking it.
 */
export function removeContainers(
  containers: ContainerInfo[],
  run: DockerFn = docker,
  opts: RemoveOptions = {},
): RemovalResult {
  const attempts = Math.max(1, opts.attempts ?? REMOVE_ATTEMPTS);
  const sleep = opts.sleep ?? sleepSync;
  const result: RemovalResult = { removed: [], failed: [], unknown: [] };

  for (const c of containers) {
    if (!isOurs(c)) {
      throw new Error(
        `refusing to remove '${c.name}': it is not a ci-testdb container carrying the ci.test-db label`,
      );
    }
  }

  for (const c of containers) {
    const fate = removeOne(c, run, attempts, sleep);

    if (fate === 'gone') {
      result.removed.push(c.name);
    } else {
      result.failed.push(c.name);

      if (fate === 'unknown') {
        result.unknown.push(c.name);
      }
    }
  }

  return result;
}

/** How a by-name sweep ended. */
export type SweepResult =
  | { state: 'none' } // asked, and nothing of ours has that name
  | { state: 'removed'; id: string }
  | { state: 'failed'; id: string } // ours, and still there after every attempt
  | { state: 'unknown'; detail: string }; // could not find out, or could not confirm the removal

/**
 * Remove the container named `name` IF — and only if — the daemon confirms that
 * a container with that exact name AND our label exists. For the case where the
 * id was never learned: `docker run -d` died (killed at its time limit, Ctrl-C)
 * after the daemon had created the container. The name is one this command
 * chose at random, so a container answering to it and carrying the label is
 * ours; one answering to it WITHOUT the label is somebody else's, never shown by
 * the filter, and left untouched.
 */
export function removeOursByName(
  name: string,
  run: DockerFn = docker,
  opts: RemoveOptions = {},
): SweepResult {
  if (!name.startsWith(CONTAINER_PREFIX)) {
    throw new Error(`refusing to sweep '${name}': not a ${CONTAINER_PREFIX}* name`);
  }

  const seen = ourContainerNamed(name, run);

  if (seen.state === 'absent') {
    return { state: 'none' };
  }

  if (seen.state === 'unknown') {
    return { state: 'unknown', detail: seen.detail };
  }

  const removal = removeContainers(
    [{ id: seen.id, name, createdAt: null, labels: { [LABEL_KEY]: seen.label } }],
    run,
    opts,
  );

  if (removal.removed.length > 0) {
    return { state: 'removed', id: seen.id };
  }

  return removal.unknown.length > 0
    ? { state: 'unknown', detail: 'the removal was not confirmed' }
    : { state: 'failed', id: seen.id };
}

/** The sentence every failure path ends with when it could not clean up: what to run by hand. */
export const manualRemoval = (name: string): string =>
  `if 'docker ps -a' still lists it, run: docker rm -f -v ${name}`;

export interface StartedContainer extends CreatedContainer {
  /** Host port on 127.0.0.1 that reaches the container's 5432. */
  port: number;
}

export interface StartOptions {
  /**
   * Called the instant `docker run` has returned the new container's id, BEFORE
   * anything else that can throw — so a caller with an exit-time backstop can
   * register the container there while it is not yet a usable handle.
   */
  onCreated?: (c: CreatedContainer) => void;
  /** Called once a container reported through `onCreated` is confirmed gone, so the backstop can let go of it. */
  onRemoved?: (c: CreatedContainer) => void;
  /**
   * Called when `docker run` failed and this could not establish that no
   * container of ours is left under `name` (the daemon would not answer). The
   * id was never learned, so the backstop must find it again BY NAME at exit,
   * with {@link removeOursByName} — never with a bare `docker rm -f <name>`,
   * which would also remove a stranger's container of that name.
   */
  onUncertain?: (name: string) => void;
  /** The docker CLI. Tests substitute a fake. */
  run?: DockerFn;
  /** Blocking sleep between attempts to read the published port, and between removal attempts. Tests substitute a no-op. */
  sleep?: (ms: number) => void;
  /** The clock the port-lookup budget is measured on. Tests substitute a fake. */
  now?: () => number;
}

/** One sentence on what became of the container after a removal, for the end of an error message. */
function describeRemoval(name: string, result: RemovalResult): string {
  if (result.failed.length === 0) {
    return `${name} was removed`;
  }

  return result.unknown.length > 0
    ? `${name} could NOT be removed and docker would not confirm whether it is gone (the daemon did not answer) — it may STILL BE RUNNING; run: docker rm -f -v ${name}`
    : `${name} could not be removed just now — ${manualRemoval(name)}`;
}

/**
 * Start the database. The admin password travels as `-e PASSWORD` with NO value:
 * Docker then takes it from this process's environment, so it is on neither
 * this command line nor the container's, in `ps` or in `docker inspect`'s Args.
 *
 * `--init` is the point of the exercise (tini as PID 1 reaps orphans, so a
 * process the postmaster did not fork can never be counted as a crashed backend);
 * `--shm-size=1g` matches docker-compose.yml, whose comment explains the
 * parallel-query failure the 64 MB default causes; `-p 127.0.0.1::5432` publishes
 * on loopback only, on a port Docker picks.
 *
 * Never leaves a container behind when it throws, and never claims a removal it
 * did not confirm.
 *
 *  - `docker run -d` returns as soon as the container exists, and reading its
 *    published port afterwards can still fail (a daemon that is slow or unwell,
 *    an unparseable answer): from that point every failure removes the container
 *    it just created, by id, before rethrowing.
 *  - `docker run` itself can fail AFTER the daemon created the container (the CLI
 *    killed at its time limit, Ctrl-C in that window), and then no id was ever
 *    returned. The name is ours — chosen at random by the caller — so a by-NAME
 *    sweep runs, and it removes only a container that answers to that exact name
 *    AND carries our label. A name conflict with someone else's container looks
 *    exactly like a failed `docker run`; theirs has no label, is never matched,
 *    and stays untouched.
 *  - A removal that could not be confirmed is reported as such, with the exact
 *    command to run, and `onRemoved` is NOT called: the caller's backstop keeps
 *    the container registered.
 */
export function startContainer(
  image: string,
  name: string,
  adminPassword: string,
  opts: StartOptions = {},
): StartedContainer {
  const run = opts.run ?? docker;
  const sleep = opts.sleep ?? sleepSync;
  const now = opts.now ?? Date.now;
  const res = run(
    [
      'run',
      '-d',
      '--rm',
      '--init',
      '--name',
      name,
      '--label',
      `${LABEL_KEY}=${LABEL_VALUE}`,
      '--shm-size=1g',
      '-e',
      'PASSWORD',
      '-p',
      '127.0.0.1::5432',
      image,
    ],
    { env: { ...process.env, PASSWORD: adminPassword }, timeoutMs: DOCKER_RUN_TIMEOUT_MS },
  );

  if (res.status !== 0) {
    throw new Error(
      `docker run failed: ${res.stderr.trim() || res.stdout.trim()} (${sweepAfterFailedRun(name, run, sleep, opts)})`,
    );
  }

  // Ours from here on. Should `docker run -d` ever print no id, the name it
  // just succeeded in claiming still identifies the container exactly.
  const created: CreatedContainer = { id: res.stdout.trim().split('\n').pop()?.trim() || name, name };

  opts.onCreated?.(created);

  try {
    // Publishing can lag the container's creation by a moment.
    const startedLooking = now();
    let portOut = run(['port', name, '5432/tcp'], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });

    for (
      let i = 0;
      i < PORT_LOOKUP_RETRIES && portOut.status !== 0 && now() - startedLooking < PORT_LOOKUP_BUDGET_MS;
      i += 1
    ) {
      sleep(PORT_LOOKUP_DELAY_MS);
      portOut = run(['port', name, '5432/tcp'], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    }

    if (portOut.status !== 0) {
      throw new Error(`could not read the published port of ${name}: ${portOut.stderr.trim()}`);
    }

    return { ...created, port: parseDockerPort(portOut.stdout) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    let removal: string;

    try {
      const result = removeContainers([justCreated(created)], run, { sleep });

      if (result.failed.length === 0) {
        opts.onRemoved?.(created);
      }

      removal = describeRemoval(name, result);
    } catch (removeErr) {
      removal = `${name} could not be removed just now (${removeErr instanceof Error ? removeErr.message : String(removeErr)}) — ${manualRemoval(name)}`;
    }

    throw new Error(`${reason} (${removal})`, { cause: err });
  }
}

/** After a failed `docker run`: the by-name sweep, and one sentence about what it found. */
function sweepAfterFailedRun(
  name: string,
  run: DockerFn,
  sleep: (ms: number) => void,
  opts: StartOptions,
): string {
  let swept: SweepResult;

  try {
    swept = removeOursByName(name, run, { sleep });
  } catch (err) {
    swept = { state: 'unknown', detail: err instanceof Error ? err.message : String(err) };
  }

  switch (swept.state) {
    case 'none':
      return `no ${LABEL_KEY} container named ${name} was left behind`;
    case 'removed':
      return `docker had created ${name} before failing; it was removed`;
    case 'failed':
      opts.onUncertain?.(name);

      return `docker created ${name} before failing and it could not be removed just now — ${manualRemoval(name)}`;
    case 'unknown':
      opts.onUncertain?.(name);

      return `could not check whether ${name} was left behind (${swept.detail}) — it may exist; ${manualRemoval(name)}`;
  }
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Wait until the FINAL server accepts connections. `pg_isready -h 127.0.0.1` is
 * deliberate: the image's entrypoint runs `initdb`, then starts a temporary
 * server on a Unix socket only to run init scripts, then restarts. A probe over
 * the socket answers "ready" during that first phase, and a client that believed
 * it connects to a server that is about to go away.
 */
export function waitUntilReady(name: string, timeoutMs: number): { ready: boolean; waitedMs: number } {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const running = docker(['inspect', '--format', '{{.State.Running}}', name], {
      timeoutMs: DOCKER_QUERY_TIMEOUT_MS,
    });

    if (running.status !== 0 || running.stdout.trim() !== 'true') {
      return { ready: false, waitedMs: Date.now() - started };
    }

    if (
      docker(
        ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres'],
        {
          timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
        },
      ).status === 0
    ) {
      return { ready: true, waitedMs: Date.now() - started };
    }

    sleepSync(500);
  }

  return { ready: false, waitedMs: Date.now() - started };
}

/** Run SQL as the superuser inside the container over its local socket (no password, nothing on argv). */
export function psql(
  name: string,
  database: string,
  opts: { sql?: string; command?: string; tuplesOnly?: boolean },
): DockerResult {
  const args = [
    'exec',
    ...(opts.sql === undefined ? [] : ['-i']),
    name,
    'psql',
    '-X',
    '-U',
    'postgres',
    '-d',
    database,
    '-v',
    'ON_ERROR_STOP=1',
  ];

  if (opts.tuplesOnly) {
    args.push('-At');
  }

  if (opts.command !== undefined) {
    args.push('-c', opts.command);
  }

  return docker(args, { input: opts.sql, timeoutMs: DOCKER_SQL_TIMEOUT_MS });
}

/** The container's whole log, both streams. */
export function containerLogs(name: string): string {
  const res = docker(['logs', name], { timeoutMs: DOCKER_SQL_TIMEOUT_MS });

  // Postgres logs to stderr; the entrypoint's own chatter goes to stdout.
  return `${res.stdout}${res.stderr}`;
}
