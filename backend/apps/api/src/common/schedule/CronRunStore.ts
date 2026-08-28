import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

/** One durable `ci.cron_runs` row: when the schedule last fired, and last finished. */
export interface CronRunRecord {
  /** Last attempt — stamped before the body, so a throwing tick still counts. */
  readonly lastRunAt: Date;
  /** Last tick whose body returned without throwing. Null until one does. */
  readonly lastSuccessAt: Date | null;
}

/**
 * Process-wide hook the `@Cron` decorator uses to persist last-fire times
 * without Nest DI in the decorator itself.
 *
 * {@link configure} is called once from EventsModule when the app DataSource is
 * ready. Until then `record` is a no-op so unit tests stay quiet.
 */
class CronRunStoreImpl {
  private dataSource: DataSource | null = null;

  private readonly logger = new Logger('CronRunStore');

  configure(dataSource: DataSource): void {
    this.dataSource = dataSource;
  }

  /**
   * Fire-and-forget upsert. A persist failure must not take down the tick —
   * the schedule is more important than the dashboard cell.
   */
  record(name: string, at: Date = new Date()): void {
    this.upsert(
      name,
      `
        INSERT INTO ci.cron_runs (name, last_run_at)
        VALUES ($1, $2)
        ON CONFLICT (name) DO UPDATE
          SET last_run_at = EXCLUDED.last_run_at
      `,
      at,
      'last_run_at',
    );
  }

  /**
   * Stamped only once the body has returned. Kept separate from {@link record}
   * because that one fires before the body: without this column a schedule
   * whose body throws every tick still reports a fresh "last run".
   *
   * Inserts `last_run_at` too, because `record`'s upsert is fire-and-forget and
   * may not have landed yet; the attempt row overwrites it with the earlier,
   * correct time when it does.
   */
  recordSuccess(name: string, at: Date = new Date()): void {
    this.upsert(
      name,
      `
        INSERT INTO ci.cron_runs (name, last_run_at, last_success_at)
        VALUES ($1, $2, $2)
        ON CONFLICT (name) DO UPDATE
          SET last_success_at = EXCLUDED.last_success_at
      `,
      at,
      'last_success_at',
    );
  }

  async runsByName(): Promise<Map<string, CronRunRecord>> {
    const dataSource = this.dataSource;
    if (!dataSource) {
      return new Map();
    }

    try {
      const rows = await dataSource.query<
        { name: string; last_run_at: Date | string; last_success_at?: Date | string | null }[]
      >(`SELECT name, last_run_at, last_success_at FROM ci.cron_runs`);

      return mapCronRows(rows);
    } catch (err: unknown) {
      // A Hub DB that has not yet applied `cron_runs_last_success` must not
      // 500 the Jobs dashboard. last_run_at still exists; success is unknown.
      if (isUndefinedColumn(err, 'last_success_at')) {
        this.logger.warn(
          'ci.cron_runs.last_success_at is missing — serving last_run_at only until that migration is applied',
        );
        try {
          const rows = await dataSource.query<
            { name: string; last_run_at: Date | string }[]
          >(`SELECT name, last_run_at FROM ci.cron_runs`);

          return mapCronRows(rows);
        } catch (fallbackErr: unknown) {
          this.logger.warn(
            'Failed to read ci.cron_runs',
            fallbackErr instanceof Error ? fallbackErr.stack : String(fallbackErr),
          );

          return new Map();
        }
      }

      this.logger.warn(
        'Failed to read ci.cron_runs',
        err instanceof Error ? err.stack : String(err),
      );

      return new Map();
    }
  }

  private upsert(name: string, sql: string, at: Date, column: string): void {
    const dataSource = this.dataSource;
    if (!dataSource || !name) {
      return;
    }

    void dataSource.query(sql, [name, at]).catch((err: unknown) => {
      this.logger.warn(
        `Failed to persist ${column} for ${name}`,
        err instanceof Error ? err.stack : String(err),
      );
    });
  }
}

function mapCronRows(
  rows: { name: string; last_run_at: Date | string; last_success_at?: Date | string | null }[],
): Map<string, CronRunRecord> {
  const map = new Map<string, CronRunRecord>();
  for (const row of rows) {
    map.set(row.name, {
      lastRunAt: toDate(row.last_run_at),
      lastSuccessAt: row.last_success_at == null ? null : toDate(row.last_success_at),
    });
  }

  return map;
}

function isUndefinedColumn(err: unknown, column: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes(column) || !message.includes('does not exist')) {
    return false;
  }

  const code =
    (err as { driverError?: { code?: string }; code?: string }).driverError?.code ??
    (err as { code?: string }).code;

  return code === '42703' || code == null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export const CronRunStore = new CronRunStoreImpl();
