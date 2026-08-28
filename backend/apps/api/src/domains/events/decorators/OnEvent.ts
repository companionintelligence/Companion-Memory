import { applyDecorators, Logger } from '@nestjs/common';
import { OnEvent as BaseOnEvent } from '@nestjs/event-emitter';

import { DEFAULT_QUEUE } from '../constants';
import { EventListenerRegistry } from '../event-registration';
import type { EventPayloads } from '../event-registry';
import type { EventRegistry } from '../registry';
import type { Acknowledgement, QueueOptions } from '../types';

const onEventLogger = new Logger('OnEvent');

interface Opts {
  autoAcknowledge?: boolean;
  queue?: string;

  /**
   * pg-boss queue-level options (expiration, retries) applied when the queue is
   * created/updated at module init. Set `autoAcknowledge: false` and call
   * `ack.defer()` for jobs whose completion is reported out-of-band (webhook).
   */
  queueOptions?: QueueOptions;
}

/**
 * @deprecated Use the new distributed EventPayloads type instead.
 */
export function OnEvent<E extends keyof EventPayloads>(
  event: E,
  opts?: Opts,
): ReturnType<typeof applyDecorators>;
export function OnEvent<E extends keyof EventRegistry>(
  event: E,
  opts?: Opts,
): ReturnType<typeof applyDecorators>;
export function OnEvent<E extends string>(event: E, opts?: Opts) {
  const { autoAcknowledge = true, queue = DEFAULT_QUEUE, queueOptions } = opts ?? {};

  const decorator = (target: unknown, key: string | symbol, descriptor: PropertyDescriptor) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    const className = (target as Function).constructor?.name ?? 'UnknownClass';
    const methodName = String(key);

    EventListenerRegistry.register(event as string, className, methodName, queue, queueOptions);

    const originalMethod = descriptor.value;

    if (autoAcknowledge) {
      descriptor.value = async function (payload: unknown, ack?: Acknowledgement) {
        try {
          await originalMethod.call(this, payload);

          ack?.done?.();
        } catch (err: unknown) {
          ack?.fail?.(err);

          // When pg-boss (or LocalEventService) drives this handler, `ack` is
          // always present and reporting failure through ack.fail() is the
          // real signal — the emit() call that invoked us never awaits our
          // return value, so rethrowing here would only produce an unhandled
          // rejection. Without an `ack` (a direct call, e.g. from a test or
          // another caller invoking the decorated method itself) there is no
          // other way to surface the failure, so it still has to reject.
          if (!ack) {
            throw err;
          }
        }
      };
    } else {
      // These handlers own ack.defer()/ack.fail() themselves (completion is
      // reported out-of-band). If one throws before calling either,
      // EventEmitter2's default suppressErrors:true eats the exception and
      // the job's ack Promise never settles — a permanently leaked worker
      // slot. Track whether the handler already acknowledged and fail the
      // job as a fallback if it didn't.
      descriptor.value = async function (payload: unknown, ack?: Acknowledgement) {
        let acknowledged = false;
        const trackedAck: Acknowledgement | undefined = ack && {
          done: () => {
            acknowledged = true;
            ack.done();
          },
          fail: (reason: unknown) => {
            acknowledged = true;
            ack.fail(reason);
          },
          defer: () => {
            acknowledged = true;
            ack.defer();
          },
        };

        try {
          await originalMethod.call(this, payload, trackedAck);
        } catch (err: unknown) {
          if (!acknowledged) {
            onEventLogger.error(
              `${className}.${methodName} threw without acknowledging the job — failing it as a fallback`,
              err instanceof Error ? err.stack : String(err),
            );

            ack?.fail?.(err);
          }
        }
      };
    }
  };

  const queueSpecificEventName = `${event}:${queue}`;

  return applyDecorators(decorator, BaseOnEvent(queueSpecificEventName));
}
