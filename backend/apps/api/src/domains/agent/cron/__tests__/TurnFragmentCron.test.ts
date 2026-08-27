import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';

import { AGENT_MEMORY_QUEUE, AGENT_MEMORY_QUEUE_OPTIONS } from '../../constants';
import { AgentTurnFragmentsEvent } from '../../events';
import { TURN_FRAGMENT_SETTINGS, type TurnFragmentService } from '../../services/TurnFragmentService';
import { TURN_FRAGMENT_CRON, TurnFragmentCron, turnFragmentWindowKey } from '../TurnFragmentCron';

const WINDOW = { since: new Date('2026-08-26T10:00:00Z'), until: new Date('2026-08-26T11:00:00Z') };

const logger = {
  setContext: () => undefined,
  log: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

interface Send {
  name: string;
  payload: unknown;
  options?: { queue?: string; singletonKey?: string };
}

function makeCron(options: { enabled: boolean; users: string[] }) {
  const sends: Send[] = [];
  let audienceScans = 0;

  const turnFragmentService = {
    resolveWindow: () => WINDOW,
    listUsersWithCompletedTurns: async () => {
      audienceScans += 1;

      return options.users;
    },
  } as unknown as TurnFragmentService;

  const eventService = {
    send: async (name: string, payload: unknown, sendOptions?: Send['options']) => {
      sends.push({ name, payload, options: sendOptions });

      return [];
    },
  } as unknown as EventService;

  const featureService = {
    isFeatureEnabled: async () => options.enabled,
  } as unknown as FeatureService;

  return {
    sends,
    scans: () => audienceScans,
    cron: new TurnFragmentCron(turnFragmentService, eventService, featureService, logger),
  };
}

describe('TurnFragmentCron schedule', () => {
  it('registers under a stable name off second 0', () => {
    const options = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      TurnFragmentCron.prototype.cronWriteTurnFragments,
    ) as { cronTime?: string; name?: string } | undefined;

    expect(options?.name).toBe('TurnFragmentCron.cronWriteTurnFragments');
    expect(options?.cronTime).toBe(TURN_FRAGMENT_CRON);
    expect(TURN_FRAGMENT_CRON.split(' ')[0]).not.toBe('0');
  });

  it('takes its cadence from config rather than a source constant', () => {
    expect(TURN_FRAGMENT_CRON).toBe(`3 */${TURN_FRAGMENT_SETTINGS.intervalMinutes} * * * *`);
    expect(TURN_FRAGMENT_SETTINGS.intervalMinutes).toBeGreaterThanOrEqual(5);
    expect(TURN_FRAGMENT_SETTINGS.intervalMinutes).toBeLessThanOrEqual(15);
  });
});

describe('turnFragmentWindowKey', () => {
  it('gives one key per interval-sized bucket', () => {
    const base = new Date('2026-08-26T11:00:00Z');
    const withinBucket = new Date(base.getTime() + 60_000);
    const nextBucket = new Date(base.getTime() + 10 * 60_000);

    expect(turnFragmentWindowKey(withinBucket, 10)).toBe(turnFragmentWindowKey(base, 10));
    expect(turnFragmentWindowKey(nextBucket, 10)).not.toBe(turnFragmentWindowKey(base, 10));
  });
});

describe('TurnFragmentCron.cronWriteTurnFragments', () => {
  it('does not even scan for an audience while the flag is off', async () => {
    const { cron, sends, scans } = makeCron({ enabled: false, users: ['user-a'] });

    await cron.cronWriteTurnFragments();

    expect(scans()).toBe(0);
    expect(sends).toHaveLength(0);
  });

  it('enqueues one keyed job per user onto the agent-memory queue', async () => {
    const { cron, sends } = makeCron({ enabled: true, users: ['user-a', 'user-b'] });

    await cron.cronWriteTurnFragments();

    const windowKey = turnFragmentWindowKey(WINDOW.until, TURN_FRAGMENT_SETTINGS.intervalMinutes);

    expect(sends).toHaveLength(2);
    expect(sends[0]).toStrictEqual({
      name: AgentTurnFragmentsEvent,
      payload: {
        userId: 'user-a',
        since: WINDOW.since.toISOString(),
        until: WINDOW.until.toISOString(),
      },
      options: {
        queue: AGENT_MEMORY_QUEUE,
        singletonKey: `fn:agent-turn-fragments:user-a:${windowKey}`,
      },
    });
    expect(sends[1].options?.singletonKey).toBe(`fn:agent-turn-fragments:user-b:${windowKey}`);
  });

  it('sends nothing when nobody chatted in the window', async () => {
    const { cron, sends } = makeCron({ enabled: true, users: [] });

    await cron.cronWriteTurnFragments();

    expect(sends).toHaveLength(0);
  });

  /**
   * `policy: 'short'` is queue-wide and collapses keyless sends together under
   * `COALESCE(singleton_key,'')`. The queue is only safe to declare that way
   * while every send onto it carries a key.
   */
  it('carries a singleton key on every send, which the queue policy requires', async () => {
    const { cron, sends } = makeCron({ enabled: true, users: ['user-a', 'user-b', 'user-c'] });

    await cron.cronWriteTurnFragments();

    expect(AGENT_MEMORY_QUEUE_OPTIONS.policy).toBe('short');
    expect(sends.filter((send) => send.options?.singletonKey)).toHaveLength(sends.length);
    expect(new Set(sends.map((send) => send.options?.singletonKey)).size).toBe(3);
  });
});
