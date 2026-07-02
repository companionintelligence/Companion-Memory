/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RequestContext } from '@ci/common/context';

import type { IntentPrivacy, ToolSchema } from '../../core/types';
import { DEFAULT_INTENT_POLICY, IntentDispatcherService, type IntentPolicy } from '../IntentDispatcherService';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

function schema(privacy: IntentPrivacy, name = 'memory.act'): Pick<ToolSchema, 'name' | 'domain' | 'privacy'> {
  return { name, domain: 'memory', privacy };
}

const context: RequestContext = { userId: 'user-1' };

function make(policy: IntentPolicy = DEFAULT_INTENT_POLICY) {
  const send = jest.fn().mockResolvedValue([]);
  const dispatcher = new IntentDispatcherService(makeLogger(), { send } as any, policy);

  return { dispatcher, send };
}

const READ: IntentPrivacy = { access: 'read', sensitivity: 'personal', destructive: false, external: false };
const DESTRUCTIVE: IntentPrivacy = { access: 'delete', sensitivity: 'personal', destructive: true, external: false };
const EXTERNAL: IntentPrivacy = { access: 'read', sensitivity: 'low', destructive: false, external: true };
const SENSITIVE: IntentPrivacy = { access: 'read', sensitivity: 'sensitive', destructive: false, external: false };

describe('IntentDispatcherService', () => {
  it('allows a plain read intent and emits intent.authorized (not warned)', async () => {
    const { dispatcher, send } = make();

    const decision = await dispatcher.authorize(schema(READ), context, 'native', 'memory_act');

    expect(decision).toEqual({ allowed: true, warned: false });
    expect(send).toHaveBeenCalledTimes(1);
    const [name, payload, options] = send.mock.calls[0];
    expect(name).toBe('intent.authorized');
    expect(payload).toMatchObject({ intent: 'memory.act', tool: 'memory_act', surface: 'native', warned: false });
    expect(options).toEqual({ queue: 'telemetry' });
  });

  it('denies destructive by default and emits intent.denied', async () => {
    const { dispatcher, send } = make();

    const decision = await dispatcher.authorize(schema(DESTRUCTIVE), context, 'mcp', 'memory_forget');

    expect(decision).toMatchObject({ allowed: false, reason: 'destructive_denied_by_policy' });
    expect(send.mock.calls[0][0]).toBe('intent.denied');
    expect(send.mock.calls[0][1]).toMatchObject({ surface: 'mcp', reason: 'destructive_denied_by_policy' });
  });

  it('authorizes external with warned=true under the default policy', async () => {
    const { dispatcher, send } = make();

    const decision = await dispatcher.authorize(schema(EXTERNAL), context, 'native', 'media_x');

    expect(decision).toEqual({ allowed: true, warned: true });
    expect(send.mock.calls[0][1]).toMatchObject({ warned: true, external: true });
  });

  it('denies external when denyExternal is enabled', async () => {
    const { dispatcher } = make({ ...DEFAULT_INTENT_POLICY, denyExternal: true });

    const decision = await dispatcher.authorize(schema(EXTERNAL), context, 'native', 'media_x');

    expect(decision).toMatchObject({ allowed: false, reason: 'external_denied_by_policy' });
  });

  it('allows sensitive by default but denies when denySensitive is enabled', async () => {
    const allowed = await make().dispatcher.authorize(schema(SENSITIVE), context, 'native', 't');
    expect(allowed.allowed).toBe(true);

    const denied = await make({ ...DEFAULT_INTENT_POLICY, denySensitive: true }).dispatcher.authorize(
      schema(SENSITIVE),
      context,
      'native',
      't',
    );
    expect(denied).toMatchObject({ allowed: false, reason: 'sensitive_denied_by_policy' });
  });

  it('does not throw and still returns the decision when the audit emit fails', async () => {
    const send = jest.fn().mockRejectedValue(new Error('bus down'));
    const dispatcher = new IntentDispatcherService(makeLogger(), { send } as any, DEFAULT_INTENT_POLICY);

    const decision = await dispatcher.authorize(schema(DESTRUCTIVE), context, 'native', 'memory_forget');

    expect(decision.allowed).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
