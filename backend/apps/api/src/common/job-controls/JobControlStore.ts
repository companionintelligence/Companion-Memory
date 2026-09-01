import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import {
  GLOBAL_CONCURRENCY,
  GLOBAL_NON_INTERACTIVE,
  GLOBAL_PER_QUEUE_CONCURRENCY,
  type CronMode,
  type JobControlKind,
  type JobControlRow,
  type JobMode,
} from './types';

/**
 * How often each process re-reads `ci.job_settings`.
 *
 * The table has at most a few dozen rows and the read is one unindexed scan of
 * it, so the cost of polling is not the consideration — the consideration is how
 * long an operator waits between pressing a toggle and the box acting on it.
 * Five seconds is under the worker loop's own idle backoff, so a paused queue
 * stops fetching on its next wake either way, and it is short enough that the
 * Jobs page's next 15-second refresh already shows the settled state.
 *
 * A LISTEN/NOTIFY channel would make it instant, at the cost of a dedicated
 * connection per process held open for the life of the appliance. Not worth it
 * for a control plane whose slowest consumer is a human watching a fan.
 */
const REFRESH_INTERVAL_MS = 5_000;

/**
 * How often dropped-work counters are folded into the table.
 *
 * These are incremented on the enqueue path, which during a bulk import runs
 * once per imported row — an UPDATE per drop would turn a settings counter into
 * the most-written table on the appliance. Batched, a disabled queue costs one
 * UPDATE per flush no matter how much work it is refusing.
 */
const SKIP_FLUSH_INTERVAL_MS = 30_000;

const SELECT_SETTINGS = `
  SELECT kind, key, mode, concurrency, skipped_count, last_skipped_at, updated_at
  FROM ci.job_settings
`;

/**
 * Fold one batch of drops into a row that already exists.
 *
 * UPDATE rather than upsert on purpose: a drop can only happen because a row
 * said `disabled`, so the row is there. If an operator resets the control in the
 * same window, the update matches nothing and that batch of counts is lost —
 * which is the right outcome, because the tally belongs to the setting that
 * caused it and the setting is gone.
 */
const UPDATE_SKIPS = `
  UPDATE ci.job_settings
  SET skipped_count = skipped_count + $3,
      last_skipped_at = $4
  WHERE kind = $1 AND key = $2
`;

interface SettingsRow {
  kind: string;
  key: string;
  mode: string | null;
  concurrency: number | string | null;
  skipped_count: number | string;
  last_skipped_at: Date | string | null;
  updated_at: Date | string | null;
}

interface PendingSkip {
  kind: JobControlKind;
  key: string;
  count: number;
  lastAt: Date;
}

/**
 * The process-wide, always-synchronous view of `ci.job_settings`.
 *
 * ── Why a singleton and not a Nest provider ────────────────────────────────
 *
 * Its two most important readers cannot be injected into. The `@Cron` wrapper is
 * a decorator, evaluated at class-definition time, long before any DI container
 * exists — the same reason {@link CronRunStore} next door is shaped this way.
 * And the pg-boss enqueue path runs once per imported row, where an `await` on a
 * settings lookup would put a database round trip in front of every single send.
 *
 * So the store keeps a snapshot in memory, refreshes it on a timer, and answers
 * every question synchronously off that snapshot. The cost is a bounded
 * staleness window ({@link REFRESH_INTERVAL_MS}); the benefit is that "is this
 * queue disabled?" is a Map lookup on the hottest path in the appliance.
 *
 * ── Degradation ────────────────────────────────────────────────────────────
 *
 * Until {@link configure} is called, and on any read failure, the snapshot is
 * empty — which means every getter returns "no opinion" and the appliance
 * behaves exactly as it did before this table existed. That is the correct
 * failure direction for a control plane: a settings table that cannot be read
 * must not be able to turn the memory system off.
 */
class JobControlStoreImpl {
  private dataSource: DataSource | null = null;

  private readonly logger = new Logger('JobControlStore');

  private snapshot = new Map<string, JobControlRow>();

  /**
   * Bumped on every refresh that changed something.
   *
   * Read by the worker so it can re-apply concurrency limits when — and only
   * when — they actually moved, instead of re-assigning `p-limit.concurrency`
   * on every loop iteration (each assignment schedules a microtask).
   */
  private version = 0;

  private refreshTimer: NodeJS.Timeout | null = null;

  private flushTimer: NodeJS.Timeout | null = null;

  private readonly pendingSkips = new Map<string, PendingSkip>();

  /** Logged once, not once per poll, when the migration has not been applied. */
  private warnedMissingTable = false;

  /**
   * Bind the store to the app DataSource and start the poll.
   *
   * Returns the first refresh so a caller that needs the settings to be live
   * before it does anything (the worker, at boot) can await them. Callers that
   * do not care can ignore it — the timer keeps going either way.
   */
  configure(dataSource: DataSource | null): Promise<void> {
    this.dataSource = dataSource;

    this.stopTimers();

    if (!dataSource) {
      this.snapshot = new Map();
      this.pendingSkips.clear();
      this.version += 1;

      return Promise.resolve();
    }

    // `unref` so a poll timer can never be the thing keeping a CLI script or a
    // finished test process alive.
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();

    this.flushTimer = setInterval(() => void this.flushSkips(), SKIP_FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();

    return this.refresh();
  }

  /** Stop polling and flush whatever is pending. Used at shutdown and by tests. */
  async stop(): Promise<void> {
    this.stopTimers();
    await this.flushSkips();
  }

  private stopTimers(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Re-read the table.
   *
   * A failure leaves the previous snapshot in place rather than clearing it: a
   * transient database blip must not silently un-pause every queue an operator
   * paused. The one exception is the very first read, where there is no previous
   * snapshot and empty already means "shipped defaults".
   */
  async refresh(): Promise<void> {
    const dataSource = this.dataSource;

    if (!dataSource) {
      return;
    }

    let rows: SettingsRow[];

    try {
      rows = await dataSource.query<SettingsRow[]>(SELECT_SETTINGS);
    } catch (err: unknown) {
      this.warnOnce(err);

      return;
    }

    const next = new Map<string, JobControlRow>();

    for (const row of rows) {
      const parsed = toRow(row);

      if (parsed) {
        next.set(cacheKey(parsed.kind, parsed.key), parsed);
      }
    }

    if (!sameSnapshot(this.snapshot, next)) {
      this.version += 1;
    }

    this.snapshot = next;
  }

  /** Changes whenever the snapshot changes. Cheap staleness check for readers. */
  revision(): number {
    return this.version;
  }

  /** Every row currently known, for the settings API. */
  rows(): JobControlRow[] {
    return [...this.snapshot.values()];
  }

  row(kind: JobControlKind, key: string): JobControlRow | undefined {
    return this.snapshot.get(cacheKey(kind, key));
  }

  /** The appliance-wide in-flight ceiling, or null when the operator has no opinion. */
  globalConcurrency(): number | null {
    return this.row('global', GLOBAL_CONCURRENCY)?.concurrency ?? null;
  }

  /** The default ceiling for one queue, or null when the operator has no opinion. */
  perQueueConcurrency(): number | null {
    return this.row('global', GLOBAL_PER_QUEUE_CONCURRENCY)?.concurrency ?? null;
  }

  /** True when the operator has pulled the "stop everything a human isn't waiting on" switch. */
  nonInteractivePaused(): boolean {
    return this.row('global', GLOBAL_NON_INTERACTIVE)?.mode === 'paused';
  }

  /**
   * What this queue is allowed to do right now.
   *
   * `interactive` is supplied by the caller rather than looked up here: which
   * events count as interactive is the job taxonomy's business, and the taxonomy
   * lives in the events domain, which `common` must not reach into. The caller
   * that knows the queue's listeners knows the answer.
   *
   * The global pause can only ever make a queue's mode MORE restrictive, and
   * only for non-interactive queues — pausing everything including the chat
   * queue would be indistinguishable, from the user's chair, from the appliance
   * being down.
   */
  queueMode(queue: string, options: { readonly interactive: boolean }): JobMode {
    const own = this.row('queue', queue)?.mode ?? 'enabled';

    if (own !== 'enabled') {
      return own;
    }

    return !options.interactive && this.nonInteractivePaused() ? 'paused' : 'enabled';
  }

  /**
   * Whether this schedule may tick. Keyed by the scheduler registry name
   * (`Class.method`), which is the same string the Jobs page and `ci.cron_runs`
   * use.
   */
  cronMode(name: string): CronMode {
    return this.row('cron', name)?.mode === 'disabled' ? 'disabled' : 'enabled';
  }

  /**
   * Count work this setting threw away.
   *
   * In memory only; {@link flushSkips} folds it into the row. Never throws and
   * never awaits — it sits on the enqueue path.
   */
  recordSkip(kind: JobControlKind, key: string, count = 1): void {
    if (count <= 0) {
      return;
    }

    const id = cacheKey(kind, key);
    const pending = this.pendingSkips.get(id);

    if (pending) {
      pending.count += count;
      pending.lastAt = new Date();

      return;
    }

    this.pendingSkips.set(id, { kind, key, count, lastAt: new Date() });
  }

  /**
   * Fold the in-memory counters into the table.
   *
   * Drains first, so a failed write loses that batch rather than double-counting
   * it on the next flush. Losing a few counts in a tally that exists to say "a
   * lot of work is being dropped" is not worth the risk of inflating it.
   */
  async flushSkips(): Promise<void> {
    const dataSource = this.dataSource;

    if (!dataSource || this.pendingSkips.size === 0) {
      return;
    }

    const batch = [...this.pendingSkips.values()];
    this.pendingSkips.clear();

    for (const skip of batch) {
      try {
        await dataSource.query(UPDATE_SKIPS, [skip.kind, skip.key, skip.count, skip.lastAt]);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to record ${skip.count} skipped ${skip.kind} job(s) for ${skip.key}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  private warnOnce(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);

    if (/job_settings/.test(message) && /does not exist/.test(message)) {
      if (!this.warnedMissingTable) {
        this.warnedMissingTable = true;
        this.logger.warn(
          'ci.job_settings is missing — job controls are inert until that migration is applied. ' +
            'Every queue and schedule runs with its shipped defaults.',
        );
      }

      return;
    }

    this.logger.warn('Failed to read ci.job_settings', err instanceof Error ? err.stack : message);
  }
}

function cacheKey(kind: JobControlKind, key: string): string {
  return `${kind}:${key}`;
}

const KINDS: ReadonlySet<string> = new Set<JobControlKind>(['global', 'queue', 'cron']);
const MODES: ReadonlySet<string> = new Set<JobMode>(['enabled', 'paused', 'disabled']);

/**
 * Parse one database row, discarding anything the CHECK constraints should have
 * made impossible. A row this cannot read is a row from a newer schema than this
 * build knows about, and inventing a meaning for it is how a setting comes to
 * mean the opposite of what the operator chose.
 */
function toRow(row: SettingsRow): JobControlRow | null {
  if (!KINDS.has(row.kind) || !row.key) {
    return null;
  }

  const mode = row.mode != null && MODES.has(row.mode) ? (row.mode as JobMode) : null;
  const concurrency = toInteger(row.concurrency);

  return {
    kind: row.kind as JobControlKind,
    key: row.key,
    mode,
    concurrency: concurrency != null && concurrency >= 1 ? concurrency : null,
    skippedCount: toInteger(row.skipped_count) ?? 0,
    lastSkippedAt: toDate(row.last_skipped_at),
    updatedAt: toDate(row.updated_at),
  };
}

/** `bigint` comes back from node-postgres as a string; `integer` as a number. */
function toInteger(value: number | string | null | undefined): number | null {
  if (value == null) {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);

  return Number.isFinite(parsed) ? parsed : null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}

/**
 * Whether two snapshots would produce the same behaviour.
 *
 * Deliberately ignores `skippedCount`, `lastSkippedAt` and `updatedAt`: those
 * move every time a disabled queue refuses work, and treating that as a change
 * would bump the revision — and re-apply every concurrency limit — every five
 * seconds for the whole time a queue is off.
 */
function sameSnapshot(left: Map<string, JobControlRow>, right: Map<string, JobControlRow>): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const [key, row] of left) {
    const other = right.get(key);

    if (!other || other.mode !== row.mode || other.concurrency !== row.concurrency) {
      return false;
    }
  }

  return true;
}

export const JobControlStore = new JobControlStoreImpl();
