import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type ReceiptLineItem, ReceiptLineItemEntity } from '@ci/domains/memory';

import { Loader } from './Loader';

/**
 * Batches `ItemType.acquisition` — the receipt line a unit was minted from —
 * into one `ci.receipt_line_items` query.
 *
 * Keyed by LINE id, not receipt id. `ReceiptService.findLines` reads one
 * receipt at a time, and a page of twelve things bought on twelve separate
 * trips is twelve receipts: grouping by receipt would still be N+1 in the
 * common case. Scoped on `user_id` for the same reason the observation loader
 * is.
 */
@Injectable()
export class ItemAcquisitionLoader extends Loader<ReceiptLineItem | null> {
  constructor(
    @InjectRepository(ReceiptLineItemEntity)
    private readonly repository: Repository<ReceiptLineItemEntity>,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ItemAcquisitionLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    lineItemIds: readonly string[],
  ): Promise<readonly (ReceiptLineItem | null)[]> {
    if (lineItemIds.length === 0) {
      return [];
    }

    const rows = await this.repository.find({
      where: { userId: context.userId, id: In([...lineItemIds]) },
    });

    const byId = new Map(rows.map((row) => [row.id, row]));

    return lineItemIds.map((id) => byId.get(id) ?? null);
  }
}

/** Batches `ReceiptType.lineItems` into one query, in line order. */
@Injectable()
export class ReceiptLineItemsLoader extends Loader<ReceiptLineItem[]> {
  constructor(
    @InjectRepository(ReceiptLineItemEntity)
    private readonly repository: Repository<ReceiptLineItemEntity>,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ReceiptLineItemsLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    receiptIds: readonly string[],
  ): Promise<readonly ReceiptLineItem[][]> {
    if (receiptIds.length === 0) {
      return [];
    }

    const rows = await this.repository.find({
      where: { userId: context.userId, receiptId: In([...receiptIds]) },
      order: { lineNumber: 'ASC' },
    });

    const byReceipt = new Map<string, ReceiptLineItem[]>();

    for (const row of rows) {
      const list = byReceipt.get(row.receiptId);
      if (list == null) {
        byReceipt.set(row.receiptId, [row]);
      } else {
        list.push(row);
      }
    }

    return receiptIds.map((id) => byReceipt.get(id) ?? []);
  }
}
