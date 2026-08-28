import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type ObjectIdentifier, ObjectIdentifierService } from '@ci/domains/graph';

import { Loader } from './Loader';

/**
 * Batches `ItemType.identifiers` reads into one `ci.object_identifiers` query.
 *
 * Scoped to `object_instance` subjects: these are the codes that identify THIS
 * unit (a serial, an IMEI, a VIN), not the ones that identify its kind. A GTIN
 * belongs to the product model and is loaded by {@link ProductIdentifierLoader}
 * — conflating the two is exactly the mistake the subject-polymorphic claim
 * table exists to prevent.
 */
@Injectable()
export class ItemIdentifierLoader extends Loader<ObjectIdentifier[]> {
  constructor(
    private readonly objectIdentifierService: ObjectIdentifierService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ItemIdentifierLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    itemIds: readonly string[],
  ): Promise<readonly ObjectIdentifier[][]> {
    const bySubject = await this.objectIdentifierService.listForSubjects(context.userId, 'object_instance', [
      ...itemIds,
    ]);

    return itemIds.map((id) => bySubject.get(id) ?? []);
  }
}

/** The product-model half of the same read. See {@link ItemIdentifierLoader}. */
@Injectable()
export class ProductIdentifierLoader extends Loader<ObjectIdentifier[]> {
  constructor(
    private readonly objectIdentifierService: ObjectIdentifierService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ProductIdentifierLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    productIds: readonly string[],
  ): Promise<readonly ObjectIdentifier[][]> {
    const bySubject = await this.objectIdentifierService.listForSubjects(context.userId, 'product_model', [
      ...productIds,
    ]);

    return productIds.map((id) => bySubject.get(id) ?? []);
  }
}
