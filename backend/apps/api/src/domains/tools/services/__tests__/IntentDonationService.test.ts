/* eslint-disable @typescript-eslint/no-explicit-any */
import type { EventEmitter2 } from '@nestjs/event-emitter';

import { IntentDonationService, INTENT_INVOKED_EVENT } from '../IntentDonationService';

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn() } as any;
}

describe('IntentDonationService', () => {
  it('emits an intent.invoked event with a stamped timestamp', () => {
    const emit = jest.fn();
    const service = new IntentDonationService({ emit } as unknown as EventEmitter2, makeLogger());

    service.donate({
      intent: 'memory.recall',
      domain: 'memory',
      userId: 'user-1',
      success: true,
      access: 'read',
      external: false,
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const [eventName, payload] = emit.mock.calls[0];
    expect(eventName).toBe(INTENT_INVOKED_EVENT);
    expect(payload.intent).toBe('memory.recall');
    expect(typeof payload.at).toBe('string');
  });

  it('never throws even if the emitter fails', () => {
    const emit = jest.fn(() => {
      throw new Error('bus down');
    });
    const service = new IntentDonationService({ emit } as unknown as EventEmitter2, makeLogger());

    expect(() =>
      service.donate({
        intent: 'memory.recall',
        domain: 'memory',
        success: true,
        access: 'read',
        external: false,
      }),
    ).not.toThrow();
  });
});
