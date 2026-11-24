/**
 * The exit-time backstop of `xtask test-db`, as a unit that can be tested.
 *
 * Every normal path removes the container in `withThrowaway`'s finally, and
 * `startContainer` removes what it created if it fails part-way. This catches
 * what neither can: a removal that itself failed, an id that was never learned,
 * or `process.exit()` from somewhere nobody wrote. It runs from the command's
 * own `finally` and again from the process's `exit` event, so it is synchronous
 * and idempotent.
 *
 * It tracks three things, because they are owed different treatment:
 *
 *  - `unclaimed`: a container `docker run` created that `startContainer` has not
 *    yet handed back as a usable database. Removed on exit even under `--keep`,
 *    since "keep" is a promise about a WORKING database and this is not one.
 *  - `live`: the working database. Removed on exit unless `--keep`.
 *  - an uncertain NAME: `docker run` failed and the daemon would not say whether
 *    it left a container behind. Found again by name at exit and removed only if
 *    it carries our label — see {@link removeOursByName}.
 *
 * A container is let go of only when its removal was CONFIRMED. One the daemon
 * would not answer about stays registered, and the sweep says so — on stderr,
 * with the exact `docker rm -f -v <name>` — rather than pretending.
 *
 * It also removes the run's own work directory (the jest report and the
 * deliberately nonexistent `.env` path live there), and only that one: a
 * hard-killed run leaves its directory behind, and the next run has no business
 * deleting a directory it did not make.
 */
import fs from 'node:fs';

import {
  docker,
  justCreated,
  manualRemoval,
  removeContainers,
  removeOursByName,
  type CreatedContainer,
  type DockerFn,
} from './docker';

/** Fewer attempts than a normal removal: this runs while the process is trying to exit. */
export const BACKSTOP_REMOVE_ATTEMPTS = 2;

export interface BackstopOptions {
  /** `--keep`: the live container is left running. */
  keep: boolean;
  /** This run's own temporary directory. */
  workDir: string;
  run?: DockerFn;
  sleep?: (ms: number) => void;
  removeDir?: (dir: string) => void;
  /** Where sweep messages go. Default: stderr, written synchronously (an `exit` handler cannot await). */
  warn?: (message: string) => void;
}

export interface SweepReport {
  /** Containers the sweep itself confirmed gone. */
  removed: string[];
  /** Containers it could not confirm gone; still registered. */
  held: string[];
}

export class ExitBackstop {
  private unclaimed: CreatedContainer | null = null;

  private live: CreatedContainer | null = null;

  private uncertain: string | null = null;

  constructor(private readonly opts: BackstopOptions) {}

  /** `docker run` returned an id; not yet a usable database. */
  created(c: CreatedContainer): void {
    this.unclaimed = c;
  }

  /** The container reported through {@link created} is confirmed gone. */
  released(c: CreatedContainer): void {
    if (this.unclaimed?.name === c.name) {
      this.unclaimed = null;
    }

    if (this.live?.name === c.name) {
      this.live = null;
    }
  }

  /** The database is up and handed to the run. */
  claimed(c: CreatedContainer): void {
    this.unclaimed = null;
    this.live = c;
  }

  /** `docker run` failed and nothing says whether a container was left under `name`. */
  uncertainName(name: string): void {
    this.uncertain = name;
  }

  /** Names still registered — that is, not confirmed removed and not deliberately kept. */
  held(): string[] {
    return [
      this.unclaimed?.name,
      this.opts.keep ? undefined : this.live?.name,
      this.uncertain ?? undefined,
    ].filter((n): n is string => n !== undefined);
  }

  sweep(): SweepReport {
    const run = this.opts.run ?? docker;
    const warn = this.opts.warn ?? writeStderr;
    const report: SweepReport = { removed: [], held: [] };
    const options = { attempts: BACKSTOP_REMOVE_ATTEMPTS, sleep: this.opts.sleep };

    for (const slot of ['unclaimed', 'live'] as const) {
      const c = this[slot];

      if (c === null || (slot === 'live' && this.opts.keep)) {
        continue;
      }

      try {
        const result = removeContainers([justCreated(c)], run, options);

        if (result.failed.length === 0) {
          this[slot] = null;
          report.removed.push(c.name);
        } else {
          report.held.push(c.name);
          warn(
            result.unknown.length > 0
              ? `test-db: could not confirm that ${c.name} was removed (docker did not answer) — it may STILL BE RUNNING; run: docker rm -f -v ${c.name}`
              : `test-db: ${c.name} could not be removed — ${manualRemoval(c.name)}`,
          );
        }
      } catch (err) {
        report.held.push(c.name);
        warn(`test-db: removing ${c.name} failed (${errorText(err)}) — ${manualRemoval(c.name)}`);
      }
    }

    if (this.uncertain !== null) {
      const name = this.uncertain;

      try {
        const swept = removeOursByName(name, run, options);

        if (swept.state === 'none' || swept.state === 'removed') {
          this.uncertain = null;

          if (swept.state === 'removed') {
            report.removed.push(name);
          }
        } else {
          report.held.push(name);
          warn(`test-db: could not confirm that ${name} is gone — it may exist; ${manualRemoval(name)}`);
        }
      } catch (err) {
        report.held.push(name);
        warn(`test-db: sweeping for ${name} failed (${errorText(err)}) — ${manualRemoval(name)}`);
      }
    }

    this.removeWorkDir();

    return report;
  }

  private removeWorkDir(): void {
    try {
      (this.opts.removeDir ?? ((dir) => fs.rmSync(dir, { recursive: true, force: true })))(this.opts.workDir);
    } catch {
      // A temp directory that will not go is not worth failing the exit for.
    }
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function writeStderr(message: string): void {
  try {
    fs.writeSync(2, `${message}\n`);
  } catch {
    // stderr gone (a closed terminal): nothing left to tell.
  }
}
