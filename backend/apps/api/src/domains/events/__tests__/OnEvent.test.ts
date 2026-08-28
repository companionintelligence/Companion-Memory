import { OnEvent } from '../decorators/OnEvent';
import type { Acknowledgement } from '../types';

function makeAck(): Acknowledgement {
  return { done: jest.fn(), fail: jest.fn(), defer: jest.fn() };
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
