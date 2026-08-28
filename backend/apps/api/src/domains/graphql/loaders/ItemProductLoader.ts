import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type ProductModel, ProductModelService } from '@ci/domains/memory';

import { Loader } from './Loader';

/**
 * Batches `ItemType.product` reads into one `ci.product_models` query.
 *
 * Keyed by product id rather than item id: a shelf of twelve identical mugs is
 * twelve items pointing at ONE model, and DataLoader's per-key cache collapses
 * that to a single row in the batch.
 */
@Injectable()
export class ItemProductLoader extends Loader<ProductModel | null> {
  constructor(
    private readonly productModelService: ProductModelService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ItemProductLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    productIds: readonly string[],
  ): Promise<readonly (ProductModel | null)[]> {
    return this.productModelService.findByIds(context, [...productIds]);
  }
}
