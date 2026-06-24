import { Injectable } from '@nestjs/common';

import { EmbeddingGenerationService, embedSkipReason, shouldEmbedType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { AgentMemoryCreatedEvent, type AgentMemoryCreatedPayload } from '@ci/domains/agent/events';
import { OnEvent } from '@ci/domains/events';

import { EmbeddingService } from '../services/EmbeddingService';

/**
 * Indexes raw agent-memory fragments for the recall "naive RAG" channel.
 *
 * The entity listeners (Person, Concept, …) embed distilled node fields; this
 * embeds the fragment's RAW text under entity_type 'message', so that
 * RecallService's SearchService.searchMessages can vector-search the source
 * sentences the graph extraction distils away (the half of the hybrid that
 * recovers single-hop / temporal fidelity).
 *
 * Dense embedding only — the message channel does pure cosine search, so no
 * tsvector is written; this also keeps messages out of the keyword/entity
 * search paths (which exclude the 'message' type) rather than polluting them.
 */
@Injectable()
export class MessageSearchIndexListener {
  constructor(
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(MessageSearchIndexListener.name);
  }

  @OnEvent(AgentMemoryCreatedEvent, { queue: 'search-index' })
  async indexMessage(payload: AgentMemoryCreatedPayload) {
    this.logger.log('Adding agent-memory fragment to search index', {
      memoryId: payload.memoryId,
    });

    const content = payload.content?.trim();

    if (!content) {
      this.logger.log('Agent-memory fragment has no content, skipping embedding');

      return;
    }

    if (!shouldEmbedType('message')) {
      this.logger.log('Message type not in embed allowlist, skipping embedding', {
        memoryId: payload.memoryId,
      });

      return;
    }

    // Selective embedding: drop trivial / reaction fragments ("Loved an image",
    // bare "ok", emoji) that dominate chat imports and carry no search signal.
    const skipReason = embedSkipReason(content);

    if (skipReason != null) {
      this.logger.log('Skipping low-value agent-memory embedding', {
        memoryId: payload.memoryId,
        skipReason,
      });

      return;
    }

    const embedding = await this.embeddingGenerationService.generateEmbedding(content);

    await this.embeddingService.upsert(
      {
        userId: payload.userId,
      },
      {
        entityType: 'message',
        entityId: payload.memoryId,
        embedding,
      },
    );

    this.logger.log('Indexed agent-memory fragment for recall message channel', {
      memoryId: payload.memoryId,
    });
  }
}
