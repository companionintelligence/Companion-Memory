import { EventEmitter2 } from '@nestjs/event-emitter';

import type { LoggerService } from '@ci/common/logging';
import { PGBossEventService } from '@ci/domains/events';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * "DOES THE ENQUEUE SIDE ACTUALLY DEFEND THIS QUEUE?", FOR ANY DOMAIN'S SPEC.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A queue declared with a de-duplicating pg-boss policy (`short`, `singleton`,
 * `stately`) is guarded by a unique index on `(name, COALESCE(singleton_key,
 * ''))`. A send with NO singletonKey therefore collides with every other
 * keyless job on that queue, and pg-boss discards the loser via `ON CONFLICT DO
 * NOTHING` — no error, just a null job id. `PGBossEventService.send` logs that
 * mistake loudly; this drives the real service so a domain's spec can assert
 * the defence covers ITS queue.
 *
 * Deliberately shared rather than copied: the previous generation of
 * queue-policy specs each defined a private in-test model of pg-boss's unique
 * index and asserted against that, so every one of them passed while two real
 * senders shipped with no key at all. A probe that runs the production code is
 * the only kind worth having, and one copy of it cannot drift from another.
 *
 * The caller's own imports decide what the registry holds: import the real
 * listener/service whose `@OnEvent` declares the queue, then probe it.
 */
export interface QueuePolicyGuardProbe {
  /** Errors the service logged for a send to the queue carrying NO singletonKey. */
  keyless: string[];

  /** Errors it logged for the same send WITH a singletonKey. */
  keyed: string[];
}

interface StubLogger {
  setContext: jest.Mock;
  debug: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  log: jest.Mock;
}

async function collectSendErrors(queue: string, singletonKey?: string): Promise<string[]> {
  const priorSuppress = process.env.CI_QUEUE_SUPPRESS;

  // A suppressed queue drops the send before the guard ever runs, and the
  // probe's answer would then depend on the shell it was run from.
  delete process.env.CI_QUEUE_SUPPRESS;

  const logger: StubLogger = {
    setContext: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
  };

  try {
    const service = new PGBossEventService(
      new EventEmitter2(),
      logger as unknown as LoggerService,
      {} as never,
    );

    // pg-boss's send() resolves with the new job's id, or null when the insert
    // conflicted; a successful enqueue is what we want the guard measured
    // against, so the stub returns an id.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).boss = { send: jest.fn(async () => 'job-1') };

    await (
      service.send.bind(service) as (
        name: string,
        event: Record<string, unknown>,
        options?: { queue?: string; singletonKey?: string },
      ) => Promise<string[]>
    )('queue-policy-probe.event', { probe: true }, { queue, ...(singletonKey ? { singletonKey } : {}) });
  } finally {
    if (priorSuppress == null) {
      delete process.env.CI_QUEUE_SUPPRESS;
    } else {
      process.env.CI_QUEUE_SUPPRESS = priorSuppress;
    }
  }

  return logger.error.mock.calls.map((call: unknown[]) => String(call[0]));
}

/**
 * Send one event to `queue` twice through the real `PGBossEventService` — once
 * with no singletonKey, once with one — and report what each send logged as an
 * error.
 */
export async function probeQueuePolicyGuard(queue: string): Promise<QueuePolicyGuardProbe> {
  return {
    keyless: await collectSendErrors(queue),
    keyed: await collectSendErrors(queue, 'queue-policy-probe-key'),
  };
}
