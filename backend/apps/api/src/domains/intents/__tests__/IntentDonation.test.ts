/* eslint-disable @typescript-eslint/no-explicit-any */
import type { EventEmitter2 } from '@nestjs/event-emitter';

import type { RequestContext } from '@ci/common/context';
import type { ToolRegistry } from '@ci/domains/tools';

import { IntentDonationService, INTENT_INVOKED_EVENT } from '../services/IntentDonationService';
import { IntentRegistry } from '../services/IntentRegistry';
import { IntentTool } from '../services/IntentTool';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

function intent(name: string) {
  const def = new IntentRegistry().getIntent(name);
  if (!def) {
    throw new Error(`fixture intent missing: ${name}`);
  }

  return def;
}

const context: RequestContext = { userId: 'user-1' };

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

describe('IntentTool donation', () => {
  function toolWithDonation(intentName: string, toolResult: unknown) {
    const executeTool = jest.fn().mockResolvedValue(toolResult);
    const registry = { executeTool } as unknown as ToolRegistry;
    const donate = jest.fn();
    const donation = { donate } as unknown as IntentDonationService;
    const tool = new IntentTool(intent(intentName), registry, makeLogger(), donation);

    return { tool, donate };
  }

  it('donates a successful invocation', async () => {
    const { tool, donate } = toolWithDonation('people.find', { success: true, data: { hits: [] } });

    await tool.execute(context, { query: 'Sarah' });

    expect(donate).toHaveBeenCalledTimes(1);
    expect(donate.mock.calls[0][0]).toMatchObject({
      intent: 'people.find',
      domain: 'people',
      userId: 'user-1',
      success: true,
      access: 'read',
    });
  });

  it('donates a failed invocation (success=false) and still surfaces the error', async () => {
    const { tool, donate } = toolWithDonation('knowledge.search', {
      success: false,
      error: { code: 'X', message: 'boom', retryable: false },
    });

    const result = await tool.execute(context, { query: 'x' });

    expect(result.success).toBe(false);
    expect(donate).toHaveBeenCalledTimes(1);
    expect(donate.mock.calls[0][0]).toMatchObject({ intent: 'knowledge.search', success: false });
  });
});
