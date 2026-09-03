import fs from 'node:fs';
import path from 'node:path';

import { CronRegistry } from '@ci/common/schedule';

import { DEAD_LETTER_QUEUE } from '../constants';
import { PROTECTED_CRONS, PROTECTED_QUEUES } from '../jobControlPolicy';
import { queueInventory } from '../queueInventory';

/**
 * The protected list is keyed by STRING, and nothing checked those strings.
 *
 * A key that names no real schedule is silent in both directions, and in the
 * worse one: `protectedCronReason` answers null, the row renders with a live
 * switch, and the job the list exists to keep running becomes switchable — while
 * the docs, the card and the list itself all go on saying it is protected.
 * Renaming a cron method, or changing its explicit `name:`, does exactly that.
 *
 * Checkable now only because `CronRegistry` records every declaration in every
 * process, including the ones this one does not serve: `StagedUploadPurgeCron`
 * is `role: 'worker'`, so a check against the live scheduler could never have
 * confirmed it under `CI_ROLE=web`.
 *
 * ── Why the modules are loaded by walking the tree ─────────────────────────
 *
 * Both registries are filled by decorators, which run when a module is
 * imported — so the fixture IS loading the files. Static imports would reach
 * across domain boundaries (`no-cross-domain-internals`), and a hand-kept list
 * of five would check five of fifty-three. The walk is the same one
 * `common/schedule/__tests__/cronRegistryNames.test.ts` uses, for the same
 * reason: it asserts against what the appliance actually declares rather than
 * against a list somebody remembered to update.
 */
const SRC_ROOT = path.resolve(__dirname, '../../..');

/** Files that declare a schedule or a queue listener — the two registries here. */
function declaringSourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') {
        declaringSourceFiles(full, found);
      }

      continue;
    }

    if (!entry.name.endsWith('.ts') || /\.(test|spec)\.ts$/.test(entry.name)) {
      continue;
    }

    const source = fs.readFileSync(full, 'utf8');

    if (source.includes('@Cron(') || source.includes('@OnEvent(')) {
      found.push(full);
    }
  }

  return found;
}

beforeAll(async () => {
  for (const file of declaringSourceFiles(SRC_ROOT)) {
    await import(file);
  }
});

describe('PROTECTED_CRONS', () => {
  it('found the appliance’s schedules at all', () => {
    // A floor, not a count. Without it a walk that quietly stopped discovering
    // anything would pass every assertion below by finding nothing to fail.
    expect(CronRegistry.all().length).toBeGreaterThanOrEqual(40);
  });

  it('names a schedule that exists in this build, for every entry', () => {
    const declared = new Set(CronRegistry.all().map((declaration) => declaration.name));
    const missing = Object.keys(PROTECTED_CRONS).filter((name) => !declared.has(name));

    expect(missing).toEqual([]);
  });

  it('gives every entry a reason, since the UI renders it as the tooltip', () => {
    const empty = Object.entries(PROTECTED_CRONS)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([name]) => name);

    expect(empty).toEqual([]);
  });
});

/**
 * The dead-letter entry is the odd one: it protects a queue that is not offered.
 *
 * `queueInventory()` is built from registered `@OnEvent` listeners, and nothing
 * registers one on `dead-letter` — deliberately. `DeadLetterReaperListener`
 * spells out why: any handler there makes it a discovered queue, which starts a
 * worker, which fetches every dead letter, finds no handler for the other forty
 * event names and completes them — destroying the dead letters of every event
 * but the one subscribed. So the reaper polls `pgboss.job` instead.
 *
 * Two comments used to claim the opposite — that the queue is listed "because it
 * has a real listener (the reaper) and a real worker", and that "its worker is
 * the reaper" — and the protection test next door passes only because its
 * harness registers a `dead-letter` listener the real build does not have.
 *
 * This pins the real behaviour, so the dangerous change trips a test rather than
 * a reviewer's memory of a comment.
 */
describe('PROTECTED_QUEUES', () => {
  it('found the appliance’s queues at all', () => {
    expect(queueInventory().length).toBeGreaterThanOrEqual(20);
  });

  it('nothing subscribes to the dead-letter queue, so it is never offered', () => {
    // If this fails, a listener has been registered on `dead-letter`. Read
    // `DeadLetterReaperListener`'s header before making it pass — the queue is
    // unsubscribed on purpose, and a worker on it silently loses dead letters.
    expect(queueInventory().map((entry) => entry.queue)).not.toContain(DEAD_LETTER_QUEUE);
  });

  it('keeps the dead-letter entry so the queue arrives protected if that changes', () => {
    // Unreachable today: the queue is never in the inventory, so `plan()`
    // rejects it as unknown before this list is consulted. Kept for the day it
    // is not.
    expect(Object.keys(PROTECTED_QUEUES)).toEqual([DEAD_LETTER_QUEUE]);
    expect(PROTECTED_QUEUES[DEAD_LETTER_QUEUE]).toMatch(/diagnosable/);
  });
});
