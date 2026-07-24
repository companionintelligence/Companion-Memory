import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, UserServiceContext, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { computeChunkSize } from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { type Note, NoteEntity } from '../entities/NoteEntity';
import { NoteCreatedEvent, NoteUpdatedEvent, NoteRemovedEvent } from '../events';
import type { CreateNoteDto, UpdateNoteDto } from '../types';

/**
 * Hourly UTC per-user note count. Declared locally so this domain carries no
 * dependency on aggregating consumers; they enforce the shape structurally
 * where they consume it.
 */
export interface HourlyNoteCount {
  userId: string;
  bucketStart: Date;
  count: number;
}

@Injectable()
export class NoteService {
  constructor(
    @InjectRepository(NoteEntity)
    private readonly noteRepository: Repository<NoteEntity>,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(NoteService.name);
  }

  /**
   * @param options.emitCreated When true (default) a NoteCreatedEvent is sent so the
   *   row indexes/enriches live. The bulk path passes false: emitting a per-row
   *   pgboss event for every ingested row is the dominant cost at import volume, so
   *   bulk-loaded rows are instead swept by the post-load search-index backfill.
   */
  async create(
    context: UserServiceContext,
    data: CreateNoteDto,
    options: { emitCreated?: boolean } = {},
  ): Promise<Note | null> {
    const { emitCreated = true } = options;

    const record = this.noteRepository.create({
      id: data.id || uuidv7(),
      ...data,
      userId: context.userId,
    });

    const entity = await this.noteRepository.save(record);

    if (emitCreated) {
      await this.eventService.send(NoteCreatedEvent, {
        noteId: entity.id,
      });
    }

    return NoteEntity.toEgressType(entity);
  }

  /**
   * Batch notes ingest for the importer. Replaces the per-row save +
   * NoteCreatedEvent loop with one set-based INSERT plus one hydration SELECT.
   * Notes have no dedup key, so this is a plain multi-row INSERT — every input
   * row is inserted. Returns the created notes in input order.
   *
   * Bulk ingest does NOT emit a per-row NoteCreatedEvent: the per-row pgboss
   * fan-out was the dominant cost at import volume. Search indexing for
   * bulk-loaded rows is deferred to the post-load batch embed
   * (POST /api/maintenance/search-index/backfill). Single-row create() still
   * emits, so interactive creates index live.
   */
  async createMany(context: UserServiceContext, data: CreateNoteDto[]): Promise<Note[]> {
    if (data.length === 0) {
      return [];
    }

    const entities = data.map((item) =>
      this.noteRepository.create({
        id: item.id || uuidv7(),
        ...item,
        userId: context.userId,
      }),
    );

    // Split into param-budget-bounded chunks so a large batch never exceeds
    // Postgres' 65535 bind-param limit (computeChunkSize is the same helper
    // bulkInsertIdempotent uses). Notes have no dedup key, so every chunk is a
    // plain multi-row INSERT.
    const chunkSize = computeChunkSize(this.noteRepository.metadata.columns.length);
    for (let offset = 0; offset < entities.length; offset += chunkSize) {
      await this.noteRepository
        .createQueryBuilder()
        .insert()
        // Route through `metadata.target` so TS picks the `ObjectLiteral` overload
        // of `.values()` (matches the other bulk-ingest services).
        .into(this.noteRepository.metadata.target)
        .values(entities.slice(offset, offset + chunkSize))
        .execute();
    }

    const ids = entities.map((entity) => entity.id);
    const rows = await this.noteRepository.find({ where: { id: In(ids) } });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return entities.map((entity) => NoteEntity.toEgressType(byId.get(entity.id) ?? entity));
  }

  async findById(context: ServiceContext, id: string): Promise<Note | null> {
    const entity = await this.noteRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    return entity ? NoteEntity.toEgressType(entity) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Note | null)[]> {
    const results = await this.noteRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    const map = new Map(results.map((entity) => [entity.id, NoteEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  /**
   * Lightweight identifiers for the most-recent notes, for the unified
   * search/explorer feed. Full entities are batch-resolved downstream.
   */
  async getEntitiesForNotes(
    context: ServiceContext,
    options: { limit?: number; startTime?: Date; endTime?: Date; order?: 'ASC' | 'DESC' } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.noteRepository
      .createQueryBuilder('note')
      .select('note.id', 'id')
      .where('note.user_id = :userId', { userId: context.userId });

    if (options.startTime) {
      query = query.andWhere('note.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('note.created_at <= :endTime', { endTime: options.endTime });
    }

    query = query.orderBy('note.created_at', options.order ?? 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'note' as IndexableEntity }));
  }

  async findAll(context: ServiceContext): Promise<Note[]> {
    const results = await this.noteRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      order: {
        updatedAt: 'DESC',
      },
    });

    return results.map((entity) => NoteEntity.toEgressType(entity));
  }

  async update(context: ServiceContext, id: string, data: UpdateNoteDto): Promise<Note | null> {
    const record = await this.noteRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    if (record == null) {
      return null;
    }

    Object.assign(record, data);

    const updatedEntity = await this.noteRepository.save(record);

    await this.eventService.send(NoteUpdatedEvent, {
      noteId: updatedEntity.id,
    });

    return NoteEntity.toEgressType(updatedEntity);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const result = await this.noteRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        userId: context.userId,
      }),
    });

    if (result.affected != null && result.affected > 0) {
      await this.eventService.send(NoteRemovedEvent, {
        noteId: id,
      });

      return true;
    }

    return false;
  }

  /**
   * Hourly UTC activity buckets for the activity rollup: notes counted by
   * creation time, per user.
   */
  async aggregateHourlyActivity(): Promise<HourlyNoteCount[]> {
    const rows: Array<{ user_id: string; bucket_start: Date; count: number }> = await this.noteRepository
      .createQueryBuilder('note')
      .select('note.userId', 'user_id')
      .addSelect(`date_trunc('hour', note.createdAt, 'UTC')`, 'bucket_start')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy('user_id')
      .addGroupBy('bucket_start')
      .getRawMany();

    return rows.map((row) => ({ userId: row.user_id, bucketStart: row.bucket_start, count: row.count }));
  }
}
