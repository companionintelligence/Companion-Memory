import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ItemService, type Item } from '@ci/domains/memory';

import { Loader } from './Loader';

@Injectable()
export class FileItemsLoader extends Loader<Item[]> {
  constructor(
    private readonly itemService: ItemService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(FileItemsLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    fileIds: readonly string[],
  ): Promise<readonly Item[][]> {
    return this.itemService.findByFileIds(context, [...fileIds]);
  }
}
