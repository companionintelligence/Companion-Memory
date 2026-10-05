import { EventEmitter2 } from '@nestjs/event-emitter';

import type { LoggerService } from '@ci/common/logging';
import type { Acknowledgement } from '@ci/domains/events';

import { PGBossEventService } from '../PGBossEventService';

const logger = {
  setContext() {},
  log() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as LoggerService;

type Outcome = 'completed' | 'deferred';

/** Drives the private executeJob directly — the work-loop wrapper only adds fetch/complete. */
function runJob(
  service: PGBossEventService,
  queue: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<Outcome> {
  const job = { id: 'job-1', data: { name, ...extra } };

  return (service as unknown as { executeJob: (q: string, j: unknown) => Promise<Outcome> }).executeJob(
    queue,
    job,
  );
}

describe('PGBossEventService deferred completion', () => {
  let emitter: EventEmitter2;
  let service: PGBossEventService;

  beforeEach(() => {
    emitter = new EventEmitter2();
    service = new PGBossEventService(emitter, logger, {} as never);
  });

  it('resolves completed when the listener acks done', async () => {
    emitter.on('my.event:my-queue', (_payload, ack: Acknowledgement) => ack.done());

    await expect(runJob(service, 'my-queue', 'my.event')).resolves.toBe('completed');
  });

  it('resolves deferred when the listener defers — the work loop then skips boss.complete', async () => {
    emitter.on('my.event:my-queue', (_payload, ack: Acknowledgement) => ack.defer());

    await expect(runJob(service, 'my-queue', 'my.event')).resolves.toBe('deferred');
  });

  it('rejects when the listener fails, so the work loop boss.fail()s the job', async () => {
    emitter.on('my.event:my-queue', (_payload, ack: Acknowledgement) => ack.fail(new Error('nope')));

    await expect(runJob(service, 'my-queue', 'my.event')).rejects.toThrow('nope');
  });

  it('resolves completed when no listener is registered (skip)', async () => {
    await expect(runJob(service, 'other-queue', 'my.event')).resolves.toBe('completed');
  });

  it('completeJob / failJob delegate to pg-boss by queue and job id', async () => {
    const boss = {
      complete: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
    };

    (service as unknown as { boss: typeof boss }).boss = boss;

    await service.completeJob('py-fn-summary', 'job-9', { ok: true });
    expect(boss.complete).toHaveBeenCalledWith('py-fn-summary', 'job-9', { ok: true });

    await service.failJob('py-fn-summary', 'job-9', { message: 'runner died' });
    expect(boss.fail).toHaveBeenCalledWith('py-fn-summary', 'job-9', {
      message: 'runner died',
      queue: 'py-fn-summary',
    });
  });

  it('failJob always names its own queue in the output, which is how a dead letter knows where it died', async () => {
    const boss = { fail: jest.fn().mockResolvedValue(undefined) };

    (service as unknown as { boss: typeof boss }).boss = boss;

    await service.failJob('py-fn-summary', 'job-9');
    expect(boss.fail).toHaveBeenLastCalledWith('py-fn-summary', 'job-9', { queue: 'py-fn-summary' });

    // The queue the job is actually on wins over anything the caller passed.
    await service.failJob('py-fn-summary', 'job-9', { message: 'runner died', queue: 'py-fn-hbpe' });
    expect(boss.fail).toHaveBeenLastCalledWith('py-fn-summary', 'job-9', {
      message: 'runner died',
      queue: 'py-fn-summary',
    });
  });

  /**
   * THE REGRESSION GUARD for the agent-dispatch incident.
   *
   * `executeJob` used to deliver `{ ...data, jobId: job.id }`, so the bus
   * overwrote any field a domain had named `jobId`. `domains/agent` declares one
   * on five payload types meaning the `ci.agent_jobs` row — so the dispatch
   * listener rang the Hub doorbell with pg-boss's id, the harness 404'd fetching
   * its packet, and the stale reaper closed the job reporting that OpenClaw had
   * never checked in.
   *
   * Nothing in this suite pinned the envelope contract, so every candidate fix
   * went green. These two are what fail loudly if anyone re-adds an injection.
   */
  describe('the delivered payload belongs to the domain', () => {
    it('delivers a payload field named jobId untouched; the queue id rides the ack', async () => {
      let seen: { payload: unknown; ack: Acknowledgement } | null = null;

      emitter.on('my.event:my-queue', (payload: unknown, ack: Acknowledgement) => {
        seen = { payload, ack };
        ack.done();
      });

      await runJob(service, 'my-queue', 'my.event', { jobId: 'agent-uuid-7', threadId: 't-1' });

      // The domain's value survives — this is the exact assertion that was false.
      expect(seen!.payload).toEqual({ jobId: 'agent-uuid-7', threadId: 't-1' });
      // And the queue's own id is still reachable, from the channel that owns it.
      expect(seen!.ack.jobId).toBe('job-1');
    });

    it('adds nothing to the payload at all, and strips only the routing key', async () => {
      let seen: unknown = null;

      emitter.on('my.event:my-queue', (payload: unknown, ack: Acknowledgement) => {
        seen = payload;
        ack.done();
      });

      await runJob(service, 'my-queue', 'my.event', { userId: 'u-1' });

      // `name` is dispatch metadata and is stripped. Everything else is the
      // domain's, and the bus contributes no keys of its own — so the next domain
      // to name a field `jobId` cannot lose it the way `domains/agent` did.
      expect(seen).toEqual({ userId: 'u-1' });
    });
  });
});
