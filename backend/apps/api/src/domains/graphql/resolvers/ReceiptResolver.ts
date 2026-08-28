import { UseGuards } from '@nestjs/common';
import { Args, ID, Int, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { type FindReceiptsFilter, type ReceiptExtractionState, ReceiptService } from '@ci/domains/memory';

import { ReceiptLineItemsLoader } from '../loaders/ItemAcquisitionLoader';
import { TagLoader } from '../loaders/TagLoader';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { ReceiptConnection } from '../types/ReceiptConnection';
import { ReceiptEdge } from '../types/ReceiptEdge';
import { ReceiptLineItemType } from '../types/ReceiptLineItemType';
import { ReceiptExtractionStateEnum, ReceiptType } from '../types/ReceiptType';

/**
 * Cursor codec for the receipt keyset, `(purchased_at DESC, receipt_id DESC)`.
 *
 * `purchasedAt` is nullable — a receipt whose date could not be extracted is
 * still a receipt — so the empty string stands for "no date" rather than the
 * cursor refusing to encode.
 */
function encodeReceiptCursor(cursor: { purchasedAt: Date | null; id: string }): string {
  return Buffer.from(`${cursor.purchasedAt?.toISOString() ?? ''}|${cursor.id}`).toString('base64');
}

function decodeReceiptCursor(
  raw: string | null | undefined,
): { purchasedAt: Date | null; id: string } | null {
  if (raw == null || raw === '') {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf-8');
  } catch {
    return null;
  }

  const separator = decoded.indexOf('|');
  if (separator < 0) {
    return null;
  }

  const rawDate = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (id === '') {
    return null;
  }

  if (rawDate === '') {
    return { purchasedAt: null, id };
  }

  const purchasedAt = new Date(rawDate);

  return Number.isNaN(purchasedAt.getTime()) ? null : { purchasedAt, id };
}

/**
 * Purchase evidence.
 *
 * A receipt is what JUSTIFIES an owned thing existing, and it outlives the
 * thing: the toaster goes to the tip, the receipt stays. That is why this is a
 * first-class record rather than a few fields on the item, and why the
 * `acquisition` field on {@link ItemType} points back here.
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ReceiptType)
export class ReceiptResolver {
  constructor(
    private readonly receiptService: ReceiptService,
    private readonly receiptLineItemsLoader: ReceiptLineItemsLoader,
    private readonly tagLoader: TagLoader,
  ) {}

  /** Receipts, newest purchase first, paged on the `(purchased_at, id)` keyset. */
  @Query(() => ReceiptConnection)
  async receipts(
    @Context() context: RequestContext,
    @Args('first', { type: () => Int, nullable: true }) first?: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
    @Args('merchantName', { type: () => String, nullable: true }) merchantName?: string,
    @Args('extractionState', { type: () => ReceiptExtractionStateEnum, nullable: true })
    extractionState?: ReceiptExtractionState,
    @Args('purchasedFrom', { type: () => Date, nullable: true }) purchasedFrom?: Date,
    @Args('purchasedTo', { type: () => Date, nullable: true }) purchasedTo?: Date,
  ): Promise<ReceiptConnection> {
    const serviceContext = toServiceContext(context);

    const cursor = decodeReceiptCursor(after);

    const filter: FindReceiptsFilter = {
      ...(merchantName != null ? { merchantName } : {}),
      ...(extractionState != null ? { extractionState } : {}),
      ...(purchasedFrom != null ? { purchasedFrom } : {}),
      ...(purchasedTo != null ? { purchasedTo } : {}),
      ...(first != null ? { limit: first } : {}),
      ...(cursor != null ? { afterPurchasedAt: cursor.purchasedAt, afterId: cursor.id } : {}),
    };

    const page = await this.receiptService.find(serviceContext, filter);

    const edges: ReceiptEdge[] = page.receipts.map((receipt) => ({
      node: ReceiptType.toType(receipt),
      cursor: encodeReceiptCursor({ purchasedAt: receipt.purchasedAt, id: receipt.id }),
    }));

    return {
      edges,
      pageInfo: {
        hasNextPage: page.hasMore,
        hasPreviousPage: cursor != null,
        startCursor: edges[0]?.cursor ?? null,
        endCursor: edges[edges.length - 1]?.cursor ?? null,
      },
      totalCount: edges.length,
    };
  }

  @Query(() => ReceiptType, { nullable: true })
  async receipt(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<ReceiptType | null> {
    const serviceContext = toServiceContext(context);

    const receipt = await this.receiptService.findById(serviceContext, GlobalUID.parse('receipt', gid));

    return receipt ? ReceiptType.toType(receipt) : null;
  }

  @ResolveField(() => [ReceiptLineItemType])
  async lineItems(
    @Context() context: RequestContext,
    @Parent() parent: ReceiptType,
  ): Promise<ReceiptLineItemType[]> {
    const serviceContext = toServiceContext(context);

    const lines = await this.receiptLineItemsLoader.load(serviceContext, parent.__source.id);

    return lines.map((line) => ReceiptLineItemType.toType(line));
  }

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: ReceiptType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'receipt',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}
