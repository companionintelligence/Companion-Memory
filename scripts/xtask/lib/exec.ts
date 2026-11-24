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

/**
 * The signals that mean "stop": Ctrl-C, `kill <pid>`, and the terminal going
 * away (closing the window, an SSH connection dropping — SIGHUP). Every place
 * that keeps this process alive through one, or forwards one to a child, uses
 * this list, so the three cannot drift apart: a command that handled two of them
 * would leak whatever it had started the first time somebody closed a terminal.
 */
export const TERMINATION_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Once a terminal has gone away (the window closed, an SSH connection dropped)
 * every write to it fails with EIO. Node reports that as an `error` event on
 * process.stdout / process.stderr, and with no listener it is an uncaught
 * exception: the process dies at its next `console.log` — which for `test-db`
 * was `printSummary`, and could as easily have been a status line in the middle
 * of the very cleanup the hangup was supposed to trigger. There is nobody left to
 * read the output, so it is dropped; any OTHER stream error is not this function's
 * business and is rethrown exactly as it would have been. Returns the undo.
 */
export function ignoreDeadTerminal(
  streams: readonly NodeJS.EventEmitter[] = [process.stdout, process.stderr],
): () => void {
  const listener = (err: NodeJS.ErrnoException): void => {
    if (err.code !== 'EIO') {
      throw err;
    }
  };

  for (const stream of streams) {
    stream.on('error', listener);
  }

  return () => {
    for (const stream of streams) {
      stream.off('error', listener);
    }
  };
}

/**
 * True when this process was started by the tsx CLI wrapper (`yarn tsx <script>`) and not by `node --import tsx
 * <script>`. The wrapper starts the script as a child with `--require .../tsx/dist/preflight.cjs`, then relays
 * SIGINT and SIGTERM to it and SIGKILLs it if it has not acknowledged within ~60 ms — which a command blocked
 * in a child process cannot do. So a command that must clean up after an interrupt (`test-db`) is not safe to
 * start that way, and this is how it notices. Best-effort by nature: it reads tsx's own start-up flag.
 */
export function underTsxRelay(execArgv: readonly string[] = process.execArgv): boolean {
  return execArgv.some((arg) => /tsx[\\/]dist[\\/]preflight\.cjs$/.test(arg));
}

/** The one-line warning for a command that is not safe under {@link underTsxRelay}; the same text everywhere. */
export const TSX_RELAY_WARNING =
  'Started through the tsx CLI wrapper (`yarn tsx ...`): it kills this process on Ctrl-C or `kill` before it can ' +
  'clean up. Use `make <target>` or `yarn node --import tsx scripts/xtask/index.ts <command>`.';

export interface RunAsyncResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  /** True when this process was asked to stop (any of {@link TERMINATION_SIGNALS}) while the child ran. */
  interrupted: boolean;
  /** True when the child outlived `timeoutMs` and was stopped for it. Not an interruption: nobody asked. */
  timedOut: boolean;
  /** Combined stdout+stderr, only when `capture` was requested; otherwise empty. */
  output: string;
}

/**
 * SIGKILL a process group until it is empty (`kill(-pgid)` answers ESRCH), or
 * `attempts` rounds have passed. One SIGKILL is not enough: the kernel does not
 * deliver a group signal atomically, and jest-worker restarts a worker that dies
 * with a non-zero status — so if a worker is killed a moment before jest itself,
 * jest forks a REPLACEMENT into the same group and is then killed, leaving the
 * replacement reparented to init. The next round finds and kills it. Returns how
 * many rounds it took, or `attempts` if the group never emptied.
 */
export async function reapGroup(
  pgid: number,
  opts: {
    attempts?: number;
    delayMs?: number;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): Promise<number> {
  const attempts = opts.attempts ?? 20;
  const kill = opts.kill ?? ((pid, signal) => process.kill(pid, signal));

  for (let round = 1; round <= attempts; round += 1) {
    try {
      kill(-pgid, 'SIGKILL');
    } catch {
      return round; // ESRCH: nobody left in the group
    }

    await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 50));
  }

  return attempts;
}

/**
 * Inherit stdio and wait for the child WITHOUT blocking the event loop, so a
 * SIGINT/SIGTERM/SIGHUP aimed at THIS process is handled while a long child runs —
 * `spawnSync` cannot do that, and index.ts keeps the process alive through those
 * signals on the assumption that Ctrl-C reaches the child too. That assumption
 * fails for a plain `kill <pid>` (only this process is signalled) and, in part,
 * for a terminal that goes away (the tty's SIGHUP reaches the foreground process
 * group, but not a child that started its own session), which would
 * leave a command such as `test-db` unable to clean up until the child ended on
 * its own, minutes later. Here the signal is forwarded to the child, and a child
 * that ignores it is killed after `killAfterMs`. Resolves with what happened;
 * never throws on a nonzero exit, because the caller usually has more to do with
 * the answer (read a report, tear something down) than to abort on it.
 *
 * `group: true` is for a child that is a WRAPPER around the real work — `yarn
 * workspace … jest` is one. yarn does not pass SIGHUP on (it dies of it and
 * leaves jest and its workers running, reparented to init) and ignores SIGINT
 * outright, expecting a terminal to have delivered Ctrl-C to the whole process
 * group; SIGTERM fares little better. So a signal aimed at this process alone —
 * `kill <pid>`, the very case this function exists for — reached yarn and went
 * no further. With `group`, the child leads its own process group and every
 * signal (and the final SIGKILL) goes to the whole group, wrapper and work alike.
 * The cost: the child is no longer in the terminal's foreground group, so
 * Ctrl-C reaches it only through this forwarding — which is the point. And once
 * an interrupted group's leader has exited, {@link reapGroup} kills whatever is
 * left in it.
 *
 * `timeoutMs` bounds a child that never finishes (a `docker pull` against a
 * daemon that accepted the call and went quiet): it is stopped exactly as a
 * SIGTERM would stop it — the signal, then SIGKILL after `killAfterMs` — and
 * reported as `timedOut`, not as `interrupted`. It is a ceiling, not an
 * expectation: pick one no healthy run reaches.
 */
export function runAsync(
  cmd: string,
  args: string[] = [],
  opts: RunOptions & { killAfterMs?: number; capture?: boolean; group?: boolean; timeoutMs?: number } = {},
): Promise<RunAsyncResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: opts.capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: opts.group === true,
    });

    /** Signal the child — or, with `group`, everything in its process group. */
    const signalChild = (signal: NodeJS.Signals): void => {
      if (opts.group && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);

          return;
        } catch {
          // The group is already gone (ESRCH); fall through to the plain kill, which will find the same.
        }
      }

      child.kill(signal);
    };

    const chunks: Buffer[] = [];
    let interrupted = false;
    let timedOut = false;

    if (opts.capture) {
      child.stdout?.on('data', (c: Buffer) => chunks.push(c));
      child.stderr?.on('data', (c: Buffer) => chunks.push(c));
    }

    let killTimer: NodeJS.Timeout | undefined;

    const stop = (signal: NodeJS.Signals): void => {
      signalChild(signal);
      killTimer ??= setTimeout(() => signalChild('SIGKILL'), opts.killAfterMs ?? 10_000);
    };

    const forward = (signal: NodeJS.Signals): void => {
      interrupted = true;
      stop(signal);
    };

    const limitTimer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            stop('SIGTERM');
          }, opts.timeoutMs);

    const listeners = TERMINATION_SIGNALS.map((signal) => [signal, (): void => forward(signal)] as const);

    const detach = (): void => {
      for (const [signal, listener] of listeners) {
        process.off(signal, listener);
      }

      if (killTimer) {
        clearTimeout(killTimer);
      }

      if (limitTimer) {
        clearTimeout(limitTimer);
      }
    };

    for (const [signal, listener] of listeners) {
      process.on(signal, listener);
    }

    child.once('error', (err) => {
      detach();
      reject(err);
    });
    child.once('close', (status, signal) => {
      const finish = (): void => {
        detach();
        resolve({ status, signal, interrupted, timedOut, output: Buffer.concat(chunks).toString('utf8') });
      };

      // The leader is gone; anything still in its group is a straggler. When we were interrupted, or ran out of
      // time, the whole group is wanted dead, so reap it — see reapGroup for why one SIGKILL is not enough.
      if (opts.group && (interrupted || timedOut) && child.pid !== undefined) {
        void reapGroup(child.pid).then(finish);
      } else {
        finish();
      }
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
  opts: RunOptions & { capture?: boolean; group?: boolean; timeoutMs?: number } = {},
): Promise<RunAsyncResult> {
  const res = await runAsync(cmd, args, opts);

  if (res.interrupted) {
    throw new Error(`${cmd} ${args.join(' ')} was interrupted`);
  }

  if (res.timedOut) {
    throw new Error(`${cmd} ${args.join(' ')} did not finish within ${opts.timeoutMs} ms and was stopped`);
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
