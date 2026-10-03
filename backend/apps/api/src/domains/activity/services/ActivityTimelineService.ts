import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { EntityResolutionService } from '@ci/domains/entity-resolution';
import {
  ContentService,
  eventsForMatchingMedia,
  mergeIdentifiers,
  searchReachesEvents,
} from '@ci/domains/memory';
import { SearchService, TagService, type IndexableEntity } from '@ci/domains/search-next';
import { UserService } from '@ci/domains/user';

import { ActivityRollupService, type ActivityDailyCount } from './ActivityRollupService';
import {
  type ActivityTimelineFilters,
  graphEntityTypesForTypes,
  resolveBrowseIndexableTypes,
  rollupSourcesForTypes,
} from './activityTimelineTypes';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SEARCH_BUCKET_LIMIT = 5000;

function mergeDailyCounts(parts: ActivityDailyCount[][]): ActivityDailyCount[] {
  const totals = new Map<string, number>();

  for (const part of parts) {
    for (const { date, count } of part) {
      totals.set(date, (totals.get(date) ?? 0) + count);
    }
  }

  return [...totals.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

@Injectable()
export class ActivityTimelineService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityRollupService: ActivityRollupService,
    private readonly entityResolutionService: EntityResolutionService,
    private readonly searchService: SearchService,
    private readonly contentService: ContentService,
    private readonly tagService: TagService,
    private readonly userService: UserService,
  ) {}

  async getDailyCounts(
    context: UserServiceContext,
    start: string,
    end: string,
    filters: ActivityTimelineFilters = {},
  ): Promise<ActivityDailyCount[]> {
    if (!DAY_PATTERN.test(start) || !DAY_PATTERN.test(end)) {
      throw new BadRequestException('start and end must be yyyy-MM-dd dates');
    }

    if (start > end) {
      throw new BadRequestException('start must not be after end');
    }

    const query = filters.query?.trim();
    const tags = filters.tags?.filter(Boolean);

    if (query || (tags != null && tags.length > 0)) {
      return this.getDailyCountsFromSearchCandidates(context, start, end, {
        ...filters,
        query: query || undefined,
        tags,
      });
    }

    const includedTypes = resolveBrowseIndexableTypes(filters.includeTypes, filters.excludeTypes);
    const user = await this.userService.findById(context, context.userId);
    const timezone = user?.timezone ?? 'UTC';

    const eventScoped =
      (filters.eventTypes != null && filters.eventTypes.length > 0) ||
      (filters.people != null && filters.people.length > 0) ||
      (filters.places != null && filters.places.length > 0);

    // Who / where / how are event-only dimensions — mirror the search path,
    // which drops every other entity type while one of these is active.
    if (eventScoped) {
      return this.getFilteredEventDailyCounts(context, start, end, timezone, filters);
    }

    // A source (the How filter) is not event-only: the search applies it to
    // every kind with a source_system column and sets the rest aside
    // (SearchResolver SOURCED_TYPES), so the heatmap counts the same rows —
    // straight from each table, since the rollup cannot split by source.
    const connectors = filters.connectors?.filter(Boolean) ?? [];

    if (connectors.length > 0) {
      return this.getSourceScopedDailyCounts(
        context,
        start,
        end,
        timezone,
        includedTypes,
        connectors,
        filters,
      );
    }

    const hasEventTypeFilter = filters.eventTypes != null && filters.eventTypes.length > 0;

    const parts: ActivityDailyCount[][] = [];

    const rollupSources = rollupSourcesForTypes(includedTypes).filter(
      (source) => !(source === 'events' && hasEventTypeFilter),
    );

    if (rollupSources.length > 0) {
      parts.push(
        await this.activityRollupService.getDailyCounts(context, {
          start,
          end,
          sources: rollupSources,
        }),
      );
    }

    if (includedTypes.includes('event') && hasEventTypeFilter) {
      parts.push(await this.getFilteredEventDailyCounts(context, start, end, timezone, filters));
    }

    if (includedTypes.includes('browser-activity')) {
      parts.push(await this.getBrowserDailyCounts(context, start, end, timezone));
    }

    if (includedTypes.includes('item')) {
      parts.push(await this.getItemDailyCounts(context, start, end, timezone));
    }

    const graphEntityTypes = graphEntityTypesForTypes(includedTypes);

    if (graphEntityTypes.length > 0) {
      parts.push(await this.getGraphEntityDailyCounts(context, start, end, timezone, graphEntityTypes));
    }

    return mergeDailyCounts(parts);
  }

  private async getDailyCountsFromSearchCandidates(
    context: UserServiceContext,
    start: string,
    end: string,
    filters: ActivityTimelineFilters,
  ): Promise<ActivityDailyCount[]> {
    const user = await this.userService.findById(context, context.userId);
    const timezone = user?.timezone ?? 'UTC';

    let identifiers: Array<{ type: IndexableEntity; id: string }>;

    const query = filters.query?.trim();

    if (query) {
      const searchOptions =
        filters.includeTypes != null && filters.includeTypes.length > 0
          ? { query, maxResults: SEARCH_BUCKET_LIMIT, includeTypes: filters.includeTypes }
          : filters.excludeTypes != null && filters.excludeTypes.length > 0
            ? { query, maxResults: SEARCH_BUCKET_LIMIT, excludeTypes: filters.excludeTypes }
            : { query, maxResults: SEARCH_BUCKET_LIMIT };

      identifiers = await this.searchService.search(context, searchOptions);

      // Same reach the explorer's list has: an event found through its photo's
      // words counts on the day of the event, not the day the file was imported.
      if (searchReachesEvents(filters.includeTypes, filters.excludeTypes)) {
        identifiers = mergeIdentifiers(
          identifiers,
          await eventsForMatchingMedia(
            { searchService: this.searchService, contentService: this.contentService },
            context,
            { query, maxResults: SEARCH_BUCKET_LIMIT },
          ),
        );
      }
    } else {
      const tagged = await this.tagService.getEntitiesForTags(context, filters.tags ?? []);
      const included = new Set(resolveBrowseIndexableTypes(filters.includeTypes, filters.excludeTypes));

      identifiers = tagged
        .filter((identifier) => included.has(identifier.type as IndexableEntity))
        .map(({ type, id }) => ({ type: type as IndexableEntity, id }));
    }

    if (identifiers.length === 0) {
      return [];
    }

    const resolved = await this.entityResolutionService.resolve(context, identifiers);
    const dayCounts = new Map<string, number>();

    for (const identifier of identifiers) {
      const entry = resolved.get(`${identifier.type}:${identifier.id}`);

      if (!entry) {
        continue;
      }

      const timestamp = this.readEntityTimestamp(entry.entity as Record<string, unknown>);

      if (!timestamp) {
        continue;
      }

      const dayKey = this.toLocalDayKey(timestamp, timezone);

      if (dayKey < start || dayKey > end) {
        continue;
      }

      dayCounts.set(dayKey, (dayCounts.get(dayKey) ?? 0) + 1);
    }

    return [...dayCounts.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Per-day counts under the How filter: one direct query per included kind
   * that records a source, each on the column the explorer dates that kind by
   * (see SearchResolver.getEntityTimestamp), summed per day.
   */
  private async getSourceScopedDailyCounts(
    context: UserServiceContext,
    start: string,
    end: string,
    timezone: string,
    includedTypes: IndexableEntity[],
    sourceSystems: string[],
    filters: ActivityTimelineFilters,
  ): Promise<ActivityDailyCount[]> {
    const parts: ActivityDailyCount[][] = [];

    if (includedTypes.includes('event')) {
      // Handles the source clause itself, alongside the event-only dimensions.
      parts.push(await this.getFilteredEventDailyCounts(context, start, end, timezone, filters));
    }

    const sourced: Array<[IndexableEntity, { table: string; timeColumn: string; extraWhere?: string }]> = [
      ['browser-activity', { table: 'ci.browser_activity', timeColumn: 'time' }],
      ['communication', { table: 'ci.communications', timeColumn: 'time' }],
      // Event-linked content is a facet of its event, which is counted above.
      ['content', { table: 'ci.content', timeColumn: 'updated_at', extraWhere: 'event_id IS NULL' }],
      [
        'item',
        { table: 'ci.objects', timeColumn: 'updated_at', extraWhere: 'merged_into_object_id IS NULL' },
      ],
      ['receipt', { table: 'ci.receipts', timeColumn: 'COALESCE(purchased_at, updated_at)' }],
      [
        'product',
        {
          table: 'ci.product_models',
          timeColumn: 'updated_at',
          extraWhere: 'merged_into_product_id IS NULL',
        },
      ],
    ];

    for (const [type, spec] of sourced) {
      if (includedTypes.includes(type)) {
        parts.push(
          await this.dailyCountsByTimestampColumn(context, start, end, timezone, {
            ...spec,
            userColumn: 'user_id',
            sourceSystems,
          }),
        );
      }
    }

    return mergeDailyCounts(parts);
  }

  private async getBrowserDailyCounts(
    context: UserServiceContext,
    start: string,
    end: string,
    timezone: string,
  ): Promise<ActivityDailyCount[]> {
    return this.dailyCountsByTimestampColumn(context, start, end, timezone, {
      table: 'ci.browser_activity',
      userColumn: 'user_id',
      timeColumn: 'time',
    });
  }

  private async getItemDailyCounts(
    context: UserServiceContext,
    start: string,
    end: string,
    timezone: string,
  ): Promise<ActivityDailyCount[]> {
    return this.dailyCountsByTimestampColumn(context, start, end, timezone, {
      table: 'ci.objects',
      userColumn: 'user_id',
      // The row's last write, matching ItemService.getEntitiesForItems so the
      // heatmap counts a thing on the day the list shows it.
      timeColumn: 'updated_at',
    });
  }

  private async getGraphEntityDailyCounts(
    context: UserServiceContext,
    start: string,
    end: string,
    timezone: string,
    entityTypes: string[],
  ): Promise<ActivityDailyCount[]> {
    const rows = await this.dataSource.query<Array<{ date: string; count: number }>>(
      `SELECT to_char(updated_at AT TIME ZONE $4, 'YYYY-MM-DD') AS date,
              COUNT(*)::int AS count
       FROM ci.entities
       WHERE owner_user_id = $1
         AND is_active IS DISTINCT FROM FALSE
         AND entity_type = ANY($5)
         AND updated_at >= ($2::date::timestamp AT TIME ZONE $4)
         AND updated_at < (($3::date + 1)::timestamp AT TIME ZONE $4)
       GROUP BY 1
       ORDER BY 1`,
      [context.userId, start, end, timezone, entityTypes],
    );

    return rows.map((row) => ({ date: row.date, count: row.count }));
  }

  /**
   * Per-day counts of the events the explorer lists under these filters (the
   * What / Who / Where / How dimensions, which only events carry).
   *
   * A day's number is the number of rows the list files under it, so an event
   * counts when the list shows it: only a tombstoned one (`is_deleted`) is out.
   * That is the test `CalendarEventService.applyEventFilters` applies for the
   * list, its `totalCount` and the map pins, and the one
   * `CalendarEventService.aggregateHourlyActivity` applies to the rollup the
   * unfiltered heatmap reads. This query alone lacked it, so a deleted event
   * counted on its day only while a filter was on.
   *
   * A cancelled, no-show, skipped or predicted event still counts, because the
   * list still shows it. `EVENT_HAPPENED_SQL` answers a different question
   * (where the user was) and would have this rail count fewer events than the
   * list it sits beside. If those events should leave the heatmap, they leave
   * the list and the rollup with it, as one change.
   * `ActivityTimelineService.eventLiveness.integration.spec.ts` runs this query
   * against the list's own reader.
   */
  private async getFilteredEventDailyCounts(
    context: UserServiceContext,
    start: string,
    end: string,
    timezone: string,
    filters: ActivityTimelineFilters,
  ): Promise<ActivityDailyCount[]> {
    const params: unknown[] = [context.userId, start, end, timezone];
    let paramIndex = 5;
    const clauses: string[] = [
      'event.user_id = $1',
      'event.is_deleted = false',
      `event.start_time >= ($2::date::timestamp AT TIME ZONE $4)`,
      `event.start_time < (($3::date + 1)::timestamp AT TIME ZONE $4)`,
    ];

    if (filters.eventTypes?.length) {
      clauses.push(`event.event_type = ANY($${paramIndex})`);
      params.push(filters.eventTypes);
      paramIndex += 1;
    }

    if (filters.connectors?.length) {
      clauses.push(`event.source_system = ANY($${paramIndex})`);
      params.push(filters.connectors);
      paramIndex += 1;
    }

    if (filters.people?.length) {
      clauses.push(`(
        event.participant_entity_ids && ARRAY(
          SELECT entity_id FROM ci.entities
          WHERE owner_user_id = $1 AND entity_type = 'Person' AND name ILIKE ANY($${paramIndex})
        )::uuid[]
        OR event.organizer_entity_id IN (
          SELECT entity_id FROM ci.entities
          WHERE owner_user_id = $1 AND entity_type = 'Person' AND name ILIKE ANY($${paramIndex})
        )
      )`);
      params.push(filters.people.map((name) => `%${name}%`));
      paramIndex += 1;
    }

    if (filters.places?.length) {
      clauses.push(`(
        event.location_entity_id IN (
          SELECT entity_id FROM ci.entities
          WHERE owner_user_id = $1 AND entity_type = 'Location' AND name ILIKE ANY($${paramIndex})
        )
        OR event.location_name ILIKE ANY($${paramIndex})
      )`);
      params.push(filters.places.map((name) => `%${name}%`));
      paramIndex += 1;
    }

    const rows = await this.dataSource.query<Array<{ date: string; count: number }>>(
      `SELECT to_char(event.start_time AT TIME ZONE $4, 'YYYY-MM-DD') AS date,
              COUNT(*)::int AS count
       FROM ci.events event
       WHERE ${clauses.join(' AND ')}
       GROUP BY 1
       ORDER BY 1`,
      params,
    );

    return rows.map((row) => ({ date: row.date, count: row.count }));
  }

  private async dailyCountsByTimestampColumn(
    context: UserServiceContext,
    start: string,
    end: string,
    timezone: string,
    spec: {
      table: string;
      userColumn: string;
      timeColumn: string;
      /** Keep rows whose `source_system` is one of these (the How filter). */
      sourceSystems?: string[];
      /** Extra SQL predicate, already scoped to the table's own columns. */
      extraWhere?: string;
    },
  ): Promise<ActivityDailyCount[]> {
    const params: unknown[] = [context.userId, start, end, timezone];
    const clauses: string[] = [];

    if (spec.sourceSystems && spec.sourceSystems.length > 0) {
      params.push(spec.sourceSystems);
      clauses.push(`AND source_system = ANY($${params.length})`);
    }

    if (spec.extraWhere) {
      clauses.push(`AND ${spec.extraWhere}`);
    }

    const rows = await this.dataSource.query<Array<{ date: string; count: number }>>(
      `SELECT to_char(${spec.timeColumn} AT TIME ZONE $4, 'YYYY-MM-DD') AS date,
              COUNT(*)::int AS count
       FROM ${spec.table}
       WHERE ${spec.userColumn} = $1
         AND ${spec.timeColumn} >= ($2::date::timestamp AT TIME ZONE $4)
         AND ${spec.timeColumn} < (($3::date + 1)::timestamp AT TIME ZONE $4)
         ${clauses.join('\n         ')}
       GROUP BY 1
       ORDER BY 1`,
      params,
    );

    return rows.map((row) => ({ date: row.date, count: row.count }));
  }

  private readEntityTimestamp(entity: Record<string, unknown>): Date | null {
    // Same column priority as SearchResolver.getEntityTimestamp, so a day on
    // the heatmap holds the rows the list files under that day.
    const value =
      entity.time ??
      entity.startTime ??
      entity.purchasedAt ??
      entity.answeredAt ??
      entity.updatedAt ??
      entity.createdAt ??
      null;

    if (value instanceof Date) {
      return value;
    }

    if (typeof value === 'string') {
      const date = new Date(value);

      return Number.isNaN(date.getTime()) ? null : date;
    }

    return null;
  }

  private toLocalDayKey(date: Date, timezone: string): string {
    return date.toLocaleDateString('en-CA', { timeZone: timezone });
  }
}
