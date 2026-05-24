import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, UserServiceContext, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';

import { type Summary, SummaryEntity } from '../entities/SummaryEntity';
import { SummaryCreatedEvent, SummaryUpdatedEvent, SummaryDeletedEvent } from '../events';
import type { CreateSummaryDto, UpdateSummaryDto } from '../types';

@Injectable()
export class SummaryService {
  constructor(
    @InjectRepository(SummaryEntity)
    private readonly summaryRepository: Repository<SummaryEntity>,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SummaryService.name);
  }

  async create(context: UserServiceContext, data: CreateSummaryDto): Promise<Summary | null> {
    const record = this.summaryRepository.create({
      summaryId: data.summaryId || uuidv7(),
      ...data,
      userId: context.userId,
    });

    const entity = await this.summaryRepository.save(record);

    await this.eventService.send(SummaryCreatedEvent, {
      summaryId: entity.summaryId,
    });

    return SummaryEntity.toEgressType(entity);
  }

  async findById(context: ServiceContext, id: string): Promise<Summary | null> {
    const entity = await this.summaryRepository.findOne({
      where: {
        summaryId: id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    return entity ? SummaryEntity.toEgressType(entity) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Summary | null)[]> {
    const results = await this.summaryRepository.find({
      where: {
        summaryId: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    const map = new Map(results.map((entity) => [entity.summaryId, SummaryEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findAll(context: ServiceContext): Promise<Summary[]> {
    const query = this.summaryRepository.createQueryBuilder('summary');

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('summary.userId = :userId', { userId: context.userId });
    }

    query.andWhere(
      `summary.content->>'summary_text' IS DISTINCT FROM 'No activity recorded during this window.'`,
    );
    query.andWhere(`summary.content->'activity_counts'->>'total' IS DISTINCT FROM '0'`);

    query.orderBy('summary.periodEnd', 'DESC');

    const results = await query.getMany();

    return results.map((entity) => SummaryEntity.toEgressType(entity));
  }

  async findRecent(context: ServiceContext, limit: number = 10): Promise<Summary[]> {
    const query = this.summaryRepository.createQueryBuilder('summary');

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('summary.userId = :userId', { userId: context.userId });
    }

    query.andWhere(
      `summary.content->>'summary_text' IS DISTINCT FROM 'No activity recorded during this window.'`,
    );
    query.andWhere(`summary.content->'activity_counts'->>'total' IS DISTINCT FROM '0'`);

    query.orderBy('summary.periodEnd', 'DESC');
    query.take(limit);

    const results = await query.getMany();

    return results.map((entity) => SummaryEntity.toEgressType(entity));
  }

  async update(context: ServiceContext, id: string, data: UpdateSummaryDto): Promise<Summary | null> {
    const record = await this.summaryRepository.findOne({
      where: {
        summaryId: id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    if (record == null) {
      return null;
    }

    Object.assign(record, data);

    const updatedEntity = await this.summaryRepository.save(record);

    await this.eventService.send(SummaryUpdatedEvent, {
      summaryId: updatedEntity.summaryId,
    });

    return SummaryEntity.toEgressType(updatedEntity);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const result = await this.summaryRepository.delete({
      summaryId: id,
      ...(context.userId !== SYSTEM_USER && {
        userId: context.userId,
      }),
    });

    if (result.affected != null && result.affected > 0) {
      await this.eventService.send(SummaryDeletedEvent, {
        summaryId: id,
      });

      return true;
    }

    return false;
  }
}
