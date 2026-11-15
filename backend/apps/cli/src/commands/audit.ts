import { CliError, type CliContext } from '../context';
import { json, stamp, table } from '../output';
import {
  MAX_AUDIT_DELTAS,
  MAX_DEAD_LETTER_PAGE,
  type CronScheduleSummary,
  type DeltaChangeType,
  type EntityDeltaSummary,
  type JobQueueSummary,
  type PipelineDeadLetter,
  type StageCoverage,
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

const VALID_CHANGE_TYPES = new Set<DeltaChangeType>(['created', 'updated', 'archived', 'deleted', 'merged']);

/**
 * Inspect the field-level change ledger for one entity (`GET /audit/deltas`).
 *
 * `--from` / `--to` are sent as `since` / `until`, the names the route reads.
 * Its query schema drops keys it does not know, so a window under any other
 * name came back unfiltered and looked like an answer.
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

  const since = parseOptionalInstant(options.from, '--from');
  const until = parseOptionalInstant(options.to, '--to');
  const limit = parseOptionalPositiveInt(options.limit, '--limit', MAX_AUDIT_DELTAS);
  const response = await ctx.client.getAuditDeltas({
    entityId: trimmedId,
    ...(changeType ? { changeType } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });

  if (options.json) {
    json(ctx.term, response);

    return;
  }

  const { deltas, stats } = response.data;

  ctx.term.out(
    `entity  ${response.data.entityId} (${stats.total} delta${stats.total === 1 ? '' : 's'}, newest first)`,
  );
  ctx.term.out(
    table<EntityDeltaSummary>(
      deltas,
      [
        { header: 'WHEN', value: (d) => stamp(d.changedAt) },
        { header: 'CHANGE', value: (d) => d.changeType },
        {
          header: 'TYPE',
          value: (d) => (d.nodeType === 'relationship' ? d.relationshipType : d.entityType) ?? d.nodeType,
        },
        { header: 'SOURCE', value: (d) => d.changeSource ?? '-' },
        {
          header: 'CHANGED FIELDS',
          value: (d) => d.fieldChanges.map((change) => change.field).join(', ') || '-',
        },
      ],
      '(no audit deltas recorded for this entity)',
    ),
  );
}

/**
 * Per-stage coverage of the `ci.pipeline_state` ledger (`GET /pipeline/state`).
 *
 * `total` counts LEDGER ROWS, not source rows: a stage that has never run
 * shows 0 rows and 0%, which is not the same as "0% of your data".
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

  const { stages } = state;

  const sum = (key: 'failed' | 'quarantined' | 'stale') => stages.reduce((total, s) => total + s[key], 0);

  ctx.term.out(
    `stages  ${stages.length}  failed=${sum('failed')}  quarantined=${sum('quarantined')}  stale=${sum('stale')}`,
  );
  ctx.term.out('');
  ctx.term.out(
    table<StageCoverage>(
      stages,
      [
        { header: 'STAGE', value: (s) => s.stage },
        { header: 'VERSION', align: 'right', value: (s) => String(s.stageVersion) },
        { header: 'COVERAGE', align: 'right', value: (s) => `${(s.coverage * 100).toFixed(1)}%` },
        { header: 'ROWS', align: 'right', value: (s) => String(s.total) },
        { header: 'DONE', align: 'right', value: (s) => String(s.done) },
        { header: 'SKIPPED', align: 'right', value: (s) => String(s.skipped) },
        { header: 'PENDING', align: 'right', value: (s) => String(s.pending) },
        { header: 'RUNNING', align: 'right', value: (s) => String(s.running) },
        { header: 'FAILED', align: 'right', value: (s) => String(s.failed) },
        { header: 'QUARANTINED', align: 'right', value: (s) => String(s.quarantined) },
        { header: 'STALE', align: 'right', value: (s) => String(s.stale) },
      ],
      '(no pipeline stages recorded)',
    ),
  );
}

/**
 * One page of dead-lettered pipeline jobs, newest first
 * (`GET /pipeline/dead-letters`). The route returns a page, not a count.
 */
export async function auditDeadLettersCommand(
  ctx: CliContext,
  options: AuditDeadLettersOptions = {},
): Promise<void> {
  const limit = parseOptionalPositiveInt(options.limit, '--limit', MAX_DEAD_LETTER_PAGE);
  const page = await ctx.client.getDeadLetters({
    ...(options.queue ? { queue: options.queue } : {}),
    ...(options.stage ? { stage: options.stage } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });

  if (options.json) {
    json(ctx.term, page);

    return;
  }

  const { deadLetters } = page;

  ctx.term.out(`dead letters  ${deadLetters.length} shown, newest first`);
  ctx.term.out(
    table<PipelineDeadLetter>(
      deadLetters,
      [
        { header: 'FAILED', value: (d) => stamp(d.failedAt) },
        { header: 'QUEUE', value: (d) => d.queue },
        { header: 'EVENT', value: (d) => d.eventName },
        { header: 'STAGE', value: (d) => d.stage ?? '-' },
        { header: 'ENTITY', value: (d) => d.entityId ?? '-' },
        { header: 'REPLAYED', value: (d) => (d.replayedAt ? stamp(d.replayedAt) : '-') },
        { header: 'ERROR', value: (d) => firstLine(d.error).slice(0, 60) },
      ],
      '(no dead-lettered jobs)',
    ),
  );
}

/**
 * pg-boss job counts, queues and the Nest `@Cron` schedules (`GET /jobs/dashboard`).
 */
export async function auditJobsCommand(ctx: CliContext, options: AuditJobsOptions = {}): Promise<void> {
  const dashboard = await ctx.client.getJobsDashboard();

  if (options.json) {
    json(ctx.term, dashboard);

    return;
  }

  const s = dashboard.summary;

  ctx.term.out(
    `jobs  pending=${s.pending}  active=${s.active}  retry=${s.retry}  failed=${s.failed}  ` +
      `dead-lettered=${s.deadLettered}  completed=${s.completed}  cancelled=${s.cancelled}`,
  );

  // Live counts come per queue NAME, for the busiest ten; every other queue has none in flight.
  const live = new Map(dashboard.queueDistribution.map((entry) => [entry.queue, entry.count]));

  ctx.term.out('');
  ctx.term.out(
    table<JobQueueSummary>(
      dashboard.queues,
      [
        { header: 'QUEUE', value: (q) => q.name },
        { header: 'LIVE', align: 'right', value: (q) => String(live.get(q.name) ?? 0) },
        { header: 'POLICY', value: (q) => q.policy ?? '-' },
        {
          header: 'RETRIES',
          align: 'right',
          value: (q) => (q.retryLimit == null ? 'default' : String(q.retryLimit)),
        },
        { header: 'DEAD LETTER', value: (q) => q.deadLetter ?? '-' },
      ],
      '(no queues registered)',
    ),
  );

  if (dashboard.crons.length > 0) {
    ctx.term.out('');
    ctx.term.out(
      table<CronScheduleSummary>(dashboard.crons, [
        { header: 'CRON', value: (c) => c.name },
        { header: 'SCHEDULE', value: (c) => c.cron },
        { header: 'ROLE', value: (c) => c.role },
        { header: 'LAST RUN', value: (c) => stamp(c.lastRunAt) || 'never' },
        { header: 'LAST SUCCESS', value: (c) => stamp(c.lastSuccessAt) || 'never' },
        { header: 'STATE', value: cronState },
      ]),
    );
  }
}

/**
 * One word for a schedule's state, in the order that matters. `running` alone
 * is not health: a schedule that throws on every tick stays started, and a
 * disabled one keeps ticking with its body gated off.
 */
function cronState(cron: CronScheduleSummary): string {
  if (cron.disabled) {
    return 'disabled';
  }

  if (cron.overdue) {
    return 'OVERDUE';
  }

  if (!cron.servedHere) {
    return `in ${cron.role}`;
  }

  return cron.running ? 'running' : 'stopped';
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n');

  return newline === -1 ? text : text.slice(0, newline);
}

/** An ISO-8601 instant, refused here rather than by the server's 400. */
function parseOptionalInstant(raw: string | undefined, flagName: string): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const value = raw.trim();

  if (!value || Number.isNaN(Date.parse(value))) {
    throw new CliError(
      `${flagName} must be an ISO-8601 date or time, e.g. 2026-11-01 or 2026-11-01T09:00:00Z.`,
    );
  }

  return value;
}

function parseOptionalPositiveInt(
  raw: string | undefined,
  flagName: string,
  max: number,
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const parsed = /^\s*\d+\s*$/.test(raw) ? Number(raw) : Number.NaN;

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError(`${flagName} must be a positive integer.`);
  }

  if (parsed > max) {
    throw new CliError(`${flagName} can be at most ${max}; the server refuses more in one page.`);
  }

  return parsed;
}
