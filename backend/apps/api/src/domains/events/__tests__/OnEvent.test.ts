import { OnEvent } from '../decorators/OnEvent';
import type { Acknowledgement } from '../types';

function makeAck(): Acknowledgement {
  return { jobId: 'test-job', done: jest.fn(), fail: jest.fn(), defer: jest.fn() };
}

describe('OnEvent decorator', () => {
  describe('autoAcknowledge: true', () => {
    class AutoAckListener {
      @OnEvent('on-event.test.autoack' as never)
      async handle(_payload: unknown): Promise<void> {
        throw new Error('boom');
      }
    }

    it('fails the job when the handler throws and does not rethrow', async () => {
      const listener = new AutoAckListener();
      const ack = makeAck();

      await expect(
        (listener as unknown as { handle: (p: unknown, a: Acknowledgement) => Promise<void> }).handle(
          {},
          ack,
        ),
      ).resolves.toBeUndefined();

      expect(ack.fail).toHaveBeenCalledTimes(1);
      expect(ack.fail).toHaveBeenCalledWith(expect.any(Error));
    });

    it('rethrows when the handler throws and no ack was provided (a direct call with nothing else to signal failure)', async () => {
      const listener = new AutoAckListener();

      await expect(
        (listener as unknown as { handle: (p: unknown) => Promise<void> }).handle({}),
      ).rejects.toThrow('boom');
    });
  });

  describe('autoAcknowledge: false', () => {
    class DeferringListener {
      @OnEvent('on-event.test.deferring' as never, { autoAcknowledge: false })
      async handleWithoutAck(_payload: unknown, _ack: Acknowledgement): Promise<void> {
        // Never calls ack.defer()/ack.fail()/ack.done() before throwing.
        throw new Error('threw before acknowledging');
      }
    }

    it('fails the job as a fallback when the handler throws without acknowledging', async () => {
      const listener = new DeferringListener();
      const ack = makeAck();

      await listener.handleWithoutAck({}, ack);

      expect(ack.fail).toHaveBeenCalledTimes(1);
      expect(ack.fail).toHaveBeenCalledWith(expect.any(Error));
      expect(ack.done).not.toHaveBeenCalled();
      expect(ack.defer).not.toHaveBeenCalled();
    });

    /**
     * The sharpest hazard in the de-injection change.
     *
     * `trackedAck` REBUILDS the acknowledgement to intercept done/fail/defer.
     * Anything it forgets to copy is silently `undefined` for the handler — and
     * `jobId` is what the two deferring listeners hand to `completeJob`.
     *
     * Drop that one line and python-functions fails SILENTLY: the sidecar
     * guards its callback on `if record.job_id and record.queue`, so the work
     * runs, succeeds, reports nothing, and the job sits `active` until its
     * 8-hour expiry and then retries forever, with no exception and no log
     * naming the cause. Nothing else in the suite can see that.
     */
    class JobIdReadingListener {
      seen: string | undefined;

      seenEnqueuedAt: Date | undefined;

      @OnEvent('on-event.test.jobid' as never, { autoAcknowledge: false })
      async handle(_payload: unknown, ack: Acknowledgement): Promise<void> {
        this.seen = ack.jobId;
        this.seenEnqueuedAt = ack.enqueuedAt;
        ack.defer();
      }
    }

    it('forwards every ack field to the handler, not only the three callbacks', async () => {
      const listener = new JobIdReadingListener();
      const ack = makeAck();
      const enqueuedAt = new Date('2026-10-17T23:01:00Z');
      ack.jobId = 'pgboss-job-42';
      ack.enqueuedAt = enqueuedAt;

      await listener.handle({}, ack);

      expect(listener.seen).toBe('pgboss-job-42');
      // AnswerInferenceListener drops stale work by this. Lost here, every job
      // reads as fresh and a backlog replays in full.
      expect(listener.seenEnqueuedAt).toBe(enqueuedAt);
      expect(ack.defer).toHaveBeenCalledTimes(1);
    });

    class SelfAckingListener {
      @OnEvent('on-event.test.self-acking' as never, { autoAcknowledge: false })
      async handleThenThrow(_payload: unknown, ack: Acknowledgement): Promise<void> {
        ack.defer();
        throw new Error('threw after deferring');
      }
    }

    it('does not double-acknowledge when the handler already deferred before throwing', async () => {
      const listener = new SelfAckingListener();
      const ack = makeAck();

      await listener.handleThenThrow({}, ack);

      expect(ack.defer).toHaveBeenCalledTimes(1);
      expect(ack.fail).not.toHaveBeenCalled();
    });
  });
});
