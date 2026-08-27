import type { QueueOptions } from '@ci/domains/events';

/**
 * Per-user chat-turn distillation. One queue, one event
 * (`AgentTurnFragmentsEvent`), one producer (`TurnFragmentCron`).
 *
 * `policy: 'short'` is what makes the fan-out's singletonKey
 * (`fn:agent-turn-fragments:<user>:<windowKey>`) actually refuse a duplicate —
 * pg-boss 10 stores a singletonKey under the default `standard` policy and
 * never enforces it. It is queue-WIDE and collapses keyless sends together
 * under `COALESCE(singleton_key,'')`, so it is only safe here because the
 * cron is the sole sender and every send it makes carries a key. Anything
 * added to this queue later must carry one too — `agentTurnFragmentsQueue`
 * in the cron's test pins that.
 *
 * `localConcurrency: 1` because a tick's work is a windowed scan of
 * `ci.messages` plus one INSERT per turn: cheap, but pointless to run six
 * abreast against a 25-connection pool when the cadence is minutes.
 */
export const AGENT_MEMORY_QUEUE = 'agent-memory';

export const AGENT_MEMORY_QUEUE_OPTIONS: QueueOptions = {
  policy: 'short',
  localConcurrency: 1,
  // A tick is bounded by `maxTurnsPerUser`; 5 minutes is far past its worst
  // case and still inside the shortest configurable cron interval, so an
  // expired job never overlaps the next window's send for the same user.
  expireInSeconds: 300,
  retryLimit: 3,
  retryDelay: 30,
};
