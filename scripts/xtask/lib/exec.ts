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
import { spawnSync } from 'node:child_process';

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
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}`);
  }
}

/** Capture output, never throw — for a `2>/dev/null` / `|| true` site, or a
 * probe whose failure is itself meaningful (e.g. "is X running"). */
export function tryRun(cmd: string, args: string[] = [], opts: RunOptions = {}): TryResult {
  const res = spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd, env: opts.env ?? process.env });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Absolute path to `cmd` on PATH, or null — mirrors `which cmd 2>/dev/null`. */
export function which(cmd: string): string | null {
  const res = tryRun('which', [cmd]);

  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}
