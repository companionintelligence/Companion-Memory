/**
 * The stale-container reaper of `xtask test-db`, as a unit that can be tested.
 *
 * It runs at the start of every `make test-db` and removes what earlier runs left behind. Which of them it
 * may remove is decided by {@link planReap} (lib/testDb.ts): ours, older than two hours, not inside a
 * `--keep` window, and with nothing connected to it. That last check is what keeps it from removing a
 * database another session is running jest against, and the second one is what keeps it from removing a
 * kept database that is merely between two runs. This file asks the daemon the questions and says what it
 * did; it never decides.
 *
 * Nothing it can do fails the run: a listing that failed is reported and the run carries on, a container it
 * could not read is left alone and named, and a removal that did not go through says the command to run.
 */
import { info as logInfo, note as logNote, ok as logOk } from '../../dev-stack/log';
import { docker, listOurContainers, probeClients, removeContainers, type DockerFn } from './docker';
import {
  STALE_AFTER_MS,
  formatAge,
  keepUntilLabelValue,
  planReap,
  type ContainerInfo,
  type Spared,
} from './testDb';

/** Where the reaper's messages go. The command passes the console log helpers; a test passes a recorder. */
export interface Say {
  ok: (message: string) => void;
  note: (message: string) => void;
  info: (message: string) => void;
}

const consoleSay: Say = { ok: logOk, note: logNote, info: logInfo };

export interface ReapOptions {
  /** The docker CLI. Tests substitute a fake. */
  run?: DockerFn;
  now?: () => number;
  /** Blocking sleep between removal attempts. Tests substitute a no-op. */
  sleep?: (ms: number) => void;
  say?: Say;
}

export interface ReapReport {
  /** Confirmed gone. */
  removed: string[];
  /** Removal was attempted and NOT confirmed (a subset of these may still be running). */
  failed: string[];
  /** Old enough to be candidates and left alone, with why. */
  spared: Spared[];
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** One sentence for a candidate that was left alone: what it is, and what to do about it if the operator disagrees. */
function describeSpared(s: Spared, now: number): { level: 'info' | 'note'; text: string } {
  const { name, createdAt } = s.container;
  const age = formatAge(now - (createdAt ?? now));

  switch (s.why) {
    case 'kept':
      return {
        level: 'info',
        text: `Leaving ${name} alone (${age} old): it was kept with --keep and is protected until ${keepUntilLabelValue(s.until)}`,
      };

    case 'in-use':
      return {
        level: 'note',
        text:
          `NOT removing ${name} (${age} old): ${plural(s.clients, 'client connection')} open on it, so it is in use. ` +
          `Rename it to protect it from every later run: docker rename ${name} <new name>`,
      };

    case 'unverified':
      return {
        level: 'note',
        text:
          `NOT removing ${name} (${age} old): could not tell whether anything is connected to it (${s.detail}). ` +
          `If it is yours and you are finished with it: docker rm -f -v ${name}`,
      };
  }
}

/**
 * Remove the stale test databases that are safe to remove, and say what was left alone and why.
 *
 * Containers are asked about one at a time, only when the cheaper checks (ours, old enough, not inside a
 * keep window) have not already settled it, so a machine with nothing stale makes the same two docker calls
 * it always did.
 */
export function reapStaleContainers(opts: ReapOptions = {}): ReapReport {
  const run = opts.run ?? docker;
  const now = (opts.now ?? Date.now)();
  const say = opts.say ?? consoleSay;
  const report: ReapReport = { removed: [], failed: [], spared: [] };
  const listing = listOurContainers(run);

  // A lookup that failed is not "there are none": say so instead of a green tick that checked nothing.
  if (listing.problem !== undefined) {
    say.note(
      `Could not check for stale test databases (${listing.problem}) — carrying on; the next run will look again`,
    );
  }

  const plan = planReap(listing.containers, now, (c: ContainerInfo) => probeClients(c, run));

  report.spared = plan.spared;

  for (const spared of plan.spared) {
    const { level, text } = describeSpared(spared, now);

    say[level](text);
  }

  if (plan.remove.length === 0) {
    if (plan.spared.length === 0 && listing.problem === undefined) {
      say.ok('No stale test databases to reap');
    }

    return report;
  }

  const { removed, failed, unknown } = removeContainers(plan.remove, run, { sleep: opts.sleep });

  report.removed = removed;
  report.failed = failed;

  say.note(
    `Removed ${removed.length} stale test database container(s) older than ${formatAge(STALE_AFTER_MS)} with nothing connected: ${removed.join(', ')}`,
  );

  if (failed.length > 0) {
    say.note(
      `Could not remove: ${failed.join(', ')}${unknown.length > 0 ? ` (docker would not confirm ${unknown.join(', ')})` : ''} — run: docker rm -f -v <name>`,
    );
  }

  return report;
}
