import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { MessageService } from '@ci/domains/conversations';
import { FileService } from '@ci/domains/files';
import { AnswerService } from '@ci/domains/intelligence';
import { CommunicationService, ContentService, EventService, GraphUtilityService } from '@ci/domains/memory';
import { NoteService } from '@ci/domains/notes';
import { UserService } from '@ci/domains/user';

/**
 * The bucket shape this aggregator requires from every source domain. Source
 * domains deliberately do NOT import this: each declares its own hourly-count
 * type, and assignability is enforced structurally where the provider list
 * below consumes the domain services. Keeps the dependency direction strictly
 * activity → domains.
 */
export interface ActivityBucketRow {
  userId: string;
  /** Start of the hourly bucket, truncated in UTC (`date_trunc('hour', col, 'UTC')`). */
  bucketStart: Date;
  count: number;
}

/**
 * A domain-owned activity source. Each source domain aggregates its own table
 * into hourly UTC buckets; the activity domain never queries another domain's
 * tables directly.
 */
interface ActivitySourceProvider {
  /** Stable key stored in ci.activity_rollup.source and accepted as a query filter. */
  source: string;
  aggregate: () => Promise<ActivityBucketRow[]>;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ActivityDailyCount {
  /** Local calendar day, `yyyy-MM-dd`, in the requested timezone. */
  date: string;
  count: number;
}

export interface ActivityDailyCountsParams {
  /** Inclusive first local day, `yyyy-MM-dd`. */
  start: string;
  /** Inclusive last local day, `yyyy-MM-dd`. */
  end: string;
  /** Restrict to these sources; all sources when omitted. */
  sources?: string[];
}

/**
 * Maintains and serves ci.activity_rollup: per-user activity counts in hourly
 * UTC buckets, one row per (user, source, hour) with activity. Bucket rows are
 * aggregated by each owning domain's service (see aggregateHourlyActivity
 * implementations); this service only writes and reads its own table. The
 * refresh is a full recompute per source, so it self-heals deletes and
 * historical imports with old event times; reads are eventually consistent
 * (the cron runs every 15 minutes) but stay a cheap indexed lookup regardless
 * of how large the source tables grow.
 */
@Injectable()
export class ActivityRollupService {
  private readonly providers: readonly ActivitySourceProvider[];

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    communicationService: CommunicationService,
    eventService: EventService,
    messageService: MessageService,
    noteService: NoteService,
    contentService: ContentService,
    fileService: FileService,
    answerService: AnswerService,
    graphUtilityService: GraphUtilityService,
    private readonly userService: UserService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ActivityRollupService.name);

    this.providers = [
      { source: 'communications', aggregate: () => communicationService.aggregateHourlyActivity() },
      { source: 'events', aggregate: () => eventService.aggregateHourlyActivity() },
      { source: 'messages', aggregate: () => messageService.aggregateHourlyActivity() },
      { source: 'notes', aggregate: () => noteService.aggregateHourlyActivity() },
      { source: 'content', aggregate: () => contentService.aggregateHourlyActivity() },
      { source: 'files', aggregate: () => fileService.aggregateHourlyActivity() },
      { source: 'answers', aggregate: () => answerService.aggregateHourlyActivity() },
      { source: 'entities', aggregate: () => graphUtilityService.aggregateHourlyActivity() },
    ];
  }

  get knownSources(): string[] {
    return this.providers.map((provider) => provider.source);
  }

  /**
   * Recomputes the rollup for every source. Sources are isolated: one failing
   * aggregate (or a write rejected by the user FK for orphaned source rows) is
   * logged and skipped so the remaining sources still refresh.
   */
  async refreshAll(): Promise<void> {
    for (const provider of this.providers) {
      const startedAt = Date.now();

      try {
        const rows = await provider.aggregate();

        await this.writeSource(provider.source, rows);

        this.logger.log('Refreshed activity rollup source', {
          source: provider.source,
          buckets: rows.length,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        this.logger.error(
          `Failed to refresh activity rollup source ${provider.source}`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
  }

  /**
   * Replaces one source's rollup rows with the domain-provided aggregate in a
   * single transactional statement: delete buckets that vanished, upsert
   * buckets whose count changed, leave unchanged rows untouched to keep WAL
   * churn minimal. An empty aggregate prunes every row for the source.
   */
  private async writeSource(source: string, rows: ActivityBucketRow[]): Promise<void> {
    const userIds = rows.map((row) => row.userId);
    const bucketStarts = rows.map((row) => row.bucketStart);
    const counts = rows.map((row) => row.count);

    await this.dataSource.query(
      `WITH agg AS (
         SELECT user_id, bucket_start, count
         FROM unnest($2::uuid[], $3::timestamptz[], $4::int[]) AS t(user_id, bucket_start, count)
       ),
       pruned AS (
         DELETE FROM ci.activity_rollup r
         WHERE r.source = $1
           AND NOT EXISTS (
             SELECT 1 FROM agg a
             WHERE a.user_id = r.user_id AND a.bucket_start = r.bucket_start
           )
       )
       INSERT INTO ci.activity_rollup (user_id, source, bucket_start, count)
       SELECT user_id, $1, bucket_start, count FROM agg
       ON CONFLICT (user_id, source, bucket_start)
       DO UPDATE SET count = EXCLUDED.count, refreshed_at = NOW()
       WHERE activity_rollup.count IS DISTINCT FROM EXCLUDED.count`,
      [source, userIds, bucketStarts, counts],
    );
  }

  /**
   * Rolls the hourly UTC buckets into local calendar days in the user's
   * profile timezone (UserEntity.timezone, the same setting that drives HBPE
   * and summary bucketing). The range predicate converts the local-day
   * boundaries to UTC instants, so a "day" is always the user's 23/24/25-hour
   * local day.
   */
  async getDailyCounts(
    context: UserServiceContext,
    params: ActivityDailyCountsParams,
  ): Promise<ActivityDailyCount[]> {
    const { start, end } = params;

    if (!DAY_PATTERN.test(start) || !DAY_PATTERN.test(end)) {
      throw new BadRequestException('start and end must be yyyy-MM-dd dates');
    }

    if (start > end) {
      throw new BadRequestException('start must not be after end');
    }

    const user = await this.userService.findById(context, context.userId);
    const timezone = user?.timezone ?? 'UTC';

    const sources = this.normalizeSources(params.sources);

    const rows = await this.dataSource.query<Array<{ date: string; count: number }>>(
      `SELECT to_char(bucket_start AT TIME ZONE $4, 'YYYY-MM-DD') AS date,
              SUM(count)::int AS count
       FROM ci.activity_rollup
       WHERE user_id = $1
         AND bucket_start >= ($2::date::timestamp AT TIME ZONE $4)
         AND bucket_start < (($3::date + 1)::timestamp AT TIME ZONE $4)
         AND ($5::text[] IS NULL OR source = ANY($5))
       GROUP BY 1
       ORDER BY 1`,
      [context.userId, start, end, timezone, sources],
    );

    return rows.map((row) => ({ date: row.date, count: row.count }));
  }

  private normalizeSources(sources: string[] | undefined): string[] | null {
    if (!sources || sources.length === 0) {
      return null;
    }

    const known = new Set(this.knownSources);
    const unknown = sources.filter((source) => !known.has(source));

    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown activity sources: ${unknown.join(', ')}`);
    }

    return sources;
  }
}
