import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService, embedSkipReason, shouldEmbedType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { type Message, MessageService, type Thread, ThreadService } from '@ci/domains/conversations';
import {
  MessageCreatedEvent,
  ThreadCreatedEvent,
  ThreadRemovedEvent,
  ThreadUpdatedEvent,
  type MessageCreatedPayload,
  type ThreadCreatedPayload,
  type ThreadRemovedPayload,
  type ThreadUpdatedPayload,
} from '@ci/domains/conversations/events';
import { OnEvent } from '@ci/domains/events';
import { EmbeddingService } from '@ci/domains/search-ingress/services/EmbeddingService';
import { VectorService } from '@ci/domains/search-ingress/services/VectorService';
import { type WeightedText } from '@ci/domains/search-ingress/types';

@Injectable()
export class ThreadSearchIndexListener {
  constructor(
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly messageService: MessageService,
    private readonly threadService: ThreadService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ThreadSearchIndexListener.name);
  }

  @OnEvent(ThreadCreatedEvent, { queue: 'search-index' })
  async indexThread(payload: ThreadCreatedPayload | ThreadUpdatedPayload) {
    this.logger.log('Adding new thread to search index', {
      threadId: payload.threadId,
    });

    await this.upsertThread(payload);
  }

  @OnEvent(ThreadUpdatedEvent, { queue: 'search-index' })
  async updateThread(payload: ThreadCreatedPayload | ThreadUpdatedPayload) {
    this.logger.log('Updating thread in search index', {
      threadId: payload.threadId,
    });

    await this.upsertThread(payload);
  }

  @OnEvent(MessageCreatedEvent, { queue: 'search-index' })
  async updateThreadOnMessageCreated(payload: MessageCreatedPayload) {
    this.logger.log('Updating thread in search index', {
      threadId: payload.messageId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const message = await this.messageService.findById(context, payload.messageId);

    if (!message?.threadId) {
      this.logger.log('Message has no associated thread, skipping indexing');

      return;
    }

    await this.upsertThread({
      threadId: message?.threadId,
    });
  }

  @OnEvent(ThreadRemovedEvent, { queue: 'search-index' })
  async unindexThread(payload: ThreadRemovedPayload) {
    this.logger.log('Removing thread in search index', {
      threadId: payload.threadId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await this.embeddingService.remove(context, {
      entityType: 'thread',
      entityId: payload.threadId,
    });

    this.logger.log('Removed embedding for thread');

    await this.vectorService.remove(context, {
      entityType: 'thread',
      entityId: payload.threadId,
    });

    this.logger.log('Removed tsvector for thread');
  }

  private async upsertThread(payload: ThreadCreatedPayload | ThreadUpdatedPayload) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const thread = await this.threadService.findById(context, payload.threadId);

    if (thread == null) {
      this.logger.warn('Thread not found, skipping indexing');

      return;
    }

    if (thread.user?.id == null) {
      this.logger.warn('Thread has no associated user, cannot index');

      return;
    }

    const messages = await this.messageService.findByThreadId(context, payload.threadId);

    const searchDocument = this.getSearchDocument(thread, messages);
    const skipReason = searchDocument == null ? 'empty' : embedSkipReason(searchDocument);

    if (!shouldEmbedType('thread')) {
      this.logger.log('Thread type not in embed allowlist, skipping embedding');
    } else if (skipReason != null) {
      this.logger.log('Skipping low-value thread embedding', {
        threadId: thread.id,
        skipReason,
      });
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument!);

      await this.embeddingService.upsert(
        {
          userId: thread.user.id,
        },
        {
          entityType: 'thread',
          entityId: thread.id,
          embedding,
        },
      );

      this.logger.log('Generated embedding for thread');
    }

    const searchThread = this.getSearchThread(thread, messages);

    if (searchThread.length === 0) {
      this.logger.log('Thread has no search thread, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: thread.user.id,
        },
        {
          entityType: 'thread',
          entityId: thread.id,
          searchableText: searchThread,
        },
      );

      this.logger.log('Generated tsvector for thread');
    }
  }

  private getSearchThread(thread: Thread, messages: Message[]): WeightedText[] {
    const parts: WeightedText[] = [];

    if (thread.name) {
      parts.push({ text: thread.name, weight: 10 });
    }

    if (thread.description) {
      parts.push({ text: thread.description, weight: 5 });
    }

    for (const message of messages) {
      if (message.content) {
        parts.push({ text: message.content, weight: 3 });
      }
    }

    return parts;
  }

  private getSearchDocument(thread: Thread, messages: Message[]): string | null {
    const parts = new Set<string>();

    const push = (value: unknown) => {
      if (typeof value !== 'string') {
        return;
      }

      const normalized = value.trim();

      if (normalized.length === 0) {
        return;
      }

      parts.add(normalized);
    };

    push(thread.name ?? null);
    push(thread.description ?? null);

    for (const message of messages) {
      push(message.content ?? null);
    }

    const result = Array.from(parts).join(' ');

    return result.length > 0 ? result : null;
  }
}
