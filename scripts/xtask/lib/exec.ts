/**
 * exec — process helpers mirroring a Makefile recipe's two default shapes: a
 * bare `@cmd` line (inherit stdio, abort the recipe on a nonzero exit) and a
 * line ending `2>/dev/null` / `|| true` (never abort — the caller decides
 * what a failure means). Using the wrong one silently changes behavior:
 * `run` on a deliberately-tolerated command turns a soft failure into a hard
 * abort, and `tryRun` on a load-bearing command lets a real failure go
 * unnoticed.
 *
 * Both throw plain `Error`s rather than calling `process.exit()` — only the
 * CLI entry point (index.ts) should ever end the process, so a command that
 * calls another in-process (e.g. `dev` calling `build`/`health`) can still
 * run its own cleanup instead of the whole process dying mid-composition.
 */
import { spawn, spawnSync } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface TryResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Inherit stdio, throw if the command exits nonzero or fails to start. The
 * `@cmd` default every plain recipe line uses. */
export function run(cmd: string, args: string[] = [], opts: RunOptions = {}): void {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd, env: opts.env ?? process.env });

  if (res.error) {
    throw res.error;
  }

  if (res.status !== 0) {
    // `res.signal`, not just the status: a child killed by a signal reports
    // status null, so an OOM-killed docker build read as "exited null" and
    // lost the SIGKILL that Make surfaced as "Error 137".
    throw new Error(
      `${cmd} ${args.join(' ')} ${res.signal ? `was killed by ${res.signal}` : `exited ${res.status}`}`,
    );
  }
}

/** Capture output, never throw — for a `2>/dev/null` / `|| true` site, or a
 * probe whose failure is itself meaningful (e.g. "is X running"). */
export function tryRun(cmd: string, args: string[] = [], opts: RunOptions = {}): TryResult {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    // The shell threw these payloads away with `>/dev/null`, so their size
    // could never affect the exit status being tested. Capturing them means
    // node's 1 MiB default would kill the child and make a healthy probe
    // (a large `docker image inspect`, a chatty caddy config) read as failure.
    maxBuffer: 64 * 1024 * 1024,
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Absolute path to `cmd` on PATH, or null — mirrors `which cmd 2>/dev/null`. */
export function which(cmd: string): string | null {
  const res = tryRun('which', [cmd]);

  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

export interface RunAsyncResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  /** True when this process was asked to stop (SIGINT/SIGTERM) while the child ran. */
  interrupted: boolean;
  /** Combined stdout+stderr, only when `capture` was requested; otherwise empty. */
  output: string;
}

/**
 * Inherit stdio and wait for the child WITHOUT blocking the event loop, so a
 * SIGINT/SIGTERM aimed at THIS process is handled while a long child runs —
 * `spawnSync` cannot do that, and index.ts keeps the process alive through those
 * signals on the assumption that Ctrl-C reaches the child too. That assumption
 * fails for a plain `kill <pid>` (only this process is signalled), which would
 * leave a command such as `test-db` unable to clean up until the child ended on
 * its own, minutes later. Here the signal is forwarded to the child, and a child
 * that ignores it is killed after `killAfterMs`. Resolves with what happened;
 * never throws on a nonzero exit, because the caller usually has more to do with
 * the answer (read a report, tear something down) than to abort on it.
 */
export function runAsync(
  cmd: string,
  args: string[] = [],
  opts: RunOptions & { killAfterMs?: number; capture?: boolean } = {},
): Promise<RunAsyncResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: opts.capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      cwd: opts.cwd,
      env: opts.env ?? process.env,
    });
    const chunks: Buffer[] = [];
    let interrupted = false;

    if (opts.capture) {
      child.stdout?.on('data', (c: Buffer) => chunks.push(c));
      child.stderr?.on('data', (c: Buffer) => chunks.push(c));
    }

    let killTimer: NodeJS.Timeout | undefined;

    const forward = (signal: NodeJS.Signals): void => {
      interrupted = true;
      child.kill(signal);
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), opts.killAfterMs ?? 10_000);
    };

    const onInt = (): void => forward('SIGINT');
    const onTerm = (): void => forward('SIGTERM');

    const detach = (): void => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);

      if (killTimer) {
        clearTimeout(killTimer);
      }
    };

    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);

    child.once('error', (err) => {
      detach();
      reject(err);
    });
    child.once('close', (status, signal) => {
      detach();
      resolve({ status, signal, interrupted, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

/**
 * `runAsync`, throwing on a nonzero exit the way `run` does. With `capture` the
 * child's output is held back and only surfaces (its last 40 lines) in the error,
 * for a step whose success output is noise — `dbmate up` prints two lines per
 * migration, several hundred of them.
 */
export async function runAsyncOrThrow(
  cmd: string,
  args: string[] = [],
  opts: RunOptions & { capture?: boolean } = {},
): Promise<RunAsyncResult> {
  const res = await runAsync(cmd, args, opts);

  if (res.interrupted) {
    throw new Error(`${cmd} ${args.join(' ')} was interrupted`);
  }

  if (res.status !== 0) {
    const tail = res.output.trim().split('\n').slice(-40).join('\n');

    throw new Error(
      `${cmd} ${args.join(' ')} ${res.signal ? `was killed by ${res.signal}` : `exited ${res.status}`}` +
        (tail ? `. Last output:\n${tail}` : ''),
    );
  }

  return res;
}
