import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { AgentMemoryEntity, type AgentMemory } from '../entities/AgentMemoryEntity';

export interface CreateAgentMemoryDto {
  content: string;
  source?: string | null;
  title?: string | null;
  sessionId?: string | null;
}

@Injectable()
export class AgentMemoryService {
  constructor(
    @InjectRepository(AgentMemoryEntity)
    private readonly repository: Repository<AgentMemoryEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AgentMemoryService.name);
  }

  async create(context: UserServiceContext, data: CreateAgentMemoryDto): Promise<AgentMemory> {
    const source = data.source ?? null;
    const title = data.title ?? (source ? `[${source}]` : null);

    const entity = this.repository.create({
      id: uuidv7(),
      userId: context.userId,
      content: data.content,
      source,
      title,
      sessionId: data.sessionId ?? null,
    });

    const saved = await this.repository.save(entity);

    return AgentMemoryEntity.toEgressType(saved);
  }

  /**
   * Most recent fragments for the current user, newest first.
   * Used by the Agent Memory settings UI.
   */
  async findRecent(context: ServiceContext, options: { take?: number } = {}): Promise<AgentMemory[]> {
    const { take = 50 } = options;

    const rows = await this.repository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
      },
      order: { createdAt: 'DESC' },
      take,
    });

    return rows.map(AgentMemoryEntity.toEgressType);
  }

  /**
   * Fragments that have not yet been processed by the compaction cron.
   * Skips very recent writes so burst-written fragments settle before LLM extraction.
   * Pass SYSTEM_USER context to query across all users (cron use case).
   */
  async findUnprocessed(
    context: ServiceContext,
    options: { limit?: number; minAgeMinutes?: number } = {},
  ): Promise<AgentMemory[]> {
    const { limit = 50, minAgeMinutes = 2 } = options;
    const cutoff = new Date(Date.now() - minAgeMinutes * 60 * 1000);

    const rows = await this.repository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
        processedAt: IsNull(),
        createdAt: LessThan(cutoff),
      },
      order: { createdAt: 'ASC' },
      take: limit,
    });

    return rows.map(AgentMemoryEntity.toEgressType);
  }

  /**
   * Stamps processed_at on a batch of memory IDs.
   * Scoped to the context user unless SYSTEM_USER is passed.
   */
  async markProcessed(context: ServiceContext, ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.repository.update(
      {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
      },
      { processedAt: new Date() },
    );
  }
}
