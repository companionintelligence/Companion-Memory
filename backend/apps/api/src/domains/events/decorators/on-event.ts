import { applyDecorators } from '@nestjs/common';
import { OnEvent as BaseOnEvent } from '@nestjs/event-emitter';

import type { EventPayloads } from '../event-registry';
import type { EventPayload, Acknowledgement } from '../types';

interface ListenerOptions {
  async?: boolean;
  promisify?: boolean;
}

interface Opts extends ListenerOptions {
  autoAcknowledge?: boolean;
}

export function OnEvent<E extends keyof EventPayloads>(event: E, opts?: Opts) {
  const { autoAcknowledge = true, ...listenerOptions } = opts ?? {};

  const decorator = (target: unknown, key: string | symbol, descriptor: PropertyDescriptor) => {
    if (autoAcknowledge) {
      const originalMethod = descriptor.value;

      descriptor.value = async function (payload: EventPayload<E>, ack?: Acknowledgement) {
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

  const hasListenerOptions = Object.keys(listenerOptions).length > 0;

  return applyDecorators(
    decorator,
    BaseOnEvent(event, hasListenerOptions ? (listenerOptions as ListenerOptions) : undefined),
  );
}
