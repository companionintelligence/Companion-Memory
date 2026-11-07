import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type ServiceContext, type UserServiceContext, SYSTEM_USER } from '@ci/common/context';
import {
  type HourlyActivityOptions,
  type KeysetPageArgs,
  resolvePageShape,
  touchedHourlyBucketsSql,
} from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import { FileService } from '@ci/domains/files';

import { MessageEntity, type Message } from '../entities/MessageEntity';
import { MessageCreatedEvent, MessageUpdatedEvent, MessageDeletedEvent } from '../events';
import type { CreateMessageDto, UpdateMessageDto } from '../types';

/**
 * Hourly UTC per-user message count. Declared locally so this domain carries
 * no dependency on aggregating consumers; they enforce the shape structurally
 * where they consume it.
 */
export interface HourlyMessageCount {
  userId: string;
  bucketStart: Date;
  count: number;
}

/** One page of a thread's messages, oldest first. `totalCount` is `null` when it was not counted. */
export interface ThreadMessagesPage {
  messages: Message[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  totalCount: number | null;
}

@Injectable()
export class MessageService {
  constructor(
    @InjectRepository(MessageEntity)
    private readonly messageRepository: Repository<MessageEntity>,
    private readonly fileService: FileService,
    private readonly eventService: EventService,
  ) {}

  async create(context: UserServiceContext, data: CreateMessageDto): Promise<Message> {
    const { threadId, content, toolCalls, promptMessageId, fileIds, ...rest } = data;

    const id = data.id ?? uuid7();

    const instance = this.messageRepository.create({
      ...rest,
      id,
      content,
      toolCalls: toolCalls,
      user: {
        id: context.userId,
      },
      thread: {
        id: threadId,
      },
      promptMessage: {
        id: promptMessageId,
      },
    });

    const entity = await this.messageRepository.save(instance);

    // Link files to this message if provided
    if (fileIds && fileIds.length > 0) {
      const files = (await this.fileService.findByIds(context, fileIds)).filter((entity) => entity != null);

      if (files.length > 0) {
        await this.messageRepository
          .createQueryBuilder()
          .relation(MessageEntity, 'files')
          .of(entity.id)
          .add(files.map((file) => file.id));
      }
    }

    await this.eventService.send(MessageCreatedEvent, {
      messageId: entity.id,
    });

    return MessageEntity.toEgressType(entity);
  }

  async findAll(context: ServiceContext): Promise<Message[]> {
    const entities = await this.messageRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        canceled: false,
      },
      relations: { files: true },
    });

    return entities.map((entity) => MessageEntity.toEgressType(entity));
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Message | null)[]> {
    const entities = await this.messageRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        canceled: false,
      },
      relations: { files: true },
    });

    const map = new Map(entities.map((entity) => [entity.id, MessageEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findById(context: ServiceContext, id: string): Promise<Message | null> {
    const entity = await this.messageRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        canceled: false,
      },
      relations: { files: true },
    });

    if (entity == null) {
      return null;
    }

    return MessageEntity.toEgressType(entity);
  }

  exists(context: ServiceContext, id: string): Promise<boolean> {
    return this.messageRepository.exists({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        canceled: false,
      },
    });
  }

  /**
   * Yields a collection of Messages associated with a given Thread id.
   *
   * This method assumes the context user has access to the corresponding
   * Thread. This access must be ensured before safely calling this method.
   */
  async findByThreadId(context: ServiceContext, threadId: string): Promise<Message[]> {
    const entities = await this.messageRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        thread: {
          id: threadId,
        },
        canceled: false,
      },
      relations: { files: true },
      order: {
        id: 'asc',
      },
    });

    return entities.map((entity) => MessageEntity.toEgressType(entity));
  }

  /**
   * The first `limit` messages of each thread, oldest first — `message_id` is
   * a v7 UUID, so id order is time order, the same order {@link findByThreadId}
   * serves REST — with whether more follow and the thread's total, in ONE read
   * for a page of threads. `ROW_NUMBER()` and `COUNT(*)` over each thread's
   * messages rank them; the rows within the limit (+1 sentinel) are hydrated.
   *
   * What `Thread.messages` used to do was read EVERY message of every thread
   * on the page and slice in memory. Assumes the caller may see the threads,
   * like {@link findByThreadId}; a thread with no visible messages is absent
   * from the map.
   */
  async findFirstPageByThreadIds(
    context: ServiceContext,
    threadIds: string[],
    limit: number,
  ): Promise<Map<string, ThreadMessagesPage>> {
    const pages = new Map<string, ThreadMessagesPage>();

    if (threadIds.length === 0 || limit <= 0) {
      return pages;
    }

    const ranked = await this.messageRepository.manager
      .createQueryBuilder()
      .select('ranked.message_id', 'message_id')
      .addSelect('ranked.thread_id', 'thread_id')
      .addSelect('ranked.rn', 'rn')
      .addSelect('ranked.total', 'total')
      .from((qb) => {
        const inner = qb
          .select('m.message_id', 'message_id')
          .addSelect('m.thread_id', 'thread_id')
          .addSelect('ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.message_id ASC)', 'rn')
          .addSelect('COUNT(*) OVER (PARTITION BY m.thread_id)', 'total')
          .from(MessageEntity, 'm')
          .where('m.thread_id IN (:...threadIds)', { threadIds })
          .andWhere('m.is_deleted = false');

        return context.userId !== SYSTEM_USER
          ? inner.andWhere('m.user_id = :userId', { userId: context.userId })
          : inner;
      }, 'ranked')
      .where('ranked.rn <= :sentinel', { sentinel: limit + 1 })
      .orderBy('ranked.thread_id', 'ASC')
      .addOrderBy('ranked.rn', 'ASC')
      .getRawMany<{ message_id: string; thread_id: string; rn: string; total: string }>();

    if (ranked.length === 0) {
      return pages;
    }

    const entities = await this.messageRepository.find({
      where: { id: In(ranked.filter((row) => Number(row.rn) <= limit).map((row) => row.message_id)) },
    });
    const byId = new Map(entities.map((entity) => [entity.id, MessageEntity.toEgressType(entity)]));

    for (const row of ranked) {
      const page = pages.get(row.thread_id) ?? {
        messages: [],
        hasNextPage: false,
        hasPreviousPage: false,
        totalCount: Number(row.total),
      };

      if (Number(row.rn) > limit) {
        page.hasNextPage = true;
      } else {
        const message = byId.get(row.message_id);

        if (message) {
          page.messages.push(message);
        }
      }

      pages.set(row.thread_id, page);
    }

    return pages;
  }

  /**
   * One page of a thread's messages past a cursor, in the same id order as
   * {@link findFirstPageByThreadIds}: `afterId` reads forward from the cursor
   * message, `beforeId` / `last` read backward (and are returned in forward
   * order). The total is counted only when asked for.
   */
  async findPageByThread(
    context: ServiceContext,
    threadId: string,
    args: KeysetPageArgs,
    options: { countTotal?: boolean } = {},
  ): Promise<ThreadMessagesPage> {
    const { limit, isBackward } = resolvePageShape(args);
    const base = () => {
      const query = this.messageRepository
        .createQueryBuilder('m')
        .where('m.thread_id = :threadId', { threadId })
        .andWhere('m.is_deleted = false');

      return context.userId !== SYSTEM_USER
        ? query.andWhere('m.user_id = :userId', { userId: context.userId })
        : query;
    };

    const counting: Promise<number | null> =
      (options.countTotal ?? true) ? base().getCount() : Promise.resolve(null);
    counting.catch(() => undefined);

    const query = base()
      .orderBy('m.id', isBackward ? 'DESC' : 'ASC')
      .limit(limit + 1);

    if (isBackward && args.beforeId) {
      query.andWhere('m.id < :beforeId', { beforeId: args.beforeId });
    } else if (!isBackward && args.afterId) {
      query.andWhere('m.id > :afterId', { afterId: args.afterId });
    }

    const [rows, totalCount] = await Promise.all([query.getMany(), counting]);
    const hasExtra = rows.length > limit;
    const messages = (hasExtra ? rows.slice(0, limit) : rows).map((entity) =>
      MessageEntity.toEgressType(entity),
    );

    if (isBackward) {
      messages.reverse();

      return { messages, hasNextPage: args.beforeId != null, hasPreviousPage: hasExtra, totalCount };
    }

    return { messages, hasNextPage: hasExtra, hasPreviousPage: args.afterId != null, totalCount };
  }

  async update(context: ServiceContext, id: string, data: UpdateMessageDto): Promise<Message | null> {
    const result = await this.messageRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        canceled: false,
      },
      data as never,
    );

    if (result.affected === 0) {
      return null;
    }

    await this.eventService.send(MessageUpdatedEvent, {
      messageId: id,
    });

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    // Fetched before the delete: once the row is gone, nothing can say which
    // thread this message belonged to for the reindex listener.
    const existing = await this.messageRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    const result = await this.messageRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        user: {
          id: context.userId,
        },
      }),
    });

    if (result.affected === 0) {
      return false;
    }

    await this.eventService.send(MessageDeletedEvent, {
      messageId: id,
      threadId: existing?.threadId ?? null,
    });

    return true;
  }

  async softRemove(context: ServiceContext, id: string): Promise<boolean> {
    // Fetched before the cancel: findById filters canceled: false, so once
    // this flips, the reindex listener can no longer look the thread up itself.
    const existing = await this.messageRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    const result = await this.messageRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      {
        canceled: true,
      },
    );

    if (result.affected === 0) {
      return false;
    }

    await this.eventService.send(MessageDeletedEvent, {
      messageId: id,
      threadId: existing?.threadId ?? null,
    });

    return true;
  }

  /**
   * Hourly UTC activity buckets for the activity rollup: messages counted by
   * creation time, per user. Deleted/canceled messages don't count as
   * activity. MessageEntity models the user only as a relation, so the FK
   * column is referenced directly.
   */
  async aggregateHourlyActivity(options: HourlyActivityOptions = {}): Promise<HourlyMessageCount[]> {
    const live = 'message.canceled = false';
    const query = this.messageRepository
      .createQueryBuilder('message')
      .select('message.user_id', 'user_id')
      .addSelect(`date_trunc('hour', message.createdAt, 'UTC')`, 'bucket_start')
      // Incrementally, a bucket is recounted over every row it holds, cancelled
      // or not, so one whose messages were all cancelled comes back as 0 and is pruned.
      .addSelect(options.changedSince ? `COUNT(*) FILTER (WHERE ${live})::int` : 'COUNT(*)::int', 'count')
      .where('message.createdAt IS NOT NULL')
      .groupBy('user_id')
      .addGroupBy('bucket_start');

    if (options.changedSince) {
      query.andWhere(
        touchedHourlyBucketsSql(
          { user: 'message.user_id', bucket: 'message.createdAt' },
          {
            table: 'ci.messages',
            userColumn: 'user_id',
            bucketColumn: 'created_at',
            changed: 'src.updated_at',
          },
        ),
        { changedSince: options.changedSince },
      );
    } else {
      query.andWhere(live);
    }

    const rows: Array<{ user_id: string; bucket_start: Date; count: number }> = await query.getRawMany();

    return rows.map((row) => ({ userId: row.user_id, bucketStart: row.bucket_start, count: row.count }));
  }
}
