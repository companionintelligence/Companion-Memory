import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository, type FindOptionsOrder } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, UserServiceContext, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  bulkInsertIdempotent,
  INGEST_REFRESH_COLUMNS,
  keysetPaginate,
  type KeysetPageArgs,
  type KeysetPage,
} from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { BrowserActivity, BrowserActivityEntity } from '../entities/BrowserActivityEntity';
import {
  BrowserActivityCreatedEvent,
  BrowserActivityUpdatedEvent,
  BrowserActivityRemovedEvent,
} from '../events';
import type { CreateBrowserActivityDto, UpdateBrowserActivityDto } from '../types';

interface Options {
  limit?: number;
  order?: FindOptionsOrder<BrowserActivityEntity>;
  startTime?: Date;
  endTime?: Date;
  /** Composite keyset cursor for the timed search path (see EventService). */
  afterTime?: Date;
  afterId?: string;
}

@Injectable()
export class BrowserActivityService {
  constructor(
    @InjectRepository(BrowserActivityEntity)
    private readonly browserActivityRepository: Repository<BrowserActivityEntity>,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
    private readonly dataSource: DataSource,
  ) {
    this.logger.setContext(BrowserActivityService.name);
  }

  async create(
    context: UserServiceContext,
    data: CreateBrowserActivityDto | CreateBrowserActivityDto[],
  ): Promise<BrowserActivity | BrowserActivity[]> {
    // Required for TypeScript type narrowing to work within the closure.
    const userId = context.userId;

    const isSingle = !Array.isArray(data);
    const dataArray: CreateBrowserActivityDto[] = isSingle ? [data] : data;

    const returned = await Promise.all(
      dataArray.map(async (item) => {
        const id = item.id ?? uuidv7();

        const browserActivity = await this.browserActivityRepository.create({
          id,
          time: new Date(item.time),
          user_id: userId,
          device_id: item.device_id ?? null,
          url: item.url,
          title: item.title,
          action_type: item.action_type,
          properties: item.properties ?? {},
          duration_seconds: item.duration_seconds,
          scroll_depth_percent: item.scroll_depth_percent,
          page_summary: item.page_summary,
          category: item.category,
          productivity_score: item.productivity_score,
          is_incognito: item.is_incognito ?? false,
          contains_sensitive: item.contains_sensitive ?? false,
          source_type: item.source_type ?? null,
          source_system: item.source_system ?? null,
          source_id: item.source_id ?? null,
        });

        const result = await this.browserActivityRepository.save(browserActivity);

        await this.eventService.send(BrowserActivityCreatedEvent, {
          browserActivityId: result.id,
        });

        return BrowserActivityEntity.toEgressType(result);
      }),
    );

    return isSingle ? returned[0] : returned;
  }

  /**
   * Batch, idempotent browser-activity ingest for the importer. Dedupes on the
   * provenance triple (source_type, source_system, source_id), scoped to the user,
   * via one set-based INSERT ... ON CONFLICT DO NOTHING instead of a per-row
   * findOne + save loop. Re-syncing the same triple returns the existing row
   * instead of inserting a duplicate. Paired with the
   * browser_activity_source_triple_uniq partial unique index, which also absorbs a
   * lost insert race. Bulk ingest does NOT emit a per-row BrowserActivityCreatedEvent
   * — search indexing is deferred to the post-load batch embed
   * (POST /api/maintenance/search-index/backfill); single-row create() still emits.
   */
  async createMany(
    context: UserServiceContext,
    data: CreateBrowserActivityDto[],
  ): Promise<BrowserActivity[]> {
    if (data.length === 0) {
      return [];
    }

    const entities = data.map((item) =>
      this.browserActivityRepository.create({
        id: item.id ?? uuidv7(),
        time: new Date(item.time),
        user_id: context.userId,
        device_id: item.device_id ?? null,
        url: item.url,
        title: item.title,
        action_type: item.action_type,
        properties: item.properties ?? {},
        duration_seconds: item.duration_seconds,
        scroll_depth_percent: item.scroll_depth_percent,
        page_summary: item.page_summary,
        category: item.category,
        productivity_score: item.productivity_score,
        is_incognito: item.is_incognito ?? false,
        contains_sensitive: item.contains_sensitive ?? false,
        source_type: item.source_type ?? null,
        source_system: item.source_system ?? null,
        source_id: item.source_id ?? null,
      }),
    );

    const results = await bulkInsertIdempotent({
      repository: this.browserActivityRepository,
      entities,
      primaryKey: 'id',
      getTriple: (entity) => ({
        sourceType: entity.source_type,
        sourceSystem: entity.source_system,
        sourceId: entity.source_id,
      }),
      scope: { user_id: context.userId },
      conflictTarget: '(user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL',
      tripleColumns: ['source_type', 'source_system', 'source_id'],
      // Centralized refresh contract — currently empty, so conflicts stay
      // DO NOTHING find-or-return.
      conflictUpdateColumns: INGEST_REFRESH_COLUMNS.browser_activity,
    });

    // Bulk ingest does NOT emit a per-row BrowserActivityCreatedEvent: the per-row
    // pgboss fan-out was the dominant cost at import volume. Search indexing for
    // bulk-loaded rows is deferred to the post-load batch embed
    // (POST /api/maintenance/search-index/backfill). Single-row create() still emits.
    return results.map(({ entity }) => BrowserActivityEntity.toEgressType(entity));
  }

  async findAll(context: ServiceContext): Promise<BrowserActivity[]> {
    const results = await this.browserActivityRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user_id: context.userId,
        }),
      },
      order: {
        time: 'DESC',
      },
      relations: ['user'],
    });

    return results.map((entity) => BrowserActivityEntity.toEgressType(entity));
  }

  /**
   * Keyset-paginated page for the GraphQL connection — ordered by (time, id)
   * DESC over the (user_id, time) index. Reads one page (+1 sentinel) instead of
   * the whole 330k-row table, and drops the eager `user` join the in-memory path
   * carried (only user_id is needed downstream).
   */
  async findPage(context: UserServiceContext, args: KeysetPageArgs): Promise<KeysetPage<BrowserActivity>> {
    const page = await keysetPaginate(this.browserActivityRepository, args, {
      alias: 'browserActivity',
      timeProp: 'time',
      userIdProp: 'user_id',
      userId: context.userId,
    });

    return {
      ...page,
      entities: page.entities.map((entity) => BrowserActivityEntity.toEgressType(entity)),
    };
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(BrowserActivity | null)[]> {
    const results = await this.browserActivityRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          user_id: context.userId,
        }),
      },
      order: { time: 'DESC' },
      relations: ['user'],
    });

    const map = new Map(results.map((entity) => [entity.id, BrowserActivityEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findById(context: ServiceContext, id: string): Promise<BrowserActivity | null> {
    return this.browserActivityRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user_id: context.userId,
        }),
      },
      relations: ['user'],
    });
  }

  async update(
    context: ServiceContext,
    id: string,
    data: UpdateBrowserActivityDto,
  ): Promise<BrowserActivity | null> {
    const { time: timeString, ...restData } = data;
    const updateData: Record<string, unknown> = { ...restData };

    if (timeString !== undefined) {
      updateData.time = new Date(timeString);
    }

    const browserActivity = await this.browserActivityRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user_id: context.userId,
        }),
      },
    });

    if (!browserActivity) {
      return null;
    }

    await this.browserActivityRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user_id: context.userId,
        }),
      },
      updateData,
    );

    await this.eventService.send(BrowserActivityUpdatedEvent, {
      browserActivityId: browserActivity.id,
    });

    return this.findById(context, browserActivity.id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const browserActivity = await this.browserActivityRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user_id: context.userId,
        }),
      },
    });

    if (!browserActivity) {
      return false;
    }

    await this.browserActivityRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        user_id: context.userId,
      }),
    });

    await this.eventService.send(BrowserActivityRemovedEvent, {
      browserActivityId: id,
    });

    return true;
  }

  async getEntitiesForBrowserActivities(
    context: ServiceContext,
    options: Options,
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.dataSource
      .getRepository(BrowserActivityEntity)
      .createQueryBuilder('browser-activity')
      .select(['browser-activity.id'])
      .where('browser-activity.user_id = :userId', { userId: context.userId });

    if (options.limit) {
      query = query.limit(options.limit);
    }

    if (options.order) {
      for (const [field, direction] of Object.entries(options.order)) {
        query = query.orderBy(`browser-activity.${field}`, direction as 'ASC' | 'DESC');
      }

      // Deterministic tiebreak so same-timestamp rows page consistently.
      query = query.addOrderBy('browser-activity.id', 'DESC');
    }

    // Composite keyset: page strictly past (afterTime, afterId) in (time DESC, id DESC).
    if (options.afterTime && options.afterId) {
      query = query.andWhere(
        '(browser-activity.time < :afterTime OR (browser-activity.time = :afterTime AND browser-activity.id < :afterId))',
        { afterTime: options.afterTime, afterId: options.afterId },
      );
    }

    if (options.startTime) {
      query = query.andWhere('browser-activity.time >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('browser-activity.time <= :endTime', { endTime: options.endTime });
    }

    const results = await query.getRawMany();

    return results.map((row: { 'browser-activity_id': string; type: IndexableEntity }) => ({
      id: row['browser-activity_id'],
      type: 'browser-activity' as IndexableEntity,
    }));
  }
}
