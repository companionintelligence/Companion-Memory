import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { ConnectionSyncJobEntity } from '../entities/ConnectionSyncJobEntity';
import {
  type ConnectionSyncJob,
  type CreateConnectionSyncJobDto,
  type SearchConnectionSyncJobDto,
  type UpdateConnectionSyncJobDto,
} from '../types';

@Injectable()
export class ConnectionSyncJobService {
  constructor(
    @InjectRepository(ConnectionSyncJobEntity)
    private readonly connectionSyncJobRepository: Repository<ConnectionSyncJobEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ConnectionSyncJobService.name);
  }

  async create(context: UserServiceContext, data: CreateConnectionSyncJobDto): Promise<ConnectionSyncJob> {
    const id = data.id ?? uuidv7();

    const SyncJob = this.connectionSyncJobRepository.create({
      id,
      userId: data.userId,
      connectionId: data.connectionId,
      jobId: data.jobId ?? null,
      endpointName: data.endpointName,
      status: data.status ?? 'pending',
      type: data.type,
      cursor: data.cursor || {},
      properties: data.properties ?? null,
    });

    const result = await this.connectionSyncJobRepository.save(SyncJob);

    return ConnectionSyncJobEntity.toEgressType(result);
  }

  async findAll(context: UserServiceContext): Promise<ConnectionSyncJob[]> {
    const result = await this.connectionSyncJobRepository.find({
      where: {
        userId: context.userId,
      },
      relations: ['user', 'connection'],
    });

    return result.map((entity) => ConnectionSyncJobEntity.toEgressType(entity));
  }

  async findById(context: ServiceContext, id: string): Promise<ConnectionSyncJob | null> {
    const result = await this.connectionSyncJobRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      relations: ['user', 'connection'],
    });

    return result ? ConnectionSyncJobEntity.toEgressType(result) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(ConnectionSyncJob | null)[]> {
    const result = await this.connectionSyncJobRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      relations: ['user', 'connection'],
    });

    const map = new Map(result.map((SyncJob) => [SyncJob.id, ConnectionSyncJobEntity.toEgressType(SyncJob)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findByConnectionId(
    context: ServiceContext,
    connectionId: string,
    endpointName?: string,
    type?: string,
  ): Promise<ConnectionSyncJob[]> {
    const result = await this.connectionSyncJobRepository.find({
      where: {
        connectionId,
        ...(endpointName != null && { endpointName }),
        ...(type != null && { type }),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      relations: ['user', 'connection'],
      order: {
        createdAt: 'DESC',
      },
    });

    return result.map((entity) => ConnectionSyncJobEntity.toEgressType(entity));
  }

  async findByJobId(context: ServiceContext, jobId: string): Promise<ConnectionSyncJob[]> {
    const result = await this.connectionSyncJobRepository.find({
      where: {
        jobId,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      relations: ['user', 'connection'],
      order: {
        createdAt: 'DESC',
      },
    });

    return result.map((entity) => ConnectionSyncJobEntity.toEgressType(entity));
  }

  async update(
    context: ServiceContext,
    id: string,
    data: UpdateConnectionSyncJobDto,
  ): Promise<ConnectionSyncJob | null> {
    const updateData: Partial<ConnectionSyncJobEntity> = {};

    if (data.jobId !== undefined) {
      updateData.jobId = data.jobId;
    }

    if (data.endpointName !== undefined) {
      updateData.endpointName = data.endpointName;
    }

    if (data.status !== undefined) {
      updateData.status = data.status;
    }

    if (data.data !== undefined) {
      updateData.data = data.data;
    }

    if (data.type !== undefined) {
      updateData.type = data.type;
    }

    if (data.cursor !== undefined) {
      updateData.cursor = data.cursor;
    }

    if (data.nextCursor !== undefined) {
      updateData.nextCursor = data.nextCursor;
    }

    if (data.properties !== undefined) {
      updateData.properties = data.properties;
    }

    if (data.error !== undefined) {
      updateData.error = data.error;
    }

    if (data.completedAt !== undefined) {
      updateData.completedAt = data.completedAt;
    }

    if (data.lastTransformed !== undefined) {
      updateData.lastTransformed = data.lastTransformed;
    }

    const SyncJob = await this.connectionSyncJobRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    if (SyncJob) {
      Object.assign(SyncJob, updateData);
      await this.connectionSyncJobRepository.save(SyncJob);
    } else {
      return null;
    }

    return this.findById(context, id);
  }

  async delete(context: ServiceContext, id: string): Promise<boolean> {
    const SyncJob = await this.connectionSyncJobRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    if (!SyncJob) {
      return false;
    }

    await this.connectionSyncJobRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        userId: context.userId,
      }),
    });

    return true;
  }

  async markAsCompleted(
    context: ServiceContext,
    id: string,
    status: 'success' | 'failed',
    error?: Record<string, unknown>,
  ): Promise<ConnectionSyncJob | null> {
    return this.update(context, id, {
      status,
      completedAt: new Date(),
      ...(error && { error }),
    });
  }

  async search(
    context: ServiceContext,
    query: SearchConnectionSyncJobDto,
  ): Promise<ConnectionSyncJobEntity[]> {
    let executable = this.connectionSyncJobRepository.createQueryBuilder('syncJob');

    if (context.userId !== SYSTEM_USER) {
      executable = executable.where('user_id = :userId', { userId: context.userId });
    }

    if (query.connectionId) {
      executable = executable.andWhere('connection_id = :connectionId', { connectionId: query.connectionId });
    }

    if (query.jobId) {
      executable = executable.andWhere('job_id = :jobId', { jobId: query.jobId });
    }

    if (query.endpointName) {
      executable = executable.andWhere('endpoint_name = :endpointName', { endpointName: query.endpointName });
    }

    if (query.status) {
      executable = executable.andWhere('status = :status', { status: query.status });
    }

    if (query.type) {
      executable = executable.andWhere('type = :type', { type: query.type });
    }

    if (query.properties) {
      for (const [key, val] of Object.entries(query.properties)) {
        executable = executable.andWhere(`item.properties->>'${key}' = :${key}`, { [key]: val });
      }
    }

    if (query.lastTransformed === null) {
      executable = executable.andWhere('last_transformed IS NULL');
    }

    if (query.lastTransformed != null) {
      executable = executable.andWhere('last_transformed >= :lastTransformed', {
        lastTransformed: query.lastTransformed,
      });
    }

    if (query.orderBy != null) {
      const [field, direction] = query.orderBy.split(':');
      if (direction !== 'DESC' && direction !== 'ASC') {
        this.logger.warn('Invalid orderBy direction in ConnectionSyncJobService.search', {
          query,
          direction,
        });
      } else {
        executable = executable.orderBy(field, direction);
      }
    }

    return executable.getMany();
  }
}
