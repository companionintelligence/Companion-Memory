import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';

import { AgentMemoryEntity, type AgentMemory } from '../entities/AgentMemoryEntity';
import { AgentMemoryCreatedEvent, AgentMemoryRemovedEvent } from '../events';

export interface CreateAgentMemoryDto {
  /**
   * Caller-supplied primary key. Omitted (the `POST /memory/write` path) a
   * fresh uuid7 is minted. A producer that can be replayed — the chat-turn
   * cron, which re-reads a window it may already have written — passes a
   * deterministic id instead and checks {@link AgentMemoryService.findByIds}
   * first, so a crash between read and write replays into the same row rather
   * than duplicating the fragment.
   */
  id?: string;
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
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AgentMemoryService.name);
  }

  async create(context: UserServiceContext, data: CreateAgentMemoryDto): Promise<AgentMemory> {
    const source = data.source ?? null;
    const title = data.title ?? (source ? `[${source}]` : null);

    const entity = this.repository.create({
      id: data.id ?? uuidv7(),
      userId: context.userId,
      content: data.content,
      source,
      title,
      sessionId: data.sessionId ?? null,
    });

    const saved = await this.repository.save(entity);

    // Index the raw fragment for the recall message channel (naive-RAG half of
    // the hybrid). Async via the search-index queue; the content is carried in
    // the payload because fragments are immutable.
    await this.eventService.send(
      AgentMemoryCreatedEvent,
      {
        memoryId: saved.id,
        userId: saved.userId,
        content: saved.content,
      },
      { queue: 'search-index' },
    );

    return AgentMemoryEntity.toEgressType(saved);
  }

  /**
   * Deletes a single memory fragment (owner-scoped unless SYSTEM_USER is
   * passed) and emits {@link AgentMemoryRemovedEvent} so the search-index
   * listener can reap its 'message' embedding.
   *
   * Fragments have no DB-level FK into ci_search.embeddings, so the embedding
   * is cascade-deleted through this event rather than ON DELETE CASCADE — the
   * delete-side mirror of {@link AgentMemoryService.create}'s created-event.
   * Returns false (and emits nothing) when no matching row exists.
   */
  async remove(context: ServiceContext, memoryId: string): Promise<boolean> {
    const existing = await this.repository.findOne({
      where: {
        id: memoryId,
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
      },
    });

    if (existing == null) {
      return false;
    }

    await this.repository.delete({ id: existing.id });

    await this.eventService.send(
      AgentMemoryRemovedEvent,
      {
        memoryId: existing.id,
        userId: existing.userId,
      },
      { queue: 'search-index' },
    );

    return true;
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

  /**
   * Fetch a batch of memory fragments by id (owner-scoped). Used by the recall
   * message channel to turn message-embedding hits back into their raw text.
   */
  async findByIds(context: ServiceContext, ids: string[]): Promise<AgentMemory[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.repository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
      },
    });

    return rows.map(AgentMemoryEntity.toEgressType);
  }
}
