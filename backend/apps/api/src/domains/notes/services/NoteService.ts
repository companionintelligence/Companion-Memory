import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, UserServiceContext, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { type Note, NoteEntity } from '../entities/NoteEntity';
import { NoteCreatedEvent, NoteUpdatedEvent, NoteRemovedEvent } from '../events';
import type { CreateNoteDto, UpdateNoteDto } from '../types';

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

  async create(context: UserServiceContext, data: CreateNoteDto): Promise<Note | null> {
    const record = this.noteRepository.create({
      id: data.id || uuidv7(),
      ...data,
      userId: context.userId,
    });

    const entity = await this.noteRepository.save(record);

    await this.eventService.send(NoteCreatedEvent, {
      noteId: entity.id,
    });

    return NoteEntity.toEgressType(entity);
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
}
