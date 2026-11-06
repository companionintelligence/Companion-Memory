import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository, type SelectQueryBuilder } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import {
  type KeysetByPage,
  type KeysetPageArgs,
  type SeekKey,
  keysetPaginateBy,
} from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';

import { ThreadEntity, type Thread } from '../entities/ThreadEntity';
import { ThreadCreatedEvent, ThreadUpdatedEvent, ThreadRemovedEvent } from '../events';
import type { CreateThreadDto, UpdateThreadDto } from '../types';

import { MessageService } from './MessageService';

/**
 * The threads list's order — what {@link ThreadService.findAll} sorts by and
 * {@link ThreadService.findPage} seeks on: most recently updated first (the
 * column is nullable in the table, and NULLs lead a descending sort), the id
 * breaking ties so the order is total.
 */
const THREAD_LIST_ORDER: readonly SeekKey[] = [
  { expr: 'thread.updated_at', order: 'DESC', nullable: true, read: 'CAST(thread.updated_at AS text)' },
  { expr: 'thread.thread_id', order: 'DESC' },
];

@Injectable()
export class ThreadService {
  constructor(
    @InjectRepository(ThreadEntity)
    private readonly threadRepository: Repository<ThreadEntity>,
    private readonly messageService: MessageService,
    private readonly eventService: EventService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(context: UserServiceContext, data: CreateThreadDto): Promise<Thread> {
    const id = data.id ?? uuid7();

    const instance = this.threadRepository.create({
      ...data,
      id,
      user: {
        id: context.userId,
      },
    });

    const entity = await this.threadRepository.save(instance);

    await this.eventService.send(ThreadCreatedEvent, {
      threadId: entity.id,
    });

    return ThreadEntity.toEgressType(entity);
  }

  /**
   * Every live thread of the caller, most recently updated first
   * ({@link THREAD_LIST_ORDER}); {@link findPage} reads the same list a page
   * at a time. The owner is not joined: `GET /api/threads` (every chat-page
   * open) and the GraphQL `threads` query both read the list, and neither
   * reads the owner off a thread — `Thread.user` is optional on the egress
   * type for exactly that.
   */
  async findAll(context: ServiceContext): Promise<Thread[]> {
    let qb = this.listScope(this.threadRepository.createQueryBuilder('thread'), context);

    THREAD_LIST_ORDER.forEach((key, i) => {
      qb = i === 0 ? qb.orderBy(key.expr, key.order) : qb.addOrderBy(key.expr, key.order);
    });

    const entities = await qb.getMany();

    return entities.map((entity) => ThreadEntity.toEgressType(entity));
  }

  /**
   * One page of {@link findAll}'s list — the caller's live threads, most
   * recently updated first — read with a `LIMIT` and a seek past the cursor
   * row instead of every thread. The cursor is the row id; one that matches no
   * row yields an empty page. The `COUNT(*)` behind `totalCount` runs only when
   * `countTotal` is set. The owner is not joined: the GraphQL type never reads
   * it (the REST list, which does, stays on {@link findAll}).
   */
  async findPage(
    context: ServiceContext,
    args: KeysetPageArgs,
    options: { countTotal?: boolean } = {},
  ): Promise<KeysetByPage<Thread>> {
    const page = await keysetPaginateBy(this.threadRepository, args, {
      alias: 'thread',
      keys: THREAD_LIST_ORDER,
      idExpr: 'thread.thread_id',
      countTotal: options.countTotal,
      scope: (qb) => this.listScope(qb, context),
    });

    return { ...page, entities: page.entities.map((entity) => ThreadEntity.toEgressType(entity)) };
  }

  /** The rows {@link findAll} and {@link findPage} list: unarchived threads of the caller, or of everyone for the system user. */
  private listScope(
    qb: SelectQueryBuilder<ThreadEntity>,
    context: ServiceContext,
  ): SelectQueryBuilder<ThreadEntity> {
    qb = qb.where('thread.is_archived = false');

    if (context.userId === SYSTEM_USER) {
      return qb;
    }

    return qb.andWhere('thread.user_id = :userId', { userId: context.userId });
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Thread | null)[]> {
    const entities = await this.threadRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        isArchived: false,
      },
      relations: { user: true },
    });

    const map = new Map(entities.map((entity) => [entity.id, ThreadEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findById(context: ServiceContext, id: string): Promise<Thread | null> {
    const result = await this.threadRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        isArchived: false,
      },
      relations: { user: true },
    });

    if (result == null) {
      return null;
    }

    return ThreadEntity.toEgressType(result);
  }

  /**
   * How many threads, for any user, currently have a chat turn queued or
   * running — the signal background GPU work yields to.
   *
   * `generation_status` is written `queued` at enqueue and `running`/`idle`
   * by the turn itself, so it is the app's own statement that someone is
   * waiting on the model. Bounded by `freshWithinMs` on `updated_at` because
   * the status is not always cleaned up: a process that dies mid-turn leaves
   * `running` behind until pg-boss retries the job (which rewrites it) or
   * gives up (which never does). Without the bound, one such row would hold
   * every yielding queue off the GPU for good.
   */
  countPendingGenerations(freshWithinMs: number): Promise<number> {
    return this.threadRepository.count({
      where: {
        generationStatus: In(['queued', 'running']),
        updatedAt: MoreThan(new Date(Date.now() - freshWithinMs)),
      },
    });
  }

  exists(context: ServiceContext, id: string): Promise<boolean> {
    return this.threadRepository.exists({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        isArchived: false,
      },
    });
  }

  async update(context: ServiceContext, id: string, data: UpdateThreadDto): Promise<Thread | null> {
    const result = await this.threadRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        isArchived: false,
      },
      data,
    );

    if (result.affected === 0) {
      return null;
    }

    await this.eventService.send(ThreadUpdatedEvent, {
      threadId: id,
    });

    return this.findById(context, id);
  }

  /**
   * Give a thread a title, and ONLY if it still has none. Returns whether it wrote.
   *
   * One conditional UPDATE, not a read followed by a write: a stand-in title (the person's first words, written when
   * the model could not name the thread) must never replace a real one, and a title job takes seconds — a later turn's
   * job, or a rename, can land inside that gap. Here the row decides, atomically.
   */
  async nameIfUnnamed(context: ServiceContext, id: string, name: string): Promise<boolean> {
    const query = this.threadRepository
      .createQueryBuilder()
      .update(ThreadEntity)
      .set({ name })
      .where('thread_id = :id', { id })
      .andWhere('is_archived = false')
      .andWhere("(title IS NULL OR btrim(title) = '')");

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('user_id = :userId', { userId: context.userId });
    }

    const result = await query.execute();

    if (!result.affected) {
      return false;
    }

    await this.eventService.send(ThreadUpdatedEvent, {
      threadId: id,
    });

    return true;
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const result = await this.threadRepository.delete({
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

    this.eventEmitter.emit(ThreadRemovedEvent, { threadId: id });

    await this.eventService.send(ThreadRemovedEvent, {
      threadId: id,
    });

    return true;
  }

  async softRemove(context: ServiceContext, id: string): Promise<boolean> {
    // Update is_archived instead of using TypeORM's softDelete
    const result = await this.threadRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      {
        isArchived: true,
      },
    );

    if (result.affected === 0) {
      return false;
    }

    this.eventEmitter.emit(ThreadRemovedEvent, { threadId: id });

    await this.eventService.send(ThreadRemovedEvent, {
      threadId: id,
    });

    // We should not be doing this here, this is a MessageService concern.
    // Consider this an anti-pattern, hence why the thread deleted event is
    // emitted before this happens. We can circle back to fix this.
    const messages = await this.messageService.findByThreadId(context, id);

    await Promise.all(messages.map((message) => this.messageService.softRemove(context, message.id)));

    return true;
  }
}
