/** Work types gated by the smart.rotation meta flag — each keeps its own cadence. */
export const SMART_ROTATION_WORK_TYPES = [
  'question_feed',
  'answer_infer',
  'schedule_sync',
  'insights',
  'summaries',
  /** Deterministic graph prep: person stubs + comm/event entity links (Import Tools stages 4–6). */
  'graph_link',
  /** LLM relationship extraction from recent comms/events/answers. */
  'graph_enrich',
  /** Ask one contextualizing selector prompt when the feed slot is empty. */
  'context_prompt',
  'hydrate_answers',
  'hydrate_inventory',
] as const;

export type SmartRotationWorkType = (typeof SMART_ROTATION_WORK_TYPES)[number];

export const SMART_ROTATION_QUEUE = 'smart-rotation';

/** Users enqueued per cron tick, per work type (round-robin across onboarded users). */
export const SMART_ROTATION_USERS_PER_TICK = 10;

/** Skip enqueue when either queue exceeds this pending job count. */
export const SMART_ROTATION_BACKLOG_THRESHOLD = 500;

/**
 * Staggered cron schedules so LLM-heavy jobs do not fire in the same minute.
 * Seconds field first (node-cron with seconds support).
 */
export const SMART_ROTATION_CRONS = {
  question_feed: '0 0,20,40 * * * *',
  answer_infer: '0 7,27,47 * * * *',
  schedule_sync: '0 14 * * * *',
  summaries: '0 22 * * * *',
  insights: '0 45 */3 * * *',
  graph_link: '0 5 */2 * * *',
  graph_enrich: '0 10 */6 * * *',
  context_prompt: '0 30 */4 * * *',
  hydrate_answers: '0 5 3 * * *',
  hydrate_inventory: '0 15 3 * * *',
} as const satisfies Record<SmartRotationWorkType, string>;
