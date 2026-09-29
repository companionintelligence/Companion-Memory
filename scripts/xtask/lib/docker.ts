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
  LABEL_KEY,
  LABEL_VALUE,
  isOurs,
  parseDockerPort,
  parseInspectContainers,
  type ContainerInfo,
} from './testDb';

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
  const res = docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20_000 });

  return res.status === 0
    ? { ok: true, detail: res.stdout.trim() }
    : { ok: false, detail: (res.stderr || res.stdout).trim().split('\n')[0] || 'no output' };
}

export function imagePresent(ref: string): boolean {
  return docker(['image', 'inspect', '--format', '{{.Id}}', ref], { timeoutMs: 30_000 }).status === 0;
}

/** Every container carrying our label — filtered again by {@link isOurs}, which also wants the name prefix. */
export function listOurContainers(): ContainerInfo[] {
  const ids = docker(['ps', '-a', '-q', '--no-trunc', '--filter', `label=${LABEL_KEY}=${LABEL_VALUE}`], {
    timeoutMs: 30_000,
  })
    .stdout.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return [];
  }

  const inspected = docker(
    ['inspect', '--format', '{{.Id}}|{{.Name}}|{{.Created}}|{{json .Config.Labels}}', ...ids],
    { timeoutMs: 30_000 },
  );

  return parseInspectContainers(inspected.stdout).filter(isOurs);
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
 * Force-remove containers, and their anonymous volumes (`-v`): the image
 * declares `VOLUME /var/lib/postgresql`, so without it every throwaway database
 * would leave its data directory behind.
 *
 * Refuses anything that is not verifiably ours, so a caller bug cannot turn this
 * into `docker rm -f <someone else's database>`.
 */
export function removeContainers(
  containers: ContainerInfo[],
  run: DockerFn = docker,
): { removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];

  for (const c of containers) {
    if (!isOurs(c)) {
      throw new Error(
        `refusing to remove '${c.name}': it is not a ci-testdb container carrying the ci.test-db label`,
      );
    }

    const res = run(['rm', '-f', '-v', c.id], { timeoutMs: 60_000 });
    const gone =
      res.status === 0 ||
      /No such container|already in progress/i.test(res.stderr) ||
      // `--rm` may have beaten us to it.
      run(['ps', '-a', '-q', '--no-trunc', '--filter', `id=${c.id}`]).stdout.trim() === '';

    (gone ? removed : failed).push(c.name);
  }

  return { removed, failed };
}

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
  /** The docker CLI. Tests substitute a fake. */
  run?: DockerFn;
  /** Blocking sleep between attempts to read the published port. Tests substitute a no-op. */
  sleep?: (ms: number) => void;
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
 * Never leaves a container behind when it throws. `docker run -d` returns as
 * soon as the container exists, and reading its published port afterwards can
 * still fail (a daemon that is slow or unwell, an unparseable answer): from that
 * point every failure removes the container it just created, by id, before
 * rethrowing. That is deliberately not done when `docker run` itself fails —
 * that is also what a name conflict looks like, and then the container holding
 * the name is somebody else's.
 */
export function startContainer(
  image: string,
  name: string,
  adminPassword: string,
  opts: StartOptions = {},
): StartedContainer {
  const run = opts.run ?? docker;
  const sleep = opts.sleep ?? sleepSync;
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
    { env: { ...process.env, PASSWORD: adminPassword }, timeoutMs: 10 * 60_000 },
  );

  if (res.status !== 0) {
    throw new Error(`docker run failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }

  // Ours from here on. Should `docker run -d` ever print no id, the name it
  // just succeeded in claiming still identifies the container exactly.
  const created: CreatedContainer = { id: res.stdout.trim().split('\n').pop()?.trim() || name, name };

  opts.onCreated?.(created);

  try {
    // Publishing can lag the container's creation by a moment.
    let portOut = run(['port', name, '5432/tcp']);

    for (let i = 0; i < 20 && portOut.status !== 0; i += 1) {
      sleep(250);
      portOut = run(['port', name, '5432/tcp']);
    }

    if (portOut.status !== 0) {
      throw new Error(`could not read the published port of ${name}: ${portOut.stderr.trim()}`);
    }

    return { ...created, port: parseDockerPort(portOut.stdout) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    let removal: string;

    try {
      const { failed } = removeContainers([justCreated(created)], run);

      if (failed.length === 0) {
        opts.onRemoved?.(created);
        removal = `${name} was removed`;
      } else {
        removal = `${name} could not be removed just now — if 'docker ps -a' still lists it, run: docker rm -f -v ${name}`;
      }
    } catch (removeErr) {
      removal = `${name} could not be removed just now (${removeErr instanceof Error ? removeErr.message : String(removeErr)}) — if 'docker ps -a' still lists it, run: docker rm -f -v ${name}`;
    }

    throw new Error(`${reason} (${removal})`, { cause: err });
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
    const running = docker(['inspect', '--format', '{{.State.Running}}', name]);

    if (running.status !== 0 || running.stdout.trim() !== 'true') {
      return { ready: false, waitedMs: Date.now() - started };
    }

    if (
      docker(
        ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres'],
        {
          timeoutMs: 15_000,
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

  return docker(args, { input: opts.sql, timeoutMs: 120_000 });
}

/** The container's whole log, both streams. */
export function containerLogs(name: string): string {
  const res = docker(['logs', name], { timeoutMs: 120_000 });

  // Postgres logs to stderr; the entrypoint's own chatter goes to stdout.
  return `${res.stdout}${res.stderr}`;
}
