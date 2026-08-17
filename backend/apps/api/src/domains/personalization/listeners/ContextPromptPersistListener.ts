import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';

import {
  CONTEXT_PROMPT_PERSIST_QUEUE,
  ContextPromptPersistEvent,
  type ContextPromptPersistPayload,
} from '../events';
import { ContextPromptPersistService } from '../services/ContextPromptPersistService';

@Injectable()
export class ContextPromptPersistListener {
  constructor(
    private readonly persistService: ContextPromptPersistService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ContextPromptPersistListener.name);
  }

  @OnEvent(ContextPromptPersistEvent, { queue: CONTEXT_PROMPT_PERSIST_QUEUE })
  async handle(payload: ContextPromptPersistPayload): Promise<void> {
    this.logger.log('Persisting context prompt', payload);
    await this.persistService.persist(payload.userId, payload.promptId);
  }
}
