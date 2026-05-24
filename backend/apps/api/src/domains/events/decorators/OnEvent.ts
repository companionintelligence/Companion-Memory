import { applyDecorators } from '@nestjs/common';
import { OnEvent as BaseOnEvent } from '@nestjs/event-emitter';

import { DEFAULT_QUEUE } from '../constants';
import { EventListenerRegistry } from '../event-registration';
import type { EventPayloads } from '../event-registry';
import type { EventRegistry } from '../registry';
import type { Acknowledgement } from '../types';

interface Opts {
  autoAcknowledge?: boolean;
  queue?: string;
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
  const { autoAcknowledge = true, queue = DEFAULT_QUEUE } = opts ?? {};

  const decorator = (target: unknown, key: string | symbol, descriptor: PropertyDescriptor) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    const className = (target as Function).constructor?.name ?? 'UnknownClass';
    const methodName = String(key);

    EventListenerRegistry.register(event as string, className, methodName, queue);

    if (autoAcknowledge) {
      const originalMethod = descriptor.value;

      descriptor.value = async function (payload: unknown, ack?: Acknowledgement) {
        try {
          await originalMethod.call(this, payload);

          ack?.done?.();
        } catch (err: unknown) {
          ack?.fail?.(err);

          throw err;
        }
      };
    }
  };

  const queueSpecificEventName = `${event}:${queue}`;

  return applyDecorators(decorator, BaseOnEvent(queueSpecificEventName));
}
