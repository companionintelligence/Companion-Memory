/**
 * One dev-stack supervisor per worktree.
 *
 * Two supervisors in one worktree share everything that makes a stack: the
 * compose project (named by the key), its containers and volumes, the Caddy
 * route id and the overmind socket path. Nothing stopped a second from
 * starting — `make dev-down` deregisters a LIVE stack's route as readily as a
 * stale one, which clears the only guard `up` had — and then (2026-09-29):
 *
 *   - the second `up` deleted the first's `.overmind.sock` as "stale", so the
 *     first stack could no longer be told to quit;
 *   - the first stack's vite still held :5173, so the second allocated around
 *     it and anything pinned to 5173 kept serving the OLD build;
 *   - when the first supervisor finally exited, its teardown ran
 *     `docker compose stop` on the shared project and took the second stack's
 *     containers down with it.
 *
 * So `up` takes a lock before touching anything, and `up` and `down` both
 * refuse while a supervisor for this worktree is alive.
 *
 * The lock is a pidfile, created with O_EXCL. A holder is live only while its
 * pid is running AND is a dev-stack process: a supervisor killed with -9 leaves
 * the file behind, and a pid the OS has since handed to something else must
 * not keep the worktree locked.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const LOCK_FILE = '.dev-stack.lock';

export interface LockHolder {
  pid: number;
  key: string;
  startedAt: string;
}

/** How to look at a process. Injectable so the tests need no real processes. */
export interface ProcessProbe {
  /** Whether a process with this pid exists (EPERM counts: it exists, it is just not ours). */
  alive(pid: number): boolean;
  /** Its command line, or null if it cannot be read. */
  command(pid: number): string | null;
}

export const systemProbe: ProcessProbe = {
  alive(pid) {
    try {
      process.kill(pid, 0);

      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  command(pid) {
    const res = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });

    return res.status === 0 ? res.stdout.trim() : null;
  },
};

export function parseHolder(text: string): LockHolder | null {
  try {
    const value = JSON.parse(text) as Partial<LockHolder>;

    return Number.isInteger(value.pid) && (value.pid as number) > 0
      ? { pid: value.pid as number, key: String(value.key ?? ''), startedAt: String(value.startedAt ?? '') }
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether the recorded holder is still a running supervisor. An unreadable
 * command line counts as live: refusing to start is recoverable (delete the
 * file), two supervisors are not.
 */
export function isHolderLive(holder: LockHolder, probe: ProcessProbe = systemProbe): boolean {
  if (!probe.alive(holder.pid)) {
    return false;
  }

  const command = probe.command(holder.pid);

  return command === null || command.includes('dev-stack');
}

/** The live supervisor holding this worktree's lock, if there is one. */
export function readLiveHolder(root: string, probe: ProcessProbe = systemProbe): LockHolder | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, LOCK_FILE), 'utf8');
  } catch {
    return null;
  }

  const holder = parseHolder(text);

  return holder && isHolderLive(holder, probe) ? holder : null;
}

export type LockResult = { acquired: true; release: () => void } | { acquired: false; holder: LockHolder };

/**
 * Take this worktree's supervisor lock, clearing a stale one. Returns the live
 * holder instead when another supervisor has it.
 */
export function acquireSupervisorLock(
  root: string,
  key: string,
  probe: ProcessProbe = systemProbe,
): LockResult {
  const file = path.join(root, LOCK_FILE);
  const me: LockHolder = { pid: process.pid, key, startedAt: new Date().toISOString() };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(me)}\n`, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }

      const holder = readLiveHolder(root, probe);
      if (holder) {
        return { acquired: false, holder };
      }

      fs.rmSync(file, { force: true }); // stale: its supervisor is gone
      continue;
    }

    let released = false;

    return {
      acquired: true,
      release: () => {
        if (released) {
          return;
        }

        released = true;
        // Only our own lock: never delete one a later supervisor has taken.
        let current: LockHolder | null = null;
        try {
          current = parseHolder(fs.readFileSync(file, 'utf8'));
        } catch {
          return; // already gone
        }

        if (current?.pid === me.pid) {
          fs.rmSync(file, { force: true });
        }
      },
    };
  }

  throw new Error(`could not take ${LOCK_FILE}: it keeps reappearing`);
}

/**
 * Whether an overmind is answering on this socket. Covers a supervisor that
 * predates the lock, or an overmind started by hand: the socket file alone
 * proves nothing (a crashed run leaves it), a connection does.
 */
export function socketIsLive(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  if (!fs.existsSync(socketPath)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const done = (live: boolean) => {
      socket.destroy();
      resolve(live);
    };

    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

/** What to tell someone about a live supervisor, and how to stop it. */
export function liveStackMessage(holder: LockHolder | null, socket: string): string {
  const who = holder
    ? `A dev stack is already running in this worktree (pid ${holder.pid}, up since ${holder.startedAt}).`
    : `A dev stack is already running in this worktree (overmind answers on ${socket}).`;
  const stop = holder
    ? `Stop it with Ctrl-C in its terminal, or \`kill -INT ${holder.pid}\``
    : `Stop it with Ctrl-C in its terminal, or \`OVERMIND_SOCKET=${socket} overmind quit\``;

  return (
    `${who} ${stop} — its teardown removes its route and stops its containers. ` +
    'Two supervisors share one compose project, so whichever exits first stops the other.'
  );
}
