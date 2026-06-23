import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository, type FindOptionsOrder, type FindOptionsWhere } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { isUniqueViolation } from '@ci/common/constants';
import { SYSTEM_USER, UserServiceContext, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
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
   * Batch, idempotent browser-activity ingest for the importer. Each row dedupes
   * on the provenance triple (user_id, source_type, source_system, source_id) —
   * the same find-or-return pattern as EventService.create — so a re-sync returns
   * the existing row instead of inserting a duplicate. Paired with the
   * browser_activity_source_triple_uniq partial unique index, which also catches a
   * lost insert race (23505).
   */
  async createMany(
    context: UserServiceContext,
    data: CreateBrowserActivityDto[],
  ): Promise<BrowserActivity[]> {
    return Promise.all(
      data.map(async (item) => {
        // Idempotency: when the triple is present, return the existing row.
        const sourceWhere: FindOptionsWhere<BrowserActivityEntity> | null =
          item.source_type && item.source_id
            ? {
                user_id: context.userId,
                source_type: item.source_type,
                source_system: item.source_system ?? IsNull(),
                source_id: item.source_id,
              }
            : null;

        if (sourceWhere) {
          const existing = await this.browserActivityRepository.findOne({ where: sourceWhere });
          if (existing) {
            return BrowserActivityEntity.toEgressType(existing);
          }
        }

        try {
          // A single (non-array) input yields a single BrowserActivity.
          return (await this.create(context, item)) as BrowserActivity;
        } catch (err) {
          // Lost a race to a concurrent insert of the same triple — fetch the winner.
          if (sourceWhere && isUniqueViolation(err)) {
            const existing = await this.browserActivityRepository.findOne({ where: sourceWhere });
            if (existing) {
              return BrowserActivityEntity.toEgressType(existing);
            }
          }

          throw err;
        }
      }),
    );
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
