import { CliError, type CliContext } from '../context';
import { json, stamp, table } from '../output';
import type {
   CronScheduleSummary,
  DeadLetterSummary,
  DeltaChangeType,
  EntityDeltaSummary,
  JobQueueSummary,
  PipelineStageSummary,
} from '../wire';

export interface AuditDeltasOptions {
  changeType?: string;
  from?: string;
  to?: string;
  limit?: string;
  json?: boolean;
}

export interface AuditPipelineOptions {
  json?: boolean;
}

export interface AuditDeadLettersOptions {
  queue?: string;
  stage?: string;
  limit?: string;
  json?: boolean;
}

export interface AuditJobsOptions {
  json?: boolean;
}

const VALID_CHANGE_TYPES = new Set<DeltaChangeType>([
  'created',
  'updated',
  'archived',
  'deleted',
  'merged',
]);

/**
 * Inspect the chronological field-level evolution ledger (`GET /audit/deltas`) for an entity.
 */
export async function auditDeltasCommand(
  ctx: CliContext,
  entityId: string,
  options: AuditDeltasOptions = {},
): Promise<void> {
  const trimmedId = entityId.trim();

  if (!trimmedId) {
    throw new CliError('entityId is required.');
  }

  let changeType: DeltaChangeType | undefined;

  if (options.changeType !== undefined) {
    const raw = options.changeType.trim() as DeltaChangeType;

    if (!VALID_CHANGE_TYPES.has(raw)) {
      throw new CliError('--change-type must be created, updated, archived, deleted, or merged.');
    }

    changeType = raw;
  }

  const limit = parseOptionalPositiveInt(options.limit, '--limit');
  const response = await ctx.client.getAuditDeltas({
    entityId: trimmedId,
    ...(changeType ? { changeType } : {}),
    ...(options.from ? { from: options.from } : {}),
    ...(options.to ? { to: options.to } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });

  if (options.json) {
    json(ctx.term, response);

    return;
  }

  ctx.term.out(`entity  ${response.entityId} (${response.count} delta${response.count === 1 ? '' : 's'})`);
  ctx.term.out(
    table<EntityDeltaSummary>(
      response.deltas,
      [
        { header: 'WHEN', value: (d) => stamp(d.occurredAt) },
        { header: 'CHANGE', value: (d) => d.changeType },
        { header: 'TYPE', value: (d) => d.entityType },
        { header: 'SOURCE', value: (d) => d.sourceType },
        {
          header: 'CONF',
          align: 'right',
          value: (d) => (d.confidence != null ? `${(d.confidence * 100).toFixed(0)}%` : '-'),
        },
        {
          header: 'CHANGED FIELDS',
          value: (d) => Object.keys(d.changedFields ?? {}).join(', ') || '-',
        },
      ],
      '(no audit deltas recorded for this entity)',
    ),
  );
}

/**
 * Inspect the 37-stage `ci.pipeline_state` coverage and quarantine ledger (`GET /pipeline/state`).
 */
export async function auditPipelineCommand(
  ctx: CliContext,
  options: AuditPipelineOptions = {},
): Promise<void> {
  const state = await ctx.client.getPipelineState();

  if (options.json) {
    json(ctx.term, state);

    return;
  }

  const s = state.summary;

  ctx.term.out(
    `items   total=${s.totalItems}  fully_processed=${s.fullyProcessed}  ` +
      `with_failures=${s.withFailures}  quarantined=${s.quarantined}`,
  );
  ctx.term.out('');
  ctx.term.out(
    table<PipelineStageSummary>(
      state.stages,
      [
        { header: 'STAGE', value: (r) => r.stage },
        { header: 'COVERAGE', align: 'right', value: (r) => `${(r.coverage * 100).toFixed(1)}%` },
        { header: 'DONE', align: 'right', value: (r) => String(r.done) },
        { header: 'PENDING', align: 'right', value: (r) => String(r.pending) },
        { header: 'FAILED', align: 'right', value: (r) => String(r.failed) },
        { header: 'QUARANTINED', align: 'right', value: (r) => String(r.quarantined) },
        { header: 'STALE', align: 'right', value: (r) => String(r.stale) },
        { header: 'AVG ATTEMPTS', align: 'right', value: (r) => r.avgAttempts.toFixed(1) },
      ],
      '(no pipeline stages recorded)',
    ),
  );
}

/**
 * Inspect dead-lettered pipeline jobs (`GET /pipeline/dead-letters`).
 */
export async function auditDeadLettersCommand(
  ctx: CliContext,
  options: AuditDeadLettersOptions = {},
): Promise<void> {
  const limit = parseOptionalPositiveInt(options.limit, '--limit');
  const response = await ctx.client.getDeadLetters({
    ...(options.queue ? { queue: options.queue } : {}),
    ...(options.stage ? { stage: options.stage } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });

  if (options.json) {
    json(ctx.term, response);

    return;
  }

  ctx.term.out(`dead letters  ${response.count}`);
  ctx.term.out(
    table<DeadLetterSummary>(
      response.items,
      [
        { header: 'WHEN', value: (d) => stamp(d.createdAt) },
        { header: 'QUEUE', value: (d) => d.queueName },
        { header: 'STAGE', value: (d) => d.stage ?? '-' },
        { header: 'ENTITY', value: (d) => d.entityId ?? '-' },
        { header: 'ATTEMPTS', align: 'right', value: (d) => String(d.attempts) },
        { header: 'REPLAYED', value: (d) => (d.replayedAt ? stamp(d.replayedAt) : '-') },
        { header: 'ERROR', value: (d) => d.errorMessage.slice(0, 60) },
      ],
      '(no dead-lettered jobs)',
    ),
  );
}

/**
 * Inspect PgBoss job queues and registered cron schedules (`GET /jobs/dashboard`).
 */
export async function auditJobsCommand(ctx: CliContext, options: AuditJobsOptions = {}): Promise<void> {
  const dashboard = await ctx.client.getJobsDashboard();

  if (options.json) {
    json(ctx.term, dashboard);

    return;
  }

  ctx.term.out(
    `engine  enabled=${dashboard.engine.enabled}  started=${dashboard.engine.started}  ` +
      `queues=${dashboard.summary.totalQueues}  active=${dashboard.summary.activeJobs}  ` +
      `queued=${dashboard.summary.queuedJobs}  failed=${dashboard.summary.failedJobs}  ` +
      `crons=${dashboard.summary.registeredCrons}`,
  );
  ctx.term.out('');
  ctx.term.out(
    table<JobQueueSummary>(
      dashboard.queues,
      [
        { header: 'QUEUE', value: (q) => q.name },
        { header: 'DOMAIN', value: (q) => q.domain },
        { header: 'ACTIVE', align: 'right', value: (q) => String(q.counts.active) },
        { header: 'QUEUED', align: 'right', value: (q) => String(q.counts.created) },
        { header: 'RETRY', align: 'right', value: (q) => String(q.counts.retry) },
        { header: 'FAILED', align: 'right', value: (q) => String(q.counts.failed) },
        { header: 'COMPLETED', align: 'right', value: (q) => String(q.counts.completed) },
      ],
      '(no queues registered)',
    ),
  );

  if (dashboard.crons.length > 0) {
    ctx.term.out('');
    ctx.term.out(
      table<CronScheduleSummary>(dashboard.crons, [
        { header: 'CRON NAME', value: (c) => c.name },
        { header: 'SCHEDULE', value: (c) => c.cron },
        { header: 'DOMAIN', value: (c) => c.domain },
        { header: 'ENABLED', value: (c) => (c.enabled ? 'yes' : 'no') },
      ]),
    );
  }
}

function parseOptionalPositiveInt(raw: string | undefined, flagName: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const parsed = /^\s*\d+\s*$/.test(raw) ? Number(raw) : Number.NaN;

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError(`${flagName} must be a positive integer.`);
  }

  return parsed;
}
