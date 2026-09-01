/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE APPLIANCE THIS PAGE WAS BUILT AGAINST, AS DATA.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A pg-boss-shaped corpus — rows, not responses. `previewApi.ts` projects and
 * filters it the way `JobQueryService` / `JobMonitorService` project and filter
 * the real tables, so the preview exercises the page's contract rather than a
 * hand-written copy of each endpoint's output.
 *
 * The numbers are not invented. They reproduce the state described in the
 * commit that built this page (feeaedce9): a 12,710-job `image-description`
 * backlog averaging ~33.5s a job against `search-index` at ~0.5s, 1,191
 * dead-lettered jobs that the old dashboard double-counted as a live backlog,
 * and twelve recent failures that are four distinct causes rather than one
 * undifferentiated wall. A preview whose queues are all 20 rows deep and all
 * green would not have caught the axis clipping or the All-tab count, which is
 * the entire reason the harness exists.
 *
 * Deterministic: every value comes from a seeded PRNG, so two runs of the
 * preview render the same page and a screenshot diff means something. Only the
 * time anchor moves, and it is passed in rather than read here.
 */

import type { ActiveImportSnapshot } from '../../pages/ImportPage/useImportApi';

/** Every event name and queue below exists in the backend taxonomy. */
export const PREVIEW_USER_ID = '9f8c1d2e-4b3a-47c6-9e10-2f5b7a6c8d90';

/** mulberry32 — small, fast, and stable across Node versions. */
function rng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uuid-shaped id, so the table renders the width it will render in production. */
function uuid(next: () => number): string {
  const hex = (n: number): string =>
    Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join('');

  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

/** One row of `pgboss.job`, as the entity the services read exposes it. */
export interface PreviewJobRow {
  readonly id: string;
  /** pg-boss's QUEUE. `job.name` — not the event; see PgBossJobEntity. */
  readonly name: string;
  readonly state: 'created' | 'active' | 'retry' | 'completed' | 'failed' | 'cancelled';
  readonly data: Record<string, unknown>;
  readonly output: Record<string, unknown> | null;
  readonly createdOn: Date;
  readonly startedOn: Date | null;
  readonly completedOn: Date | null;
  readonly startAfter: Date;
  readonly retryCount: number;
  readonly retryLimit: number;
  readonly priority: number;
  readonly policy: string | null;
  readonly deadLetter: string | null;
}

/** An archived job. `pgboss.archive` is `CREATE TABLE archive (LIKE job)` plus this. */
export interface PreviewArchiveRow extends PreviewJobRow {
  readonly archivedOn: Date;
}

interface Failure {
  readonly message: string;
  readonly stack: string;
}

/**
 * The four causes behind the twelve most recent failures on the appliance this
 * was captured from. The stacks carry absolute container paths because the real
 * ones do — DeadLettersCard groups on the message's FIRST LINE precisely so two
 * occurrences from different builds still group together.
 */
const FAILURES = {
  ffmpeg: {
    message: 'Cannot find ffmpeg',
    stack: [
      'Error: Cannot find ffmpeg',
      '    at /app/apps/api/node_modules/fluent-ffmpeg/lib/capabilities.js:154:21',
      '    at PreviewGenerationService.generateVideoPreview (/app/apps/api/dist/domains/files/services/PreviewGenerationService.js:212:15)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n'),
  },
  model: {
    message: 'Invalid model specified: qwen/qwen3-vl-30b',
    stack: [
      'Error: Invalid model specified: qwen/qwen3-vl-30b',
      '    at OllamaService.chat (/app/apps/api/dist/domains/llm/services/OllamaService.js:188:13)',
      '    at ImageDescriptionService.describe (/app/apps/api/dist/domains/files/services/ImageDescriptionService.js:96:28)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n'),
  },
  column: {
    message: 'column gd.user_id does not exist',
    stack: [
      'QueryFailedError: column gd.user_id does not exist',
      '    at PostgresQueryRunner.query (/app/apps/api/node_modules/typeorm/driver/postgres/PostgresQueryRunner.js:219:19)',
      '    at GraphDerivationService.refresh (/app/apps/api/dist/domains/graph/services/GraphDerivationService.js:341:24)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n'),
  },
  /**
   * The fallback, for queues with no standing fault of their own. pg-boss
   * expires a job whose handler outlives its lease and records it as failed —
   * so a failed row always has a reason, and a preview where some failures
   * explain themselves and others are blank would be showing a state the
   * appliance does not actually produce.
   */
  expired: {
    message: 'job expired: handler exceeded its 300s lease',
    stack: [
      'Error: job expired: handler exceeded its 300s lease',
      '    at PgBoss.expire (/app/apps/api/node_modules/pg-boss/src/manager.js:412:17)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n'),
  },
  sidecar: {
    message: 'fetch failed',
    stack: [
      'TypeError: fetch failed',
      '    at node:internal/deps/undici/undici:13502:13',
      '    at PythonFunctionClient.run (/app/apps/api/dist/domains/python-functions/services/PythonFunctionClient.js:74:22)',
      '  cause: Error: connect ECONNREFUSED 172.19.0.7:8002',
    ].join('\n'),
  },
} as const satisfies Record<string, Failure>;

/**
 * How each queue behaves. Durations are what the duration chart is FOR: the
 * spread between a 33.5s image description and a 0.5s index write is why a
 * 12,710-job backlog on one is a day of work and on the other an afternoon.
 */
interface QueueProfile {
  readonly queue: string;
  /** Events seen on this queue. Every one resolves in the backend taxonomy. */
  readonly events: readonly string[];
  /** Mean run time in ms, and the ± spread around it. */
  readonly avgMs: number;
  readonly spreadMs: number;
  readonly pending: number;
  readonly active: number;
  readonly retry: number;
  readonly completed: number;
  readonly failed: number;
  /** Rows that have aged out of the working set into `pgboss.archive`. */
  readonly archived: number;
  readonly failure?: Failure;
  /** `smart.rotation.work` is one event covering eleven unrelated activities. */
  readonly workTypes?: readonly string[];
}

const QUEUES: readonly QueueProfile[] = [
  {
    queue: 'image-description',
    events: ['file.uploaded', 'file.image-description-backfill-request'],
    avgMs: 33_500,
    spreadMs: 9_000,
    pending: 12_710,
    active: 2,
    retry: 6,
    completed: 214,
    failed: 96,
    archived: 1_842,
    failure: FAILURES.model,
  },
  {
    queue: 'search-index',
    events: [
      'note.created',
      'event.created',
      'event.updated',
      'person.updated',
      'content.created',
      'message.created',
      'communication.created',
      'browseractivity.created',
      'position.created',
      'receipt.created',
    ],
    avgMs: 500,
    spreadMs: 240,
    pending: 318,
    active: 4,
    retry: 0,
    completed: 640,
    failed: 3,
    archived: 24_180,
  },
  {
    queue: 'pipeline-embed',
    events: ['pipeline.slice'],
    avgMs: 2_400,
    spreadMs: 900,
    pending: 486,
    active: 2,
    retry: 4,
    completed: 128,
    failed: 12,
    archived: 6_420,
    failure: FAILURES.sidecar,
  },
  {
    queue: 'pipeline-index',
    events: ['content.created', 'pipeline.slice'],
    avgMs: 900,
    spreadMs: 350,
    pending: 122,
    active: 1,
    retry: 0,
    completed: 96,
    failed: 2,
    archived: 4_180,
  },
  {
    queue: 'pipeline-enrich',
    events: ['pipeline.slice', 'pipeline.sweep'],
    avgMs: 4_100,
    spreadMs: 1_600,
    pending: 64,
    active: 1,
    retry: 2,
    completed: 74,
    failed: 8,
    archived: 2_640,
    failure: FAILURES.sidecar,
  },
  {
    queue: 'pipeline-enrich-media',
    events: ['preview.generated', 'cv.detections.captured'],
    avgMs: 6_800,
    spreadMs: 2_500,
    pending: 41,
    active: 1,
    retry: 1,
    completed: 38,
    failed: 6,
    archived: 1_120,
    failure: FAILURES.ffmpeg,
  },
  {
    queue: 'file-preview-generation',
    events: ['file.uploaded', 'file.created'],
    avgMs: 3_200,
    spreadMs: 1_800,
    pending: 88,
    active: 1,
    retry: 3,
    completed: 52,
    failed: 34,
    archived: 2_960,
    failure: FAILURES.ffmpeg,
  },
  {
    queue: 'document-parsing',
    events: ['document.parsed', 'file.created'],
    avgMs: 12_400,
    spreadMs: 5_200,
    pending: 27,
    active: 1,
    retry: 0,
    completed: 31,
    failed: 4,
    archived: 880,
    failure: FAILURES.sidecar,
  },
  {
    queue: 'cv-detections',
    events: ['cv.detections.captured'],
    avgMs: 8_900,
    spreadMs: 3_100,
    pending: 19,
    active: 0,
    retry: 0,
    completed: 22,
    failed: 1,
    archived: 640,
  },
  {
    queue: 'geocode',
    events: ['event.geocode-batch-request', 'graph.location.created'],
    avgMs: 1_150,
    spreadMs: 600,
    pending: 54,
    active: 0,
    retry: 1,
    completed: 44,
    failed: 2,
    archived: 3_120,
  },
  {
    queue: 'people-linking',
    events: ['communication.created', 'graph.person.created'],
    avgMs: 780,
    spreadMs: 320,
    pending: 36,
    active: 1,
    retry: 0,
    completed: 40,
    failed: 1,
    archived: 5_260,
  },
  {
    queue: 'smart-rotation',
    events: ['smart.rotation.work'],
    avgMs: 5_600,
    spreadMs: 4_200,
    pending: 11,
    active: 1,
    retry: 2,
    completed: 34,
    failed: 18,
    archived: 1_480,
    failure: FAILURES.column,
    workTypes: [
      'question_feed',
      'answer_infer',
      'schedule_sync',
      'insights',
      'summaries',
      'graph_link',
      'graph_enrich',
      'context_prompt',
      'hydrate_answers',
      'hydrate_things',
    ],
  },
  {
    queue: 'py-fn-hbpe',
    events: ['python.function.run'],
    avgMs: 18_700,
    spreadMs: 6_400,
    pending: 8,
    active: 1,
    retry: 1,
    completed: 16,
    failed: 9,
    archived: 420,
    failure: FAILURES.sidecar,
  },
  {
    queue: 'py-fn-summary',
    events: ['python.function.run', 'summary.created'],
    avgMs: 9_300,
    spreadMs: 3_800,
    pending: 6,
    active: 0,
    retry: 0,
    completed: 21,
    failed: 5,
    archived: 560,
    failure: FAILURES.sidecar,
  },
  {
    queue: 'planning',
    events: ['task.created', 'task.updated', 'action.created'],
    avgMs: 2_900,
    spreadMs: 1_400,
    pending: 14,
    active: 0,
    retry: 0,
    completed: 26,
    failed: 2,
    archived: 1_240,
  },
  {
    queue: 'etl',
    events: ['import.stage', 'ingest.coalesce'],
    avgMs: 41_000,
    spreadMs: 22_000,
    pending: 73,
    active: 2,
    retry: 1,
    completed: 18,
    failed: 3,
    archived: 2_180,
  },
  {
    queue: 'import-inbox-provision',
    events: ['user.created'],
    avgMs: 640,
    spreadMs: 200,
    pending: 0,
    active: 0,
    retry: 0,
    completed: 2,
    failed: 0,
    archived: 14,
  },
  {
    queue: 'telemetry',
    events: ['tool.invoked'],
    avgMs: 120,
    spreadMs: 60,
    pending: 9,
    active: 0,
    retry: 0,
    completed: 88,
    failed: 0,
    archived: 9_840,
  },
  {
    queue: 'default',
    events: ['answer.created', 'question.created', 'context.prompt.persist'],
    avgMs: 1_800,
    spreadMs: 900,
    pending: 21,
    active: 0,
    retry: 0,
    completed: 36,
    failed: 1,
    archived: 1_960,
  },
  {
    queue: 'chat',
    events: ['chat.generate', 'chat.summarization', 'infer.question.answer'],
    avgMs: 7_400,
    spreadMs: 3_600,
    pending: 3,
    active: 1,
    retry: 0,
    completed: 52,
    failed: 2,
    archived: 3_480,
  },
];

/**
 * Dead-lettered jobs, which pg-boss stores in state `created` on its own queue.
 *
 * 1,191 of them, which is the number the old dashboard reported as a live
 * backlog while the SAME jobs were counted again under `failed` on their
 * original queue. They are here so the preview shows the counter that fixed it.
 */
const DEAD_LETTER_COUNT = 1_191;

const DEAD_LETTER_QUEUE = 'dead-letter';

/** Sampling helper: a value around `mean`, never below a tenth of it. */
function around(next: () => number, mean: number, spread: number): number {
  return Math.max(Math.round(mean + (next() - 0.5) * 2 * spread), Math.round(mean / 10));
}

/** A payload of roughly the size the real one carries, so `payloadBytes` varies. */
function payload(next: () => number, event: string, workType?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: event,
    userId: PREVIEW_USER_ID,
    entityId: uuid(next),
  };

  if (workType) {
    body['workType'] = workType;
  }

  // A handful of rows carry a fat payload (a batch request naming its slice),
  // which is what makes the expanded row's byte count worth showing at all.
  if (next() < 0.12) {
    body['ids'] = Array.from({ length: 8 + Math.floor(next() * 40) }, () => uuid(next));
  }

  return body;
}

interface BuildOptions {
  /** Epoch millis the corpus is anchored to. */
  readonly now: number;
}

/**
 * The live table, `pgboss.job`.
 *
 * Ordering is not applied here — `previewApi` sorts, exactly as the API's
 * `ORDER BY created_on DESC, id DESC` does.
 */
export function buildJobRows({ now }: BuildOptions): PreviewJobRow[] {
  const next = rng(0x1a2b3c4d);
  const rows: PreviewJobRow[] = [];

  const emit = (
    profile: QueueProfile,
    state: PreviewJobRow['state'],
    count: number,
    ageWindowMs: number,
  ): void => {
    for (let index = 0; index < count; index += 1) {
      const event = profile.events[Math.floor(next() * profile.events.length)] ?? 'file.uploaded';
      const workType = profile.workTypes?.[Math.floor(next() * profile.workTypes.length)];
      const createdOn = new Date(now - Math.floor(next() * ageWindowMs));
      const durationMs = around(next, profile.avgMs, profile.spreadMs);

      const started = state === 'created' ? null : new Date(createdOn.getTime() + Math.floor(next() * 4_000));
      const completed =
        state === 'created' || state === 'active' || state === 'retry'
          ? null
          : new Date((started ?? createdOn).getTime() + durationMs);

      const failed = state === 'failed' || state === 'retry';

      rows.push({
        id: uuid(next),
        name: profile.queue,
        state,
        data: payload(next, event, workType),
        output: failed
          ? { ...(profile.failure ?? FAILURES.expired), failedAt: createdOn.toISOString() }
          : null,
        createdOn,
        startedOn: started,
        completedOn: completed,
        startAfter: createdOn,
        retryCount: state === 'retry' ? 1 + Math.floor(next() * 2) : failed ? 3 : 0,
        retryLimit: 3,
        priority: 0,
        policy: null,
        deadLetter: DEAD_LETTER_QUEUE,
      });
    }
  };

  const HOUR = 3_600_000;

  for (const profile of QUEUES) {
    // A backlog is old at the head and new at the tail: these were enqueued by
    // one import six hours ago and have been draining since.
    emit(profile, 'created', profile.pending, 6 * HOUR);
    emit(profile, 'active', profile.active, 4 * 60_000);
    emit(profile, 'retry', profile.retry, 2 * HOUR);
    // pg-boss keeps terminal jobs ~12h before archiving them.
    emit(profile, 'completed', profile.completed, 12 * HOUR);
    emit(profile, 'failed', profile.failed, 12 * HOUR);
  }

  // The dead-letter copies. Stored as `created` on their own queue, which is
  // exactly why counting state alone reported them as a live backlog.
  const causes = [FAILURES.model, FAILURES.ffmpeg, FAILURES.column, FAILURES.sidecar];

  for (let index = 0; index < DEAD_LETTER_COUNT; index += 1) {
    const failure = causes[index % causes.length] ?? FAILURES.model;
    const createdOn = new Date(now - Math.floor(next() * 30 * 24 * HOUR));

    rows.push({
      id: uuid(next),
      name: DEAD_LETTER_QUEUE,
      state: 'created',
      data: payload(next, 'file.uploaded'),
      output: { ...failure, failedAt: createdOn.toISOString() },
      createdOn,
      startedOn: null,
      completedOn: null,
      startAfter: createdOn,
      retryCount: 3,
      retryLimit: 3,
      priority: 0,
      policy: null,
      deadLetter: null,
    });
  }

  return rows;
}

/**
 * `pgboss.archive` — terminal jobs older than about twelve hours.
 *
 * Counted, not materialized. The dashboard renders exactly 25 archive rows and
 * a top-15 distribution, but the summary tiles COUNT the whole table: on this
 * appliance that is ~74k rows, and building them all so 25 could be shown would
 * cost tens of megabytes for nothing. What the endpoints can observe is
 * reproduced exactly; what they cannot is not built.
 *
 * This is also why `completed` on the tiles is two orders of magnitude larger
 * than anything in the table — the working set is ~36 hours, the archive is the
 * rest, and the summary adds them. A preview that quietly dropped the archive
 * would show a "completed" figure that never matches the real appliance.
 */
export interface PreviewArchive {
  /** Per-state totals across the whole table, for the summary tiles. */
  readonly counts: Readonly<Record<'completed' | 'failed' | 'cancelled', number>>;
  /** The newest 25 — the only archive rows the dashboard ever renders. */
  readonly recent: readonly PreviewArchiveRow[];
  /** Top job names by count, grouped the way `JobMonitorService` groups them. */
  readonly distribution: ReadonlyArray<{ readonly jobName: string; readonly count: number }>;
}

/** How the API groups a row for the distribution charts. */
export function distributionKey(event: string | null, workType: string | null, queue: string): string {
  if (event === 'smart.rotation.work') {
    return `smart.rotation.work · ${workType ?? 'unknown'}`;
  }

  return event ?? queue;
}

export function buildArchive({ now }: BuildOptions): PreviewArchive {
  const next = rng(0x5e6f7a8b);
  const HOUR = 3_600_000;

  const counts = { completed: 0, failed: 0, cancelled: 0 };
  const distribution = new Map<string, number>();
  const recent: PreviewArchiveRow[] = [];

  for (const profile of QUEUES) {
    // Same standing-fault split the live rows use: one archived job in six on a
    // queue with a known fault, one in forty everywhere else.
    const failRate = profile.failure ? 0.16 : 0.025;
    const failed = Math.round(profile.archived * failRate);
    const cancelled = Math.round(profile.archived * 0.004);

    counts.failed += failed;
    counts.cancelled += cancelled;
    counts.completed += profile.archived - failed - cancelled;

    // Split the queue's archive across the events that run on it. Weights are
    // drawn once per event and normalized, so the shares are stable and uneven
    // — a flat split would make every bar in the chart the same height.
    const keys =
      profile.workTypes && profile.events.includes('smart.rotation.work')
        ? profile.workTypes.map((workType) => distributionKey('smart.rotation.work', workType, profile.queue))
        : profile.events.map((event) => distributionKey(event, null, profile.queue));

    const weights = keys.map(() => 0.4 + next());
    const total = weights.reduce((sum, weight) => sum + weight, 0);

    keys.forEach((key, index) => {
      const share = Math.round((profile.archived * (weights[index] ?? 0)) / total);

      distribution.set(key, (distribution.get(key) ?? 0) + share);
    });
  }

  // The 25 the dashboard shows, spread over the hour either side of the archive
  // threshold so `archivedOn` reads as "just aged out".
  const profiles = QUEUES.filter((profile) => profile.archived > 0);

  for (let index = 0; index < 25; index += 1) {
    const profile = profiles[Math.floor(next() * profiles.length)] ?? QUEUES[0];

    if (!profile) {
      break;
    }

    const event = profile.events[Math.floor(next() * profile.events.length)] ?? 'file.uploaded';
    const workType = profile.workTypes?.[Math.floor(next() * profile.workTypes.length)];
    const archivedOn = new Date(now - Math.floor(next() * HOUR));
    const completedOn = new Date(archivedOn.getTime() - 12 * HOUR);
    const durationMs = around(next, profile.avgMs, profile.spreadMs);
    const startedOn = new Date(completedOn.getTime() - durationMs);
    const failing = profile.failure ? next() < 0.16 : next() < 0.025;

    recent.push({
      id: uuid(next),
      name: profile.queue,
      state: failing ? 'failed' : 'completed',
      data: payload(next, event, workType),
      output: failing
        ? { ...(profile.failure ?? FAILURES.expired), failedAt: completedOn.toISOString() }
        : null,
      createdOn: new Date(startedOn.getTime() - Math.floor(next() * 4_000)),
      startedOn,
      completedOn,
      startAfter: startedOn,
      retryCount: failing ? 3 : 0,
      retryLimit: 3,
      priority: 0,
      policy: null,
      deadLetter: DEAD_LETTER_QUEUE,
      archivedOn,
    });
  }

  recent.sort((a, b) => b.archivedOn.getTime() - a.archivedOn.getTime());

  return {
    counts,
    recent,
    distribution: [...distribution.entries()]
      .map(([jobName, count]) => ({ jobName, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15),
  };
}

/**
 * `pgboss.queue` — the queue registry, with each queue's retry policy.
 *
 * Rendered by the Schedules card's queue table, and the reason `retryLimit` on
 * a row means anything: a job at 3 of 3 is finished failing, not still trying.
 */
export function buildQueueRegistry({ now }: BuildOptions): ReadonlyArray<{
  name: string;
  policy: string | null;
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  expireInSeconds: number | null;
  retentionMinutes: number | null;
  deadLetter: string | null;
  createdOn: string;
  updatedOn: string;
}> {
  const created = new Date(now - 47 * 24 * 3_600_000).toISOString();

  return [...QUEUES.map((profile) => profile.queue), DEAD_LETTER_QUEUE].sort().map((name) => ({
    name,
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    // Long-running work gets a longer lease; the defaults would expire a 33s
    // image description as abandoned.
    expireInSeconds: name === 'image-description' || name === 'etl' ? 900 : 300,
    retentionMinutes: 14 * 24 * 60,
    deadLetter: name === DEAD_LETTER_QUEUE ? null : DEAD_LETTER_QUEUE,
    createdOn: created,
    updatedOn: created,
  }));
}

/**
 * The recurring jobs, as Nest's scheduler registry reports them.
 *
 * Real names and real expressions — these are `@Cron` methods that exist in the
 * backend. `overdue` is computed server-side, so one is set here deliberately:
 * a schedule can be `running: true` forever while its body throws on every
 * tick, and the row that says so is the one worth being able to see.
 */
export function buildCrons({ now }: BuildOptions): ReadonlyArray<{
  name: string;
  cron: string;
  timezone: string | null;
  running: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  overdue: boolean;
}> {
  const MINUTE = 60_000;
  const HOUR = 3_600_000;

  const rows: Array<{
    name: string;
    cron: string;
    everyMs: number;
    ranAgoMs: number | null;
    /** Null when the body has been throwing — `lastRunAt` without a success. */
    succeededAgoMs: number | null;
    overdue?: boolean;
  }> = [
    {
      name: 'JobMetricsCollector.sampleOnSchedule',
      cron: '*/5 * * * *',
      everyMs: 5 * MINUTE,
      ranAgoMs: 2 * MINUTE,
      succeededAgoMs: 2 * MINUTE,
    },
    {
      name: 'JobMetricsCollector.purgeOnSchedule',
      cron: '0 4 * * *',
      everyMs: 24 * HOUR,
      ranAgoMs: 9 * HOUR,
      succeededAgoMs: 9 * HOUR,
    },
    {
      name: 'PipelineTickCron.runOnSchedule',
      cron: '*/2 * * * *',
      everyMs: 2 * MINUTE,
      ranAgoMs: MINUTE,
      succeededAgoMs: MINUTE,
    },
    {
      name: 'ImportStageListener.sweepOnSchedule',
      cron: '*/1 * * * *',
      everyMs: MINUTE,
      ranAgoMs: 40_000,
      succeededAgoMs: 40_000,
    },
    {
      name: 'DeadLetterReaperListener.reapOnSchedule',
      cron: '*/10 * * * *',
      everyMs: 10 * MINUTE,
      ranAgoMs: 6 * MINUTE,
      succeededAgoMs: 6 * MINUTE,
    },
    // Running, ticking, and failing every time — the case the `running` flag
    // alone cannot show. Its body is what throws `column gd.user_id does not exist`.
    {
      name: 'DerivationCron.deriveNightly',
      cron: '0 3 * * *',
      everyMs: 24 * HOUR,
      ranAgoMs: 10 * HOUR,
      succeededAgoMs: null,
    },
    {
      name: 'DailyMetricsCron.refreshRecent',
      cron: '0 * * * *',
      everyMs: HOUR,
      ranAgoMs: 22 * MINUTE,
      succeededAgoMs: 22 * MINUTE,
    },
    {
      name: 'ActivityRollupCron.refreshRollup',
      cron: '15 * * * *',
      everyMs: HOUR,
      ranAgoMs: 37 * MINUTE,
      succeededAgoMs: 37 * MINUTE,
    },
    {
      name: 'FeedQueueCron.topUpFeedQueue',
      cron: '*/30 * * * *',
      everyMs: 30 * MINUTE,
      ranAgoMs: 12 * MINUTE,
      succeededAgoMs: 12 * MINUTE,
    },
    {
      name: 'AnswerInferenceCron.cronInferAnswers',
      cron: '0 */6 * * *',
      everyMs: 6 * HOUR,
      ranAgoMs: 3 * HOUR,
      succeededAgoMs: 3 * HOUR,
    },
    {
      name: 'MemoryCompactionCron.cronCompactMemories',
      cron: '0 2 * * *',
      everyMs: 24 * HOUR,
      ranAgoMs: 11 * HOUR,
      succeededAgoMs: 11 * HOUR,
    },
    {
      name: 'PlanningJobsCron.inboxScan',
      cron: '*/15 * * * *',
      everyMs: 15 * MINUTE,
      ranAgoMs: 8 * MINUTE,
      succeededAgoMs: 8 * MINUTE,
    },
    {
      name: 'PlanningJobsCron.todoScan',
      cron: '*/20 * * * *',
      everyMs: 20 * MINUTE,
      ranAgoMs: 14 * MINUTE,
      succeededAgoMs: 14 * MINUTE,
    },
    {
      name: 'PlanningJobsCron.verifyDone',
      cron: '0 */4 * * *',
      everyMs: 4 * HOUR,
      ranAgoMs: 2 * HOUR,
      succeededAgoMs: 2 * HOUR,
    },
    {
      name: 'OrphanCleanupCron.sweepOnSchedule',
      cron: '30 4 * * *',
      everyMs: 24 * HOUR,
      ranAgoMs: 8 * HOUR,
      succeededAgoMs: 8 * HOUR,
    },
    {
      name: 'ImportRetentionCron.runOnSchedule',
      cron: '0 5 * * 0',
      everyMs: 7 * 24 * HOUR,
      ranAgoMs: 3 * 24 * HOUR,
      succeededAgoMs: 3 * 24 * HOUR,
    },
    {
      name: 'AgentMemoryRetentionCron.runOnSchedule',
      cron: '0 5 * * *',
      everyMs: 24 * HOUR,
      ranAgoMs: 8 * HOUR,
      succeededAgoMs: 8 * HOUR,
    },
    // Never fired since the appliance came up: nothing to be overdue against.
    {
      name: 'AccountPurgeCron.purgeDueAccounts',
      cron: '0 6 * * *',
      everyMs: 24 * HOUR,
      ranAgoMs: null,
      succeededAgoMs: null,
    },
    {
      name: 'AskExpiryCron.expireOverdueAsks',
      cron: '10 * * * *',
      everyMs: HOUR,
      ranAgoMs: 32 * MINUTE,
      succeededAgoMs: 32 * MINUTE,
    },
    {
      name: 'EntityTypeAuditCron.auditEntityTypes',
      cron: '0 7 * * 1',
      everyMs: 7 * 24 * HOUR,
      ranAgoMs: 2 * 24 * HOUR,
      succeededAgoMs: 2 * 24 * HOUR,
    },
    {
      name: 'PythonFunctionCrons.actions',
      cron: '0 */3 * * *',
      everyMs: 3 * HOUR,
      ranAgoMs: 5 * HOUR,
      succeededAgoMs: 5 * HOUR,
      overdue: true,
    },
  ];

  return rows
    .map((row) => ({
      name: row.name,
      cron: row.cron,
      timezone: 'UTC',
      running: true,
      nextRunAt: new Date(now + (row.everyMs - ((row.ranAgoMs ?? 0) % row.everyMs))).toISOString(),
      lastRunAt: row.ranAgoMs == null ? null : new Date(now - row.ranAgoMs).toISOString(),
      lastSuccessAt: row.succeededAgoMs == null ? null : new Date(now - row.succeededAgoMs).toISOString(),
      overdue: Boolean(row.overdue),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One row of `ci.pipeline_dead_letters`.
 *
 * A different table from the pg-boss dead-letter QUEUE above, with a different
 * lifetime: pg-boss eventually deletes its copy, while a dead letter is kept
 * forever because it holds the payload needed to re-run the work.
 */
export interface PreviewDeadLetter {
  readonly id: string;
  readonly queue: string;
  readonly eventName: string;
  readonly stage: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly userId: string | null;
  readonly payload: Record<string, unknown>;
  readonly error: string;
  readonly failedAt: string;
  replayedAt: string | null;
}

/**
 * The 94 un-replayed dead letters, which are EIGHT causes — one of them 36
 * times over.
 *
 * That ratio is the card's whole reason for existing: grouping is what turns
 * "94 failures" into "a bad model id, a missing ffmpeg, and six others", and a
 * cause is the unit an operator replays. A fixture of 94 distinct errors would
 * render a card that looks fine and proves nothing.
 *
 * Mutable (`replayedAt`) on purpose — the preview's replay endpoint stamps
 * these, so the button in the UI does the thing it says it does.
 */
export function buildDeadLetters({ now }: BuildOptions): PreviewDeadLetter[] {
  const next = rng(0x9c8d7e6f);
  const HOUR = 3_600_000;

  const causes: ReadonlyArray<{
    count: number;
    queue: string;
    eventName: string;
    stage: string | null;
    entityType: string | null;
    error: string;
  }> = [
    {
      count: 36,
      queue: 'image-description',
      eventName: 'file.uploaded',
      stage: 'index.enrich',
      entityType: 'file',
      error: `${FAILURES.model.message}\n${FAILURES.model.stack}`,
    },
    {
      count: 18,
      queue: 'file-preview-generation',
      eventName: 'file.uploaded',
      stage: null,
      entityType: 'file',
      error: `${FAILURES.ffmpeg.message}\n${FAILURES.ffmpeg.stack}`,
    },
    {
      count: 12,
      queue: 'smart-rotation',
      eventName: 'smart.rotation.work',
      stage: null,
      entityType: null,
      error: `${FAILURES.column.message}\n${FAILURES.column.stack}`,
    },
    {
      count: 9,
      queue: 'pipeline-embed',
      eventName: 'pipeline.slice',
      stage: 'index.embed',
      entityType: 'content',
      error: `${FAILURES.sidecar.message}\n${FAILURES.sidecar.stack}`,
    },
    {
      count: 7,
      queue: 'document-parsing',
      eventName: 'document.parsed',
      stage: 'index.parse',
      entityType: 'file',
      error:
        'Unsupported document type: application/vnd.ms-outlook\n    at DocumentParserClient.parse (/app/apps/api/dist/domains/files/services/DocumentParserClient.js:118:11)',
    },
    {
      count: 5,
      queue: 'geocode',
      eventName: 'event.geocode-batch-request',
      stage: null,
      entityType: 'event',
      error:
        'Nominatim rate limit exceeded (429)\n    at GeocodeClient.lookup (/app/apps/api/dist/domains/graph/services/GeocodeClient.js:64:15)',
    },
    {
      count: 4,
      queue: 'py-fn-hbpe',
      eventName: 'python.function.run',
      stage: null,
      entityType: null,
      error:
        'HBPE returned 500: model artefact not found for user\n    at PythonFunctionClient.run (/app/apps/api/dist/domains/python-functions/services/PythonFunctionClient.js:81:13)',
    },
    {
      count: 3,
      queue: 'search-index',
      eventName: 'content.created',
      stage: 'index.write',
      entityType: 'content',
      error:
        'invalid input syntax for type vector: expected 768 dimensions, got 1024\n    at SearchIndexService.write (/app/apps/api/dist/domains/search/services/SearchIndexService.js:243:19)',
    },
  ];

  const letters: PreviewDeadLetter[] = [];

  for (const cause of causes) {
    for (let index = 0; index < cause.count; index += 1) {
      letters.push({
        id: uuid(next),
        queue: cause.queue,
        eventName: cause.eventName,
        stage: cause.stage,
        entityType: cause.entityType,
        entityId: uuid(next),
        userId: PREVIEW_USER_ID,
        payload: { name: cause.eventName, userId: PREVIEW_USER_ID, entityId: uuid(next) },
        error: cause.error,
        // Spread over three weeks: these accumulate, which is how a table with
        // no reader reached 94 rows and zero replays.
        failedAt: new Date(now - Math.floor(next() * 21 * 24 * HOUR)).toISOString(),
        replayedAt: null,
      });
    }
  }

  return letters;
}

/** One aggregated `ci.job_metrics` bucket, as `GET /jobs/history` reports it. */
export interface PreviewMetricBucket {
  readonly pending: number;
  readonly active: number;
  readonly retry: number;
  readonly deadLettered: number;
  readonly completed: number;
  readonly failed: number;
  readonly avgDurationMs: number | null;
  readonly p95DurationMs: number | null;
}

/**
 * Depth gauges only exist from here on.
 *
 * `backfill_job_metrics.sql` seeds history from what pg-boss still holds, and a
 * gauge leaves no trace once its rows drain — so every backfilled bucket has
 * zero depth and real throughput. Reproduced rather than smoothed over: on the
 * 7-day and 30-day windows the backlog chart genuinely IS flat before this
 * line, and an operator needs to be able to tell that apart from "the backlog
 * was empty".
 */
const BACKFILL_HORIZON_HOURS = 36;

/**
 * The metrics a bucket would have aggregated to.
 *
 * Computed per bucket rather than by materializing 5-minute samples: a 30-day
 * window over 20 queues is 172,800 rows to answer 240 points with.
 *
 * The shape is one appliance-week: a bulk import two days ago that settled
 * ~420k jobs over eight hours, a 12,710-job image-description backlog enqueued
 * six hours ago and barely moving at ~33.5s a job, a small standing backlog
 * either side of it, and the dead-letter count underneath it all.
 */
export function metricsForBucket(options: {
  readonly now: number;
  readonly bucketStartMs: number;
  readonly bucketMinutes: number;
  readonly queue?: string | undefined;
}): PreviewMetricBucket {
  const { now, bucketStartMs, bucketMinutes, queue } = options;
  const next = rng(Math.floor(bucketStartMs / 60_000));

  const HOUR = 3_600_000;
  const ageHours = (now - bucketStartMs) / HOUR;
  const bucketsPerHour = 60 / bucketMinutes;
  const profile = queue ? QUEUES.find((entry) => entry.queue === queue) : undefined;

  // Share of the appliance this queue accounts for, so filtering the chart to
  // one queue scales it down instead of redrawing the same curve.
  const share = profile
    ? Math.max(profile.pending + profile.completed + profile.archived, 1) /
      QUEUES.reduce((sum, entry) => sum + entry.pending + entry.completed + entry.archived, 1)
    : 1;

  // ── Backlog (gauges) ────────────────────────────────────────────────────
  // An import six hours ago put ~15.5k jobs in the queues, on top of the small
  // standing backlog the appliance always carries. It has barely moved since:
  // 12,710 image descriptions at ~33.5s each is a day of work, and a backlog
  // chart that drained it in an afternoon would be the lie the duration chart
  // exists to correct.
  const backlogNow = profile ? profile.pending : QUEUES.reduce((sum, entry) => sum + entry.pending, 0);
  const IMPORT_AT_HOURS = 6;
  const steady = backlogNow * 0.04;
  const depth =
    ageHours > IMPORT_AT_HOURS
      ? steady * (0.7 + next() * 0.6)
      : backlogNow * (1 + (0.22 * ageHours) / IMPORT_AT_HOURS);

  const backfilled = ageHours > BACKFILL_HORIZON_HOURS;
  const pending = backfilled ? 0 : Math.round(depth);
  const active = backfilled ? 0 : Math.round((profile?.active ?? 18) * (0.6 + next()));
  const retry = backfilled ? 0 : Math.round((profile?.retry ?? 21) * (0.5 + next()));
  const deadLettered = backfilled ? 0 : Math.round(DEAD_LETTER_COUNT * share);

  // ── Throughput (deltas) ─────────────────────────────────────────────────
  // A baseline the appliance always does, plus the import burst.
  const baseline = 220 * share;
  const importBurst =
    ageHours > 44 && ageHours < 52
      ? // ~420k jobs settled over the eight hours of the bulk import, which is
        // ~157k in a three-hour bucket. Deliberately six figures: the
        // throughput axis used to clip at five and drew 100000 as 00000, and a
        // fixture that never crossed the line could not have caught it.
        (420_000 / 8) * share
      : 0;
  // Nightly crons put a smaller bump on every night.
  const hourOfDay = new Date(bucketStartMs).getUTCHours();
  const nightly = hourOfDay >= 2 && hourOfDay <= 5 ? 900 * share : 0;

  const perHour = baseline + importBurst + nightly;
  const completed = Math.max(Math.round((perHour / bucketsPerHour) * (0.85 + next() * 0.3)), 0);
  const failed = Math.round(completed * (profile?.failure ? 0.14 : 0.02) * (0.6 + next() * 0.8));

  // ── Duration ────────────────────────────────────────────────────────────
  const avg = profile
    ? around(next, profile.avgMs, profile.spreadMs / 2)
    : // Unfiltered: the mean across queues, which the slow queues dominate.
      around(next, 4_200, 900);

  return {
    pending,
    active,
    retry,
    deadLettered,
    completed,
    failed,
    avgDurationMs: avg,
    // p95 is not a scaled mean — it is where the tail actually sits, which on
    // image-description is the whole point of the chart.
    p95DurationMs: Math.round(avg * (2.4 + next() * 0.8)),
  };
}

/** Queues that reported metrics in the window, for the chart's queue filter. */
export function metricQueues(): readonly string[] {
  return [...QUEUES.map((profile) => profile.queue), DEAD_LETTER_QUEUE].sort();
}

/**
 * The live import pinned above Queue Activity.
 *
 * Thirteen runs, because that is what a Google Takeout batch actually looks
 * like on this appliance — and because the phone cap on this card
 * (`JobsImportActivity`) exists specifically to stop a thirteen-run card from
 * pushing Jobs off-screen. A one-run fixture would render a card that never
 * needs the cap.
 *
 * `waiting` and `blocked` are both `status: 'queued'` in the database and mean
 * completely different things, so both appear here: one stage is behind another
 * parse for the single slot, another has not been reached yet.
 */
export function buildActiveImport({ now }: BuildOptions): ActiveImportSnapshot {
  const next = rng(0x2b4d6f80);
  const startedAt = new Date(now - 41 * 60_000);

  const units = [
    'Mail',
    'Drive',
    'Photos',
    'Chrome',
    'YouTube',
    'Calendar',
    'Contacts',
    'Keep',
    'Maps',
    'Fit',
    'Location History',
    'Voice',
    'Tasks',
  ];

  const runs = units.map((unit, index) => {
    // Six done, two running, the rest still queued.
    const done = index < 6;
    const running = index === 6 || index === 7;
    const status = done ? 'completed' : running ? 'running' : 'queued';
    const records = done ? 4_000 + Math.floor(next() * 90_000) : running ? Math.floor(next() * 21_000) : 0;
    const percent = done ? 100 : running ? 20 + Math.floor(next() * 55) : 0;
    const runStartedAt = done || running ? new Date(startedAt.getTime() + index * 90_000) : null;

    const stages = ['parse', 'push', 'media'].map((kind, seq) => {
      const stageDone = done || (running && seq === 0);
      const stageRunning = running && seq === 1;
      // `waiting` is behind the slot; `blocked` has not been reached yet.
      const queueState: 'running' | 'waiting' | 'blocked' | 'done' = stageDone
        ? 'done'
        : stageRunning
          ? 'running'
          : running
            ? 'waiting'
            : 'blocked';
      const total = stageDone || stageRunning ? 1_000 + Math.floor(next() * 60_000) : null;

      return {
        id: uuid(next),
        seq,
        kind,
        status: stageDone ? 'completed' : stageRunning ? 'running' : 'queued',
        phase: stageRunning ? 'writing rows' : null,
        processed: stageDone ? (total ?? 0) : stageRunning ? Math.floor((total ?? 0) * 0.4) : 0,
        total,
        weight: 1,
        itemsPerSec: stageRunning ? 900 + Math.floor(next() * 400) : null,
        etaSeconds: stageRunning ? 40 + Math.floor(next() * 200) : null,
        durationMs: stageDone ? 60_000 + Math.floor(next() * 400_000) : null,
        error: null,
        detail: {},
        startedAt:
          stageDone || stageRunning ? new Date(startedAt.getTime() + seq * 30_000).toISOString() : null,
        finishedAt: stageDone ? new Date(startedAt.getTime() + (seq + 1) * 30_000).toISOString() : null,
        queueState,
        queuePosition: queueState === 'waiting' ? 1 + (index % 3) : null,
        waitingSince: queueState === 'waiting' ? new Date(now - 6 * 60_000).toISOString() : null,
        elapsedMs: queueState === 'blocked' ? null : 30_000 + Math.floor(next() * 900_000),
      };
    });

    return {
      id: uuid(next),
      label: `Takeout — ${unit}`,
      source: 'google-takeout',
      dataSources: ['google-takeout'],
      declaredSources: ['google'],
      status,
      percent,
      requestedStages: ['parse', 'push', 'media'],
      error: null,
      createdAt: startedAt.toISOString(),
      startedAt: runStartedAt ? runStartedAt.toISOString() : null,
      finishedAt: done ? new Date(startedAt.getTime() + (index + 1) * 120_000).toISOString() : null,
      unit,
      records,
      elapsedMs: runStartedAt ? now - runStartedAt.getTime() : null,
      stages,
    };
  });

  const completed = runs.filter((run) => run.status === 'completed').length;
  const running = runs.filter((run) => run.status === 'running').length;
  const queued = runs.filter((run) => run.status === 'queued').length;
  const records = runs.reduce((sum, run) => sum + run.records, 0);

  return {
    generatedAt: new Date(now).toISOString(),
    active: true,
    batch: {
      total: runs.length,
      running,
      queued,
      completed,
      failed: 0,
      cancelled: 0,
      percent: Math.round((completed / runs.length) * 100),
      records,
      startedAt: startedAt.toISOString(),
      elapsedMs: now - startedAt.getTime(),
    },
    queue: {
      // One slot per stage kind, except media, which takes two.
      concurrency: { parse: 1, push: 1, media: 2 },
      slots: 4,
      running,
      waiting: runs.filter((run) => run.stages.some((stage) => stage.queueState === 'waiting')).length,
      blocked: runs.filter((run) => run.stages.every((stage) => stage.queueState === 'blocked')).length,
      longestWaitMs: 6 * 60_000,
    },
    runs,
    truncated: false,
  };
}
