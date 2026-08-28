import { Injectable } from '@nestjs/common';

import { SYSTEM_USER, type ServiceContext } from '@ci/common/context';
import { EmbeddingGenerationService, shouldEmbedType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { ReceiptService } from '@ci/domains/memory';
import {
  ReceiptCreatedEvent,
  ReceiptRemovedEvent,
  ReceiptUpdatedEvent,
  type ReceiptCreatedPayload,
  type ReceiptDeletedPayload,
  type ReceiptUpdatedPayload,
} from '@ci/domains/memory/events';
import { receiptSearchDocument, receiptWeightedTexts } from '@ci/domains/search-ingress/searchTexts';

import { EmbeddingService } from '../services/EmbeddingService';
import { IndexSkipService } from '../services/IndexSkipService';
import { VectorService } from '../services/VectorService';
import { type WeightedText } from '../types';

/**
 * Indexes purchase evidence (`ci.receipts`) as the first-class `receipt` search
 * type.
 *
 * A receipt is indexed as itself rather than only through the things minted off
 * it: "the Home Depot receipt from March" is a question about the EVIDENCE, and
 * a receipt whose lines never minted anything (a meal, a service call) has no
 * object row to be found through at all.
 */
@Injectable()
export class ReceiptSearchIndexListener {
  constructor(
    private readonly receiptService: ReceiptService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly indexSkipService: IndexSkipService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ReceiptSearchIndexListener.name);
  }

  @OnEvent(ReceiptCreatedEvent, { queue: 'search-index' })
  async indexReceipt(payload: ReceiptCreatedPayload | ReceiptUpdatedPayload) {
    this.logger.log('Adding new receipt to search index', {
      receiptId: payload.receiptId,
    });

    await this.upsertReceipt(payload);
  }

  @OnEvent(ReceiptUpdatedEvent, { queue: 'search-index' })
  async updateReceipt(payload: ReceiptCreatedPayload | ReceiptUpdatedPayload) {
    this.logger.log('Updating receipt in search index', {
      receiptId: payload.receiptId,
    });

    await this.upsertReceipt(payload);
  }

  @OnEvent(ReceiptRemovedEvent, { queue: 'search-index' })
  async unindexReceipt(payload: ReceiptDeletedPayload) {
    this.logger.log('Removing receipt from search index', {
      receiptId: payload.receiptId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await this.embeddingService.remove(context, {
      entityType: 'receipt',
      entityId: payload.receiptId,
    });

    this.logger.log('Removed embedding for receipt');

    await this.vectorService.remove(context, {
      entityType: 'receipt',
      entityId: payload.receiptId,
    });

    this.logger.log('Removed tsvector for receipt');
  }

  private async upsertReceipt(payload: ReceiptCreatedPayload | ReceiptUpdatedPayload) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    // The lines ARE most of what a receipt says — "the receipt with the
    // dishwasher on it" is a line-item query — and the search index has no join
    // back to ci.receipt_line_items, so they are loaded and denormalized here.
    const withLines = await this.receiptService.findByIdWithLines(context, payload.receiptId);

    if (withLines == null) {
      this.logger.warn('Receipt not found, skipping indexing');

      return;
    }

    const { receipt, lines } = withLines;

    if (receipt.userId == null) {
      this.logger.warn('Receipt has no associated user, cannot index');

      return;
    }

    const fields = {
      ...receipt,
      lineDescriptions: lines.map((line) => line.description),
      lineBrands: lines.flatMap((line) =>
        [line.brand, line.modelNumber].filter((value): value is string => value != null),
      ),
    };

    const searchDocument = receiptSearchDocument(fields);

    if (!shouldEmbedType('receipt')) {
      this.logger.log('Receipt type not in embed allowlist, skipping embedding');
    } else if (searchDocument == null) {
      this.logger.log('Receipt has no search document, skipping embedding');

      // A receipt row can legitimately be blank while extraction is pending:
      // the header exists, the merchant and the OCR text do not yet. Record the
      // skip so the backfill sweep stops re-finding it every run — the
      // `extracted` update clears it again below.
      await this.indexSkipService.recordSkip({
        entityType: 'receipt',
        entityId: receipt.id,
        reason: 'empty',
      });
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument);

      await this.embeddingService.upsert(
        {
          userId: receipt.userId,
        },
        {
          entityType: 'receipt',
          entityId: receipt.id,
          embedding,
        },
      );

      await this.indexSkipService.clearSkip({
        entityType: 'receipt',
        entityId: receipt.id,
      });

      this.logger.log('Generated embedding for receipt');
    }

    const searchContent: WeightedText[] = receiptWeightedTexts(fields);

    if (searchContent.length === 0) {
      this.logger.log('Receipt has no search content, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: receipt.userId,
        },
        {
          entityType: 'receipt',
          entityId: receipt.id,
          searchableText: searchContent,
        },
      );

      this.logger.log('Generated tsvector for receipt');
    }
  }
}
