import type { QueueOptions } from '@ci/domains/events';

/** Hub URN for the official OpenClaw app. Dispatch doorbells this one only. */
export const OPENCLAW_APP_URN = 'ci-openclaw:ci-marketplace';

/**
 * The installed app that works a job, per `ci.agent_jobs.harness_id`. Only that
 * app's connect key may fetch a job's packet or checkpoint it: those two routes
 * ARE the harness, and a checkpoint writes turns stamped `openclaw` and can
 * complete the owner's task.
 */
export const HARNESS_CONNECT_APP: Readonly<Record<string, string>> = {
  openclaw: OPENCLAW_APP_URN.split(':')[0],
};

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
/** Long-running OpenClaw dispatch. Stays `active` until checkpoint/complete. */
export const AGENT_DISPATCH_QUEUE = 'agent';

export const AGENT_DISPATCH_QUEUE_OPTIONS: QueueOptions = {
  policy: 'short',
  expireInSeconds: 2 * 60 * 60,
  retryLimit: 3,
  retryDelay: 30,
};

/** Still queued after this: OpenClaw never fetched the packet. */
export const DISPATCH_QUEUED_STALE_MS = 2 * 60 * 1000;

/** Running this long with no terminal checkpoint: treat as hung. */
export const DISPATCH_RUNNING_STALE_MS = 15 * 60 * 1000;

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
