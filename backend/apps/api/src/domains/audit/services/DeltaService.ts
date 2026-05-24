import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { type Delta, DeltaEntity } from '../entities/DeltaEntity';
import type { CreateDeltaDto, FindDeltasOptions, UpdateDeltasSummaryDto } from '../types';

interface FindEntityEvolutionOptions {
  changeType?: DeltaEntity['changeType'];
  unsummarizedOnly?: boolean;
  since?: Date;
  until?: Date;
  limit?: number;
}

@Injectable()
export class DeltaService {
  constructor(
    @InjectRepository(DeltaEntity)
    private readonly deltaRepository: Repository<DeltaEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DeltaService.name);
  }

  async create(context: ServiceContext, data: CreateDeltaDto): Promise<Delta> {
    const record = this.deltaRepository.create({
      deltaId: data.deltaId || uuidv7(),
      ...data,
    });

    const entity = await this.deltaRepository.save(record);

    return DeltaEntity.toEgressType(entity);
  }

  async findById(context: ServiceContext, id: string): Promise<Delta | null> {
    const entity = await this.deltaRepository.findOne({
      where: {
        deltaId: id,
        ...(context.userId !== SYSTEM_USER && {
          ownerUserId: context.userId,
        }),
      },
    });

    return entity ? DeltaEntity.toEgressType(entity) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Delta | null)[]> {
    const results = await this.deltaRepository.find({
      where: {
        deltaId: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          ownerUserId: context.userId,
        }),
      },
    });

    const map = new Map(results.map((entity) => [entity.deltaId, DeltaEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findDeltas(context: ServiceContext, options: FindDeltasOptions = {}): Promise<Delta[]> {
    const query = this.deltaRepository.createQueryBuilder('delta');

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('delta.ownerUserId = :userId', { userId: context.userId });
    }

    if (options.entityId) {
      query.andWhere('delta.entityId = :entityId', { entityId: options.entityId });
    }

    if (options.relationshipId) {
      query.andWhere('delta.relationshipId = :relationshipId', { relationshipId: options.relationshipId });
    }

    if (options.nodeType) {
      query.andWhere('delta.nodeType = :nodeType', { nodeType: options.nodeType });
    }

    if (options.changeType) {
      query.andWhere('delta.changeType = :changeType', { changeType: options.changeType });
    }

    if (options.unsummarizedOnly) {
      query.andWhere('delta.summaryId IS NULL');
    }

    if (options.since) {
      query.andWhere('delta.changedAt >= :since', { since: options.since });
    }

    if (options.until) {
      query.andWhere('delta.changedAt <= :until', { until: options.until });
    }

    query.orderBy('delta.changedAt', 'DESC');

    if (options.limit) {
      query.take(options.limit);
    }

    const results = await query.getMany();

    return results.map((entity) => DeltaEntity.toEgressType(entity));
  }

  async findUnsummarizedDeltas(context: ServiceContext, since?: Date, until?: Date): Promise<Delta[]> {
    return this.findDeltas(context, {
      unsummarizedOnly: true,
      since,
      until,
    });
  }

  async findDeltasForEntity(context: ServiceContext, entityId: string, limit?: number): Promise<Delta[]> {
    return this.findDeltas(context, {
      entityId,
      limit,
    });
  }

  async findEvolutionForEntity(
    context: ServiceContext,
    entityId: string,
    options: FindEntityEvolutionOptions = {},
  ): Promise<Delta[]> {
    const query = this.deltaRepository.createQueryBuilder('delta');

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('delta.ownerUserId = :userId', { userId: context.userId });
    }

    query.andWhere(
      new Brackets((qb) => {
        qb.where('delta.entityId = :entityId', { entityId })
          .orWhere('delta.fromEntityId = :entityId', { entityId })
          .orWhere('delta.toEntityId = :entityId', { entityId });
      }),
    );

    if (options.changeType) {
      query.andWhere('delta.changeType = :changeType', { changeType: options.changeType });
    }

    if (options.unsummarizedOnly) {
      query.andWhere('delta.summaryId IS NULL');
    }

    if (options.since) {
      query.andWhere('delta.changedAt >= :since', { since: options.since });
    }

    if (options.until) {
      query.andWhere('delta.changedAt <= :until', { until: options.until });
    }

    query.orderBy('delta.changedAt', 'DESC');

    if (options.limit) {
      query.take(options.limit);
    }

    const results = await query.getMany();

    return results.map((entity) => DeltaEntity.toEgressType(entity));
  }

  async findDeltasForRelationship(
    context: ServiceContext,
    relationshipId: string,
    limit?: number,
  ): Promise<Delta[]> {
    return this.findDeltas(context, {
      relationshipId,
      limit,
    });
  }

  async markAsSummarized(context: ServiceContext, data: UpdateDeltasSummaryDto): Promise<number> {
    const whereClause: Record<string, unknown> = {
      deltaId: In(data.deltaIds),
    };

    if (context.userId !== SYSTEM_USER) {
      whereClause.ownerUserId = context.userId;
    }

    const result = await this.deltaRepository.update(whereClause, {
      summaryId: data.summaryId,
    });

    return result.affected ?? 0;
  }

  async countUnsummarized(context: ServiceContext): Promise<number> {
    const query = this.deltaRepository.createQueryBuilder('delta').where('delta.summaryId IS NULL');

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('delta.ownerUserId = :userId', { userId: context.userId });
    }

    return query.getCount();
  }
}
