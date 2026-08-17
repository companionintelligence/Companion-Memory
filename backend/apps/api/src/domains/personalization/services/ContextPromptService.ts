import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';

import type {
  ContextPromptSource,
  ContextPromptStatus,
  ContextPromptWritePlan,
  SelectorSpec,
} from '../contextPrompt.types';
import { ContextPromptEntity, type ContextPrompt } from '../entities/ContextPromptEntity';
import { CONTEXT_PROMPT_PERSIST_QUEUE, ContextPromptPersistEvent } from '../events';

@Injectable()
export class ContextPromptService {
  constructor(
    @InjectRepository(ContextPromptEntity)
    private readonly repository: Repository<ContextPromptEntity>,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ContextPromptService.name);
  }

  async hasPending(userId: string): Promise<boolean> {
    const count = await this.repository.count({ where: { userId, status: 'pending' } });

    return count > 0;
  }

  async countPending(userId: string): Promise<number> {
    return this.repository.count({ where: { userId, status: 'pending' } });
  }

  async getPending(userId: string): Promise<ContextPrompt | null> {
    const row = await this.repository.findOne({
      where: { userId, status: 'pending' },
      order: { createdAt: 'ASC' },
    });

    return row ?? null;
  }

  async createPending(
    context: UserServiceContext,
    input: { selector: SelectorSpec; source: ContextPromptSource },
  ): Promise<ContextPrompt | null> {
    const userId = context.userId!;
    if (await this.hasPending(userId)) {
      return this.getPending(userId);
    }

    const entity = this.repository.create({
      id: uuidv7(),
      userId,
      status: 'pending',
      selector: input.selector,
      source: input.source,
      response: null,
      writePlan: null,
    });

    return this.repository.save(entity);
  }

  async respond(
    context: UserServiceContext,
    promptId: string,
    response: unknown,
  ): Promise<ContextPrompt | null> {
    const userId = context.userId!;
    const row = await this.repository.findOne({ where: { id: promptId, userId, status: 'pending' } });
    if (!row) {
      return null;
    }

    row.response = response;
    row.status = 'answered';
    const saved = await this.repository.save(row);

    await this.eventService.send(
      ContextPromptPersistEvent,
      { userId, promptId: saved.id },
      { queue: CONTEXT_PROMPT_PERSIST_QUEUE, singletonKey: `context-prompt-persist:${saved.id}` },
    );

    return saved;
  }

  async skip(context: UserServiceContext, promptId: string): Promise<ContextPrompt | null> {
    const userId = context.userId!;
    const row = await this.repository.findOne({ where: { id: promptId, userId, status: 'pending' } });
    if (!row) {
      return null;
    }

    row.status = 'skipped';

    return this.repository.save(row);
  }

  async markWritten(promptId: string, writePlan: ContextPromptWritePlan): Promise<void> {
    await this.repository.update(
      { id: promptId },
      {
        status: 'written' as ContextPromptStatus,
        // TypeORM QueryDeepPartialEntity rejects Record<string, unknown> JSONB
        writePlan: writePlan as never,
      },
    );
  }

  async markFailed(promptId: string, writePlan?: ContextPromptWritePlan | null): Promise<void> {
    await this.repository.update(
      { id: promptId },
      {
        status: 'failed' as ContextPromptStatus,
        writePlan: (writePlan ?? null) as never,
      },
    );
  }

  async findById(promptId: string, userId: string): Promise<ContextPrompt | null> {
    return this.repository.findOne({ where: { id: promptId, userId } });
  }
}
