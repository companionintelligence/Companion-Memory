import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { QueueOptions } from '@ci/domains/events';

import {
  IMPORT_QUEUE,
  IMPORT_QUEUE_OPTIONS,
  IMPORT_STAGE_EXPIRE_SECONDS,
  IMPORT_STAGE_KINDS,
  IMPORT_STAGE_QUEUE_BY_KIND,
  IMPORT_STAGE_QUEUE_OPTIONS,
} from '../constants';

/**
 * Every import queue must state its own execution deadline.
 *
 * `PGBossEventService.jobDeadlineMs` takes a queue's declared `expireInSeconds`
 * as the IN-PROCESS deadline and falls back to `queues.jobTimeoutSeconds` where
 * a queue declares nothing — so for this lane "declare nothing" stopped meaning
 * "inherit the constructor's twelve hours" and started meaning "two". The
 * import lane routinely runs longer than two hours: a 350 GB Takeout's unpack
 * alone is documented at an hour, before parse, media and push.
 *
 * Asserting the declared numbers against each other would be vacuous —
 * reverting the fix reverts both sides — so every bound on the right-hand side
 * here is parsed out of the file that actually sets it. Reverting a decorator
 * to an inline literal, dropping `expireInSeconds`, or lowering the pg-boss
 * constructor default without revisiting this lane all fail here.
 */
const API_SRC = resolve(__dirname, '../../..');

const read = (relative: string): string => readFileSync(resolve(API_SRC, relative), 'utf8');

const EVENT_SERVICE_SRC = read('domains/events/services/PGBossEventService.ts');
const CONFIGURATION_SRC = read('configuration.ts');
const LISTENER_SRC = read('domains/import/listeners/ImportStageListener.ts');

/**
 * The pg-boss constructor's appliance-wide expiry — the bound every queue that
 * declares nothing has always run under, via pg-boss's
 * COALESCE(job, queue row, constructor default).
 */
function constructorExpirySeconds(): number {
  const match = /expireInHours:\s*(\d+)/.exec(EVENT_SERVICE_SRC);

  if (!match) {
    throw new Error('expireInHours not found in PGBossEventService.ts');
  }

  return Number(match[1]) * 60 * 60;
}

/** The in-process fallback deadline a queue gets when it declares nothing. */
function fallbackDeadlineSeconds(): number {
  const match = /jobTimeoutSeconds:\s*z[^\n]*?\.default\((\d+)\)/.exec(CONFIGURATION_SRC);

  if (!match) {
    throw new Error('queues.jobTimeoutSeconds default not found in configuration.ts');
  }

  return Number(match[1]);
}

/**
 * `POLICY.MAX_EXPIRATION_HOURS` from pg-boss's `attorney.js`, which asserts
 * `expireIn / 60 / 60 < MAX_EXPIRATION_HOURS` on the value that reaches a
 * queue. Mirrored rather than parsed: it lives in a dependency's source, not
 * ours, and a bump would arrive with a version upgrade.
 */
const PGBOSS_MAX_EXPIRATION_SECONDS = 24 * 60 * 60;

/**
 * Which options each `@OnEvent` on the stage listener actually ships, read out
 * of the decorators rather than assumed.
 *
 * The inner match deliberately refuses nested braces: since the options were
 * hoisted into `constants.ts`, a decorator's option object is one flat level,
 * so re-inlining a literal (the shape that dropped the deadline in the first
 * place) stops matching and the coverage check below fails.
 */
function registeredQueues(): Map<string, QueueOptions> {
  const optionsByExpression = new Map<string, QueueOptions>([
    ['IMPORT_QUEUE_OPTIONS', IMPORT_QUEUE_OPTIONS],
    ...IMPORT_STAGE_KINDS.map(
      (kind) => [`IMPORT_STAGE_QUEUE_OPTIONS.${kind}`, IMPORT_STAGE_QUEUE_OPTIONS[kind]] as const,
    ),
  ]);

  const queuesByExpression = new Map<string, string>([
    ['IMPORT_QUEUE', IMPORT_QUEUE],
    ...IMPORT_STAGE_KINDS.map(
      (kind) => [`IMPORT_STAGE_QUEUE_BY_KIND.${kind}`, IMPORT_STAGE_QUEUE_BY_KIND[kind]] as const,
    ),
  ]);

  const registrations = new Map<string, QueueOptions>();

  for (const [, body] of LISTENER_SRC.matchAll(/@OnEvent\(ImportStageEvent,\s*\{([^{}]*)\}\s*\)/g)) {
    const queueExpression = /queue:\s*([A-Za-z_][A-Za-z0-9_.]*)/.exec(body)?.[1];
    const optionsExpression = /queueOptions:\s*([A-Za-z_][A-Za-z0-9_.]*)/.exec(body)?.[1];

    if (queueExpression == null || optionsExpression == null) {
      throw new Error(`An import stage registration names no queue or no queueOptions: ${body}`);
    }

    const queue = queuesByExpression.get(queueExpression);
    const options = optionsByExpression.get(optionsExpression);

    if (queue == null || options == null) {
      throw new Error(
        `Unrecognised import stage registration (${queueExpression}, ${optionsExpression}); ` +
          'teach this test about it rather than deleting the case.',
      );
    }

    registrations.set(queue, options);
  }

  return registrations;
}

describe('import queue execution deadlines', () => {
  const registered = registeredQueues();

  it('covers every queue the importer enqueues onto', () => {
    // The routing table in `ImportRunService.enqueueStage`: one queue per stage
    // kind, plus the shared drain for a stage whose kind can no longer be read.
    const routable = [...IMPORT_STAGE_KINDS.map((kind) => IMPORT_STAGE_QUEUE_BY_KIND[kind]), IMPORT_QUEUE];

    expect([...registered.keys()].sort()).toEqual([...routable].sort());
  });

  it.each([...registered.entries()])(
    '%s declares an explicit deadline no tighter than the bound it already had',
    (_queue, options) => {
      // Explicit, so `jobDeadlineMs` never reaches its fallback for this queue.
      expect(typeof options.expireInSeconds).toBe('number');

      // The whole point: the effective bound must not have tightened. Twelve
      // hours is what pg-boss's constructor default already gave these queues.
      expect(options.expireInSeconds).toBeGreaterThanOrEqual(constructorExpirySeconds());

      // And it must be doing work — a declaration at or below the fallback is
      // decorative, since the fallback is what an undeclared queue gets anyway.
      expect(options.expireInSeconds).toBeGreaterThan(fallbackDeadlineSeconds());

      // pg-boss refuses an expiry of a day or more at queue creation, which
      // would fail the whole boot rather than just this queue.
      expect(options.expireInSeconds).toBeLessThan(PGBOSS_MAX_EXPIRATION_SECONDS);
    },
  );

  it('holds the deadline above the fallback the other queues live on', () => {
    // Stated once here so the relationship survives someone raising
    // `queues.jobTimeoutSeconds` towards this lane's number and assuming the
    // declarations are then redundant. They are not: raising the appliance-wide
    // fallback to twelve hours would hand every OTHER queue a twelve-hour
    // wedge window, which is the failure the fallback exists to bound.
    expect(IMPORT_STAGE_EXPIRE_SECONDS).toBeGreaterThan(fallbackDeadlineSeconds());
    expect(IMPORT_STAGE_EXPIRE_SECONDS).toBeGreaterThanOrEqual(constructorExpirySeconds());
  });
});
