import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Acknowledgement, Events, EventService, type EventPayloads, OnEvent } from '@ci/domains/events';

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
    private readonly eventService: EventService,
  ) {
    this.logger.setContext(ChatGenerateListener.name);
  }

  @OnEvent(ChatGenerateEvent, { queue: LLM_QUEUE, queueOptions: LLM_QUEUE_OPTIONS })
  async handleGenerate(payload: ChatGeneratePayload) {
    await this.chatTurnService.execute(payload);
  }

  // Background: a title is filed, not watched. Off the interactive slot so a
  // queued title never sits between a person and their next turn.
  //
  // A failure — the model busy or down, or a reply with nothing usable in it —
  // FAILS the job, so the queue retries it (3 retries, backed off from 10 s; see
  // LLM_BACKGROUND_QUEUE_OPTIONS). This used to swallow every error "so retries
  // are not burned on naming", back when titles shared the interactive slot and
  // a retried title held up a person's chat turn. Here that cost is gone (the
  // queue yields to chat), and swallowing meant a title that failed once was
  // never retried: nothing re-enqueues it until the thread's next turn.
  //
  // On the LAST attempt it settles for the person's own first words instead of
  // dead-lettering over an untitled thread. That needs the attempt count, which
  // only the acknowledgement's job id can look up — hence `autoAcknowledge:
  // false`, and the handler settling the job itself.
  @OnEvent(Events.CHAT_SUMMARIZATION, {
    queue: LLM_BACKGROUND_QUEUE,
    queueOptions: LLM_BACKGROUND_QUEUE_OPTIONS,
    autoAcknowledge: false,
  })
  async handleSummarization(payload: EventPayloads[Events.CHAT_SUMMARIZATION], ack: Acknowledgement) {
    try {
      await this.chatTurnService.summarizeThread(payload);
      ack.done();

      return;
    } catch (error) {
      if (!(await this.isLastAttempt(ack.jobId))) {
        ack.fail(error);

        return;
      }

      this.logger.warn('Chat thread title failed on its last attempt; using the first message instead', {
        threadId: payload.threadId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.chatTurnService.nameThreadFromFirstMessage(payload);
      ack.done();
    } catch (error) {
      ack.fail(error);
    }
  }

  /**
   * Whether failing this delivery would dead-letter it rather than retry it. No queue row (LocalEventService, or one
   * archived mid-run) means nothing will retry it either. When the lookup itself fails the answer is "no": let the
   * queue retry, and the next attempt decides.
   */
  private async isLastAttempt(jobId: string): Promise<boolean> {
    try {
      const job = await this.eventService.getJob(LLM_BACKGROUND_QUEUE, jobId);

      return job == null || job.retryCount >= job.retryLimit;
    } catch {
      return false;
    }
  }
}
