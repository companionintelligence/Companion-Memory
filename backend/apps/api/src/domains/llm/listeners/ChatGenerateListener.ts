import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Events, type EventPayloads, OnEvent } from '@ci/domains/events';

import {
  LLM_BACKGROUND_QUEUE,
  LLM_BACKGROUND_QUEUE_OPTIONS,
  LLM_QUEUE,
  LLM_QUEUE_OPTIONS,
} from '../constants';
import { ChatGenerateEvent, type ChatGeneratePayload } from '../events';
import { ChatTurnService } from '../services/ChatTurnService';

@Injectable()
export class ChatGenerateListener {
  constructor(
    private readonly chatTurnService: ChatTurnService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ChatGenerateListener.name);
  }

  @OnEvent(ChatGenerateEvent, { queue: LLM_QUEUE, queueOptions: LLM_QUEUE_OPTIONS })
  async handleGenerate(payload: ChatGeneratePayload) {
    await this.chatTurnService.execute(payload);
  }

  // Background: a title is filed, not watched. Off the interactive slot so a
  // queued title never sits between a person and their next turn.
  @OnEvent(Events.CHAT_SUMMARIZATION, {
    queue: LLM_BACKGROUND_QUEUE,
    queueOptions: LLM_BACKGROUND_QUEUE_OPTIONS,
  })
  async handleSummarization(payload: EventPayloads[Events.CHAT_SUMMARIZATION]) {
    try {
      await this.chatTurnService.summarizeThread(payload);
    } catch (error) {
      this.logger.error(error as Error, 'Chat thread title failed');
    }
  }
}
